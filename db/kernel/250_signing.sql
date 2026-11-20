-- 通行金鑰簽的是「瀏覽器自己從畫面算出來的挑戰值」（裁決 D68；紅隊第二輪 高-2）。
--
-- 根因：金鑰簽的是資料庫發的隨機值，這個值代表什麼只存在資料庫；畫面與程式都由後端送出，使用者無從確認自己簽了什麼。
-- 被入侵的後端可以在使用者按「駁回」時改發「核准」的挑戰值，或把下一次按的金鑰挪去核准角色變更。
--
-- 這一版：
--   1. 挑戰值＝SHA-256（標準化 JSON {purpose, ref, content_sha256, decision, nonce}）。用途、單號（或變更編號）、
--      內容雜湊、決定種類由瀏覽器從畫面上顯示的內容自己算；資料庫只給一次性亂數（nonce），驗章時用自己的紀錄重算比對。
--      後端換掉任何一項，簽章就對不上（SIGNED_CONTENT_MISMATCH）。所有用途共用這一個公式與一個驗證入口
--      （signature_verify），用途字串互不相同，所以一種用途的簽章不能拿去用在另一種。
--   2. 驗章的唯一入口另外檢查：金鑰已經生效（usable_from，登記後有冷卻期，見 260）、簽章是 low-s（裁決 D71）。
--   3. 申請單的決定改用這一套：challenge_issue 只回 nonce 與要顯示的輸入，不回可以直接拿去簽的值。
-- 瀏覽器端的同一套算法在 web/lib/signing.js；db/tests/kernel/81-signing.test.mjs 檢查兩邊算出相同的位元組。

insert into sgn.error_catalog (code, message, http_status) values
    ('SIGNED_CONTENT_MISMATCH', '通行金鑰簽的內容和資料庫的紀錄不符（畫面顯示的內容可能被竄改），請重新整理後再確認一次', 422),
    ('PASSKEY_NOT_ACTIVE', '這把通行金鑰還沒有生效（等待核准或仍在冷卻期內）', 403);

alter table sgn.auth_challenge
    drop constraint auth_challenge_purpose_check,
    add constraint auth_challenge_purpose_check check (purpose in (
        'session', 'passkey_register', 'decision', 'role_change',
        'case.decision', 'role_change.propose', 'role_change.decision', 'passkey.enrollment'
    ));

-- 金鑰從什麼時候起可以簽章。這一版之前登記的金鑰維持原狀（登記時就生效）。
alter table sgn.passkey_credential
    add column usable_from timestamptz;

update sgn.passkey_credential set usable_from = registered_at;

alter table sgn.passkey_credential
    alter column usable_from set not null;

-- 決定證明記下金鑰實際簽的值（由 nonce 與紀錄重算），稽核重驗時比對 clientDataJSON。
alter table sgn.decision_proof
    add column signed_challenge bytea;

-- ── 挑戰值的公式（唯一來源；瀏覽器端見 web/lib/signing.js）──

create function sgn_internal.signing_challenge(
    p_purpose text,
    p_ref text,
    p_content jsonb,
    p_decision text,
    p_nonce bytea
)
returns bytea
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.jcs_sha256(jsonb_build_object(
        'purpose', p_purpose,
        'ref', p_ref,
        'content_sha256', encode(sgn_internal.jcs_sha256(p_content), 'hex'),
        'decision', p_decision,
        'nonce', sgn_internal.b64url_encode(p_nonce)
    ))
$$;

