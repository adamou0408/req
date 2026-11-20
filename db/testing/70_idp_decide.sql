-- 測試專用（不進發行包）：架構 (b)「身分提供者再驗證」的決定，只為了和 (a) 通行金鑰比較而保留（db/tests/kernel/40-proof-idp.test.mjs）。
-- 正式建置沒有這條路徑（db/kernel/240_decision_proof_only_passkey.sql；紅隊 redteam/findings.md 高-2）：
-- 只靠身分提供者的 ID token 做決定，等於只靠密碼。這裡放在只有 sgn_test_verifier 能用的 api_verified，
-- 後端帳號（sgn_app）在任何資料庫都執行不到。
-- :"verifier" 由 db/build.sh 以 psql -v 傳入。

create function api_verified.case_decide_idp(p_challenge_id uuid, p_decision text, p_id_token text)
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
        sgn_internal.idp_token_verify(p_id_token, sgn_internal.b64url_encode(v_challenge.challenge)),
        'idp_stepup',
        jsonb_build_object('id_token', p_id_token)
    );
end;
$$;

comment on function api_verified.case_decide_idp(uuid, text, text) is
    '比較用：以身分提供者再驗證的 ID token（nonce＝挑戰值）做決定。誰做的決定由資料庫驗章後從 token 得出。'
    '只裝在資料庫測試用的資料庫。呼叫者：sgn_test_verifier。規則：K-DECISION-PROOF、K-DECISION-ELIGIBLE、K-SOD-APPLICANT';

revoke all on function api_verified.case_decide_idp(uuid, text, text) from public;
grant execute on function api_verified.case_decide_idp(uuid, text, text) to :"verifier";

-- 比較用的兩種證明 (b)(c) 只在這個資料庫可以存（正式環境的參數預設只有 passkey）。
select sgn_internal.register_setting_value(
    'decision.allowed_proof_kinds',
    'global',
    '["passkey", "idp_stepup", "verifier_passkey"]'::jsonb,
    'db/testing：資料庫測試比較架構 (b)(c)'
);
