// 契約與架構測試（工程規範第 5 節）：
//   1. 路由表（packages/contract）引用的每個 function 都存在、參數相符；每個 api function 都有歸屬
//   2. 每個使用者動作一個 api function，回傳 jsonb 的結構固定（真的呼叫一次，結構不多不少）
//   3. 授權檢查只有一個入口（sgn_internal.denial_reason）；防止同一條規則被寫第二份
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { backendCalls, notExposed, routes, shapeProblems } from '../../../packages/contract/src/routes.ts';
import { call, closePools, idToken, login, newAuthenticator, pool, registrationNonce } from './lib/harness.mjs';

const admin = pool('ADMIN');
const app = pool('APP');
const allCalls = [...routes, ...Object.values(backendCalls)];

after(closePools);

async function apiFunctions() {
    const { rows } = await admin.query(
        `select p.proname as fn, coalesce(p.proargnames[1:p.pronargs], '{}') as args, pg_get_function_result(p.oid) as result
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'api' order by 1`,
    );
    return rows;
}

test('契約：路由表與後端呼叫的每個 function 都存在、參數名稱與順序相符、回傳 jsonb', async () => {
    const byName = new Map((await apiFunctions()).map((r) => [r.fn, r]));
    for (const c of allCalls) {
        const fn = byName.get(c.fn);
        assert.ok(fn, `api.${c.fn} 不存在`);
        assert.deepEqual(
            fn.args,
            c.params.map((p) => `p_${p}`),
            `api.${c.fn} 的參數`,
        );
        assert.equal(fn.result, 'jsonb', `api.${c.fn} 應回傳 jsonb`);
    }
});

test('契約：每個 api function 都有歸屬（路由、後端流程、或明列不開放的理由），沒有孤兒', async () => {
    const known = new Set([...allCalls.map((c) => c.fn), ...Object.keys(notExposed)]);
    const orphans = (await apiFunctions()).map((r) => r.fn).filter((fn) => !known.has(fn));
    assert.deepEqual(orphans, []);
});

test('架構：api function 不接受任何「人」當參數；行為人只來自工作階段或驗過的證明（第一個參數是 p_session 或 p_challenge_id）', async () => {
    for (const fn of await apiFunctions()) {
        assert.ok(!fn.args.some((a) => /person|actor|user/.test(a)), `api.${fn.fn} 有人員參數：${fn.args}`);
        if (fn.args.length > 0)
            assert.ok(['p_session', 'p_challenge_id'].includes(fn.args[0]), `api.${fn.fn} 的第一個參數是 ${fn.args[0]}`);
    }
});

// ── 授權單一入口 ──

async function functionSources() {
    const { rows } = await admin.query(
        `select n.nspname || '.' || p.proname as fn, p.prosrc as src
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
         where n.nspname in ('sgn_internal', 'api', 'api_sync', 'api_job', 'api_verified') and l.lanname in ('sql', 'plpgsql')`,
    );
    return rows;
}

const AUTHORIZATION_CODES = ['NOT_APPLICANT', 'NOT_APPROVER', 'SELF_APPROVAL', 'AUDITOR_REQUIRED'];
// 依「我自己的」挑資料的清單查詢（不是授權判斷）：清單裡每張單能做什麼仍由 denial_reason 算出。
const SELF_SCOPED_FILTERS = {
    'api.case_list_mine': '我的申請：applicant_person_id = 我',
    'api.inbox_list': '待簽候選：approver_person_id = 我，再由 case_actions（denial_reason）篩出可做的',
    'sgn_internal.person_capabilities': '畫面提示「有沒有待簽」：approver_person_id = 我',
};