-- WebAuthn assertion 驗證（同 30_identity.sql 的簽章）。和前一版的差別：挑戰值不符有自己的代碼、只收 low-s、
-- 金鑰必須已經生效。回傳簽章者（憑證的擁有人）。
create or replace function sgn_internal.webauthn_verify(
    p_expected_challenge bytea,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cred sgn.passkey_credential;
    v_auth bytea := sgn_internal.b64url_decode(p_authenticator_data);
    v_client_raw bytea := sgn_internal.b64url_decode(p_client_data_json);
    v_signature bytea := sgn_internal.b64url_decode(p_signature);
    v_client jsonb;
    v_count bigint;
begin
    select * into v_cred
    from sgn.passkey_credential
    where credential_id = sgn_internal.b64url_decode(p_credential_id)
    for update;
    if v_cred.credential_id is null then
        perform sgn_internal.raise_error('PASSKEY_UNKNOWN');
    end if;
    if v_cred.usable_from > sgn_internal.now() then
        perform sgn_internal.raise_error('PASSKEY_NOT_ACTIVE', 'usable from ' || v_cred.usable_from::text);
    end if;
    begin
        v_client := convert_from(v_client_raw, 'UTF8')::jsonb;
    exception
        when others then
            perform sgn_internal.raise_error('PASSKEY_INVALID', 'clientDataJSON');
    end;
    if length(v_auth) < 37
       or v_client ->> 'type' is distinct from 'webauthn.get'
       or v_client ->> 'origin' is distinct from sgn_internal.setting_text('webauthn.origin')
       or substring(v_auth from 1 for 32) <> sha256(convert_to(sgn_internal.setting_text('webauthn.rp_id'), 'UTF8')) then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'client data or rp id');
    end if;
    if v_client ->> 'challenge' is distinct from sgn_internal.b64url_encode(p_expected_challenge) then
        perform sgn_internal.raise_error('SIGNED_CONTENT_MISMATCH');
    end if;
    -- 0x01 使用者在場、0x04 使用者驗證（生物辨識或 PIN）。決定類一律要求兩者。
    if get_byte(v_auth, 32) & 5 <> 5 then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'flags');
    end if;
    -- 只收 low-s（D71）：同一個決定的證明只有一種位元表示。瀏覽器送出前把 s 換成 min(s, n−s)。
    if coalesce((sgn_internal.der_ecdsa_rs(v_signature)).s * 2 > sgn_internal.p256_n(), true) then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'high-s or malformed signature');
    end if;
    if not sgn_internal.es256_verify(v_auth || sha256(v_client_raw), v_signature, v_cred.public_key) then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'signature');
    end if;
    v_count := sgn_internal.bytes_to_int(substring(v_auth from 34 for 4));
    if (v_count <> 0 or v_cred.sign_count <> 0) and v_count <= v_cred.sign_count then
        perform sgn_internal.raise_error('PASSKEY_COUNTER');
    end if;
    update sgn.passkey_credential set sign_count = v_count where credential_id = v_cred.credential_id;
    return v_cred.person_id;
end;
$$;

