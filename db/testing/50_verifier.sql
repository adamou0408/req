-- 測試專用（不進發行包）：架構 (c)「獨立驗證服務」的資料庫端，只為了和 (a) 比較而保留。
-- 探針的結論是不採 (c)（docs/handoff/probe-db-findings.md §2.5）：拿到 sgn_test_verifier 的人能不經簽章冒用任何人。
-- 只裝在資料庫測試用的資料庫；端對端與正式環境沒有這個 schema 與角色的權限。
-- :"verifier" 由 db/build.sh 以 psql -v 傳入。

create schema api_verified;

-- (c) 獨立驗證服務。資料庫相信「這個憑證簽了這個挑戰值」，但人仍由資料庫從憑證對出，
-- 挑戰值的綁定、是否已用、簽核人資格仍由資料庫檢查。
create function api_verified.challenge_get(
    p_challenge_id uuid,
    out challenge text,
    out binding jsonb,
    out used boolean,
    out content_changed boolean
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select
        sgn_internal.b64url_encode(sgn_internal.decision_signed_challenge(c)),
        c.binding,
        c.consumed_at is not null,
        r.current_version is distinct from (c.binding ->> 'version')::int
    from sgn.auth_challenge c
    left join sgn.request_case r on r.id = (c.binding ->> 'case_id')::uuid
    where c.id = p_challenge_id and c.purpose = 'case.decision'
$$;

comment on function api_verified.challenge_get(uuid) is
    '驗證服務取金鑰應該簽的挑戰值（由紀錄重算，與 (a) 同一個公式），用來比對 clientDataJSON；used：已經用掉；'
    'content_changed：單已經換了版本（顯示摘要會跟著單變，重放與舊版本要先以這兩項擋下）。呼叫者：sgn_test_verifier。';

create function api_verified.passkey_get(p_credential_id text, out public_key text, out sign_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select encode(k.public_key, 'base64'), k.sign_count
    from sgn.passkey_credential k
    where k.credential_id = sgn_internal.b64url_decode(p_credential_id)
$$;

comment on function api_verified.passkey_get(text) is
    '驗證服務取通行金鑰的公鑰（未壓縮點，base64）與計數器。呼叫者：sgn_test_verifier。';

create function api_verified.case_decide_passkey(
    p_challenge_id uuid,
    p_decision text,
    p_credential_id text,
    p_sign_count bigint,
    p_proof jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.decision_prepare(p_challenge_id, p_decision);
    v_cred sgn.passkey_credential;
begin
    select * into v_cred
    from sgn.passkey_credential
    where credential_id = sgn_internal.b64url_decode(p_credential_id)
    for update;
    if v_cred.credential_id is null then
        perform sgn_internal.raise_error('PASSKEY_UNKNOWN');
    end if;
    if (p_sign_count <> 0 or v_cred.sign_count <> 0) and p_sign_count <= v_cred.sign_count then
        perform sgn_internal.raise_error('PASSKEY_COUNTER');
    end if;
    update sgn.passkey_credential set sign_count = p_sign_count where credential_id = v_cred.credential_id;
    return sgn_internal.decision_commit(v_challenge, v_cred.person_id, 'verifier_passkey', p_proof);
end;
$$;

comment on function api_verified.case_decide_passkey(uuid, text, text, bigint, jsonb) is
    '驗證服務確認「這把通行金鑰簽了這個挑戰值」後呼叫。資料庫不驗章，只檢查挑戰值、綁定、簽核人資格。呼叫者：sgn_test_verifier。規則：K-DECISION-PROOF、K-DECISION-ELIGIBLE、K-SOD-APPLICANT';

revoke all on all functions in schema api_verified from public;
grant usage on schema api_verified to :"verifier";
grant execute on all functions in schema api_verified to :"verifier";