test('架構：授權檢查只有一個入口——授權的錯誤代碼、角色判斷、申請人／簽核人的比對只出現在 sgn_internal.denial_reason', async () => {
    const sources = await functionSources();
    const owner = 'sgn_internal.denial_reason';
    assert.ok(sources.some((s) => s.fn === owner));
    for (const { fn, src } of sources.filter((s) => s.fn !== owner)) {
        for (const code of AUTHORIZATION_CODES)
            assert.ok(!src.includes(`'${code}'`), `${fn} 自己丟授權錯誤 ${code}：要改成呼叫 sgn_internal.authorize`);
        assert.ok(!/sgn_internal\.has_role\s*\(/.test(src), `${fn} 自己判斷角色：要改成呼叫 sgn_internal.authorize`);
        // 比對「某個人」和申請人或簽核人（人員變數一律叫 p_person_id、v_person_id、p_actor）
        const compares =
            /(applicant|approver)_person_id\s*(=|<>|!=|is (not )?distinct from)\s*(p_person_id|v_person_id|p_actor)\b|\b(p_person_id|v_person_id|p_actor)\s*(=|<>|!=|is (not )?distinct from|in)\s*\(?\s*[\w.]*(applicant|approver)_person_id/i;
        if (compares.test(src)) assert.ok(SELF_SCOPED_FILTERS[fn], `${fn} 自己比對申請人或簽核人：要改成呼叫 sgn_internal.authorize`);
    }
});

test('架構：會改狀態或讀稽核資料的 function 都經過授權入口', async () => {
    const sources = await functionSources();
    const mustAuthorize = sources.filter(
        (s) => /sgn_internal\.case_transition\s*\(/.test(s.src) || /^api\.(audit_|case_get|challenge_issue)/.test(s.fn),
    );
    assert.ok(mustAuthorize.length >= 8, mustAuthorize.map((s) => s.fn).join(', '));
    for (const { fn, src } of mustAuthorize) assert.match(src, /sgn_internal\.authorize\s*\(/, `${fn} 沒有呼叫 sgn_internal.authorize`);
    // 畫面的可執行動作清單與功能也由同一個入口算出
    for (const fn of ['sgn_internal.case_actions', 'sgn_internal.person_capabilities']) {
        assert.match(sources.find((s) => s.fn === fn).src, /sgn_internal\.denial_reason\s*\(/, fn);
    }
});

// ── 回傳結構 ──

const checked = new Map();
async function check(fn, ...args) {
    const value = await call(app, fn, ...args);
    const c = allCalls.find((x) => x.fn === fn);
    assert.deepEqual(shapeProblems(value, c.returns), [], `api.${fn} 的回傳結構`);
    checked.set(fn, (checked.get(fn) ?? 0) + 1);
    return value;
}

let applicant;
let manager;
let auditor;
before(async () => {
    applicant = await login(app, 'p04');
    manager = await login(app, 'p03');
    auditor = await login(app, 'p22');
});

test('契約：每個路由與後端呼叫的回傳結構都符合路由表（真的呼叫一次，結構不多不少）', async () => {
    // 登入流程
    const begin = await check('session_begin');
    const opened = await check('session_open', begin.challenge_id, await idToken('p04', begin.nonce));
    await check('error_catalog');
    // 登記通行金鑰
    const key = newAuthenticator();
    const reg = await check('passkey_register_begin', manager.session);
    await check(
        'passkey_register',
        reg.challenge_id,
        await idToken('p03', registrationNonce(reg.challenge, key.spki)),
        key.credentialIdB64,
        key.spkiB64,
    );
    // 申請人
    await check('me', applicant.session);
    const draft = await check('case_create', applicant.session, { dataset: 'd', purpose: 'p' });
    await check('case_revise', applicant.session, draft.case_id, { dataset: 'd', purpose: 'p2' });
    await check('case_submit', applicant.session, draft.case_id);
    const submitted = await check('case_submit_new', applicant.session, { dataset: 'e', purpose: 'q' });
    await check('case_get', applicant.session, submitted.case_id);
    await check('case_list_mine', applicant.session);
    // 簽核人：核准一張、退回一張
    await check('inbox_list', manager.session);
    for (const [caseId, decision] of [
        [submitted.case_id, 'approve'],
        [draft.case_id, 'return'],
    ]) {
        const ch = await check('challenge_issue', manager.session, caseId, decision);
        const a = key.assert(ch.challenge);
        const decided = await check(
            'case_decide_passkey',
            ch.challenge_id,
            decision,
            a.credentialId,
            a.authenticatorData,
            a.clientDataJSON,
            a.signature,
        );
        assert.equal(decided.state, decision === 'approve' ? 'approved' : 'draft');
    }
    // 稽核
    await check('audit_case', auditor.session, submitted.case_no);
    await check('audit_chain', auditor.session, 0, 50);
    await check('audit_code_fingerprint', auditor.session);
    await check('audit_exceptions', auditor.session);
    // 登出
    await check('session_close', opened.session_token);

    const missing = allCalls.map((c) => c.fn).filter((fn) => !checked.has(fn));
    assert.deepEqual(missing, [], '每個路由與後端呼叫都要實際檢查過結構');
});

test('契約：畫面（web/）呼叫的每個 function 都在路由表裡', async () => {
    const webDir = new URL('../../../web/', import.meta.url);
    const used = readdirSync(webDir)
        .filter((f) => f.endsWith('.js'))
        .flatMap((f) => [...readFileSync(new URL(f, webDir), 'utf8').matchAll(/api\.call\(\s*'(\w+)'/g)].map((m) => m[1]));
    assert.ok(used.length >= 10, `只找到 ${used.length} 個呼叫`);
    const routed = new Set(routes.map((r) => r.fn));
    assert.deepEqual([...new Set(used.filter((fn) => !routed.has(fn)))], []);
});