-- 驗章的唯一入口：用資料庫自己的紀錄（p_ref、p_content、p_decision）與挑戰值紀錄裡的 nonce 重算挑戰值再驗。
-- 回傳簽章者。「挑戰值只能由發給的那個人使用」由各用途在授權之後以 challenge_owner_check 檢查
-- （先授權，沒有資格的人得到的是資格不符，而不是挑戰值不符）。
create function sgn_internal.signature_verify(
    p_challenge sgn.auth_challenge,
    p_ref text,
    p_content jsonb,
    p_decision text,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns uuid
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.webauthn_verify(
        sgn_internal.signing_challenge(p_challenge.purpose, p_ref, p_content, p_decision, p_challenge.challenge),
        p_credential_id,
        p_authenticator_data,
        p_client_data_json,
        p_signature
    )
$$;

-- 挑戰值發給誰，就只能由誰的金鑰使用（防止把別人的挑戰值拿來簽）。
create function sgn_internal.challenge_owner_check(p_challenge sgn.auth_challenge, p_signer uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if p_signer is distinct from p_challenge.person_id then
        perform sgn_internal.raise_error('CHALLENGE_PURPOSE', 'challenge was issued to another person');
    end if;
end;
$$;

-- ── 申請單的決定 ──

-- 決定的輸入中要簽的部分（瀏覽器顯示並自己算雜湊的那些）：原因、縮小後那一版的雜湊、執行內容的雜湊。
create function sgn_internal.decision_signed_content(p_binding jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'version_sha256', p_binding ->> 'version_sha256',
        'input', case
            when p_binding ->> 'decision' in ('return', 'reject', 'recall')
                then jsonb_build_object('reason', p_binding #>> '{input,reason}')
            when p_binding ->> 'decision' = 'approve_reduced'
                then jsonb_build_object('version_sha256', p_binding #>> '{input,version_sha256}')
            when p_binding ->> 'decision' = 'fulfil'
                then jsonb_build_object('payload_sha256', p_binding #>> '{input,payload_sha256}')
            else '{}'::jsonb
        end
    )
$$;

-- 這個決定的挑戰值（由紀錄重算）。
create function sgn_internal.decision_signed_challenge(p_challenge sgn.auth_challenge)
returns bytea
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.signing_challenge(
        p_challenge.purpose,
        p_challenge.binding ->> 'case_no',
        sgn_internal.decision_signed_content(p_challenge.binding),
        p_challenge.binding ->> 'decision',
        p_challenge.challenge
    )
$$;

-- 發決定的一次性亂數（同 170_decide.sql 的簽章）。檢查與整理輸入照舊；回傳 nonce 與整理過的輸入（縮小後的內容要給簽核人看），
-- 不回傳可以直接簽的值。
create or replace function api.challenge_issue(p_session text, p_case_id uuid, p_decision text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_input jsonb;
    v_binding jsonb;
    v_row sgn.auth_challenge;
begin
    if not exists (select 1 from sgn.action as a where a.action = p_decision and a.needs_proof) then
        perform sgn_internal.raise_error('ACTION_UNKNOWN', p_decision);
    end if;
    perform sgn_internal.authorize(v_person_id, p_decision, v_case);
    v_input := sgn_internal.decision_input(v_case, p_decision, p_input);
    select jsonb_build_object(
        'case_id', v_case.id,
        'case_no', v_case.case_no::text,
        'version', v.version,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex'),
        'decision', p_decision,
        'input', v_input,
        'input_sha256', encode(sgn_internal.jcs_sha256(v_input), 'hex')
    ) into v_binding
    from sgn.case_version as v
    where v.case_id = v_case.id and v.version = v_case.current_version;
    v_row := sgn_internal.challenge_new('case.decision', v_binding, v_person_id);
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'nonce', sgn_internal.b64url_encode(v_row.challenge),
        'input', v_input,
        'expires_at', v_row.expires_at
    );
end;
$$;

comment on function api.challenge_issue(text, uuid, text, jsonb) is
    '使用者動作「核准、縮小後核准、退回、駁回、撤回、執行完成」的第一步：檢查並整理決定的輸入（原因、縮小後的內容），'
    '發一次性亂數。瀏覽器用它和畫面上的單號、內容版本、決定種類、輸入自己算出挑戰值再簽（web/lib/signing.js）；'
    '這裡不回傳可以直接簽的值。第二步是 case_decide_passkey。'
    '呼叫者：sgn_app。規則：K-DECISION-PROOF、K-VERSION-BOUND、K-DECISION-ELIGIBLE、K-SOD-APPLICANT、K-CHANGE-REDUCE、K-RETURN、K-REJECT、K-RECALL、K-FULFIL';

-- 決定的前半（同 170_decide.sql 的簽章）：用途改為 case.decision。
create or replace function sgn_internal.decision_prepare(p_challenge_id uuid, p_decision text)
returns sgn.auth_challenge
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_check(p_challenge_id, 'case.decision');
    v_case sgn.request_case := sgn_internal.case_lock((v_challenge.binding ->> 'case_id')::uuid);
    v_current sgn.case_version;
begin
    if v_challenge.binding ->> 'decision' is distinct from p_decision then
        perform sgn_internal.raise_error('DECISION_MISMATCH');
    end if;
    select * into v_current from sgn.case_version where case_id = v_case.id and version = v_case.current_version;
    if v_case.current_version <> (v_challenge.binding ->> 'version')::int
       or encode(v_current.content_sha256, 'hex') <> v_challenge.binding ->> 'content_sha256'
       or encode(v_current.version_sha256, 'hex') is distinct from v_challenge.binding ->> 'version_sha256' then
        perform sgn_internal.raise_error('CONTENT_CHANGED');
    end if;
    return v_challenge;
end;
$$;

-- 決定的後半（同 170_decide.sql 的簽章）。和前一版的差別：依挑戰值自己的用途消耗、記下金鑰實際簽的值、
-- 事後通知決定者本人（獨立管道，D68 配套 3 的通知部分）。
create or replace function sgn_internal.decision_commit(
    p_challenge sgn.auth_challenge,
    p_actor uuid,
    p_proof_kind text,
    p_proof_raw jsonb
)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock((p_challenge.binding ->> 'case_id')::uuid);
    v_decision text := p_challenge.binding ->> 'decision';
    v_proof_sha256 bytea := sgn_internal.jcs_sha256(p_proof_raw);
    v_signed bytea := sgn_internal.decision_signed_challenge(p_challenge);
begin
    perform sgn_internal.authorize(p_actor, v_decision, v_case);
    perform sgn_internal.challenge_owner_check(p_challenge, p_actor);
    perform sgn_internal.challenge_consume(p_challenge.id, p_challenge.purpose);
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge)
    values (p_challenge.id, p_proof_kind, p_proof_raw, v_proof_sha256, sgn_internal.now(), v_signed);
    perform sgn_internal.audit_append(
        'case.' || v_decision,
        v_case.id,
        p_actor,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', p_challenge.binding ->> 'content_sha256',
            'version_sha256', p_challenge.binding ->> 'version_sha256',
            'input_sha256', p_challenge.binding ->> 'input_sha256',
            'challenge', sgn_internal.b64url_encode(v_signed),
            'nonce', sgn_internal.b64url_encode(p_challenge.challenge),
            'signed', jsonb_build_object(
                'purpose', p_challenge.purpose,
                'ref', p_challenge.binding ->> 'case_no',
                'content', sgn_internal.decision_signed_content(p_challenge.binding),
                'decision', v_decision
            ),
            'proof_kind', p_proof_kind,
            'proof_sha256', encode(v_proof_sha256, 'hex'),
            'open_exceptions', (
                select coalesce(jsonb_agg(x.id order by x.id), '[]'::jsonb)
                from sgn.exception_record as x
                where x.case_id = v_case.id
            ),
            'rules', jsonb_build_array('K-DECISION-PROOF', 'K-VERSION-BOUND', 'K-DECISION-ELIGIBLE')
        )
    );
    perform sgn_internal.notify(
        'decision.recorded', array[p_actor], v_case.id,
        jsonb_build_object('case_no', v_case.case_no, 'decision', v_decision)
    );
    perform sgn_internal.decision_apply(v_case, p_actor, p_challenge);
    return sgn_internal.case_summary(v_case.id, p_actor);
end;
$$;

create or replace function api.case_decide_passkey(
    p_challenge_id uuid,
    p_decision text,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.decision_prepare(p_challenge_id, p_decision);
begin
    return sgn_internal.decision_commit(
        v_challenge,
        sgn_internal.signature_verify(
            v_challenge,
            v_challenge.binding ->> 'case_no',
            sgn_internal.decision_signed_content(v_challenge.binding),
            p_decision,
            p_credential_id,
            p_authenticator_data,
            p_client_data_json,
            p_signature
        ),
        'passkey',
        jsonb_build_object(
            'credential_id', p_credential_id,
            'authenticator_data', p_authenticator_data,
            'client_data_json', p_client_data_json,
            'signature', p_signature
        )
    );
end;
$$;

comment on function api.case_decide_passkey(uuid, text, text, text, text, text) is
    '使用者動作「核准、縮小後核准、退回、駁回、撤回、執行完成」的第二步：以通行金鑰的 assertion 做決定。'
    '資料庫用自己的紀錄重算挑戰值（用途、單號、內容版本雜湊、決定種類、輸入、nonce）比對簽章，誰做的決定從憑證得出，'
    '不接受後端傳入的身分。回傳單張摘要。呼叫者：sgn_app。規則：K-DECISION-PROOF、K-DECISION-ELIGIBLE、K-SOD-APPLICANT、K-VERSION-BOUND';

-- 稽核證據頁的證明（同 70_audit.sql 的簽章）：challenge 是金鑰實際簽的值。
create or replace function sgn_internal.audit_case_proofs(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', d.kind,
        'challenge', sgn_internal.b64url_encode(coalesce(d.signed_challenge, ch.challenge)),
        'raw', d.raw,
        'raw_sha256', encode(d.raw_sha256, 'hex'),
        'public_key', sgn_internal.b64url_encode(k.public_key)
    ) order by d.created_at), '[]'::jsonb)
    from sgn.decision_proof as d
    join sgn.auth_challenge as ch on ch.id = d.challenge_id
    left join sgn.passkey_credential as k on k.credential_id = sgn_internal.b64url_decode(d.raw ->> 'credential_id')
    where ch.binding ->> 'case_id' = p_case_id::text
$$;

insert into sgn.notification_template (event_code, subject, body) values
    ('decision.recorded', '你剛剛對 {{case_no}} 做了決定', '系統記下你對 {{case_no}} 的決定：{{decision}}。如果不是你本人操作，請立刻通知資安。');

select sgn_internal.register_rule(
    'K-DECISION-PROOF',
    '每個決定類動作都要附上資料庫驗得過的一次性通行金鑰簽章；金鑰簽的挑戰值由瀏覽器從畫面上的用途、單號、內容版本雜湊、'
    '決定種類、輸入與資料庫給的 nonce 自己算出，資料庫用自己的紀錄重算比對（D68）；證明的種類由參數 decision.allowed_proof_kinds 限制；'
    '金鑰必須已生效、簽章只收 low-s',
    null,
    'partial',
    '決定後「下一關行動前可撤回」沒做（只做了事後通知決定者本人）'
);
