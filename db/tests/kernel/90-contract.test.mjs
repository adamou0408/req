// 契約與架構測試（工程規範第 5 節）：
//   1. 路由表（packages/contract）引用的每個 function 都存在、參數相符；每個 api function 都有歸屬
//   2. 每個使用者動作一個 api function，回傳 jsonb 的結構固定（真的呼叫一次，結構不多不少）
//   3. 授權檢查只有一個入口（sgn_internal.denial_reason）；防止同一條規則被寫第二份
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import {
    anchorCalls,
    backendCalls,
    deliveryCalls,
    mailerCalls,
    packRoutes,
    reconcilerCalls,
    routes,
    schedulerCalls,
    shapeProblems,
    syncCalls,
} from '../../../packages/contract/src/routes.ts';
import { activeSalesOrderCase, confirmableSalesOrderCase, salesOrderContent } from '../packs/data_access/delivery-lib.mjs';
import {
    call,
    challengeFor,
    closePools,
    config,
    decisionChallenge,
    endorsementChallenge,
    idToken,
    login,
    LOGIN_SOURCE,
    newAuthenticator,
    oldKey,
    pool,
    proposalChallenge,
    PROBE,
    registerPasskey,
    registrar,
    registrationNonce,
    roleDecisionChallenge,
    settlePasskey,
    shownOn,
} from './lib/harness.mjs';

const admin = pool('ADMIN');
const app = pool('APP');
// 核心的路由與後端呼叫由這個檔案實際呼叫檢查；流程包的路由由各流程包的測試檢查（db/tests/packs/<流程包>/）。
const kernelCalls = [...routes, ...Object.values(backendCalls)];
const allCalls = [...kernelCalls, ...Object.values(packRoutes).flat()];

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

test('契約：每個 api function 都有歸屬（路由或後端流程），沒有孤兒', async () => {
    // 紅隊 高-2 之後沒有「存在但不開放」的 api function：不開放的就不在正式建置裡（權限只依路由表授權）
    const known = new Set(allCalls.map((c) => c.fn));
    const orphans = (await apiFunctions()).map((r) => r.fn).filter((fn) => !known.has(fn));
    assert.deepEqual(orphans, []);
});

test('契約：人員同步、排程與交付程式的允許清單（syncCalls、排程／對帳／錨定／寄信四張表合起來、deliveryCalls）引用的 function 都存在、參數名稱與順序相符，且沒有清單外的 function', async () => {
    for (const [schema, calls] of [
        ['api_sync', Object.values(syncCalls)],
        ['api_job', [anchorCalls, mailerCalls, reconcilerCalls, schedulerCalls].flatMap((calls) => Object.values(calls))],
        ['api_delivery', Object.values(deliveryCalls)],
    ]) {
        const { rows } = await admin.query(
            `select p.proname as fn, coalesce(p.proargnames[1:p.pronargs], '{}') as args
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 order by 1`,
            [schema],
        );
        const byName = new Map(rows.map((r) => [r.fn, r]));
        for (const c of calls) {
            assert.ok(byName.get(c.fn), `${schema}.${c.fn} 不存在`);
            assert.deepEqual(
                byName.get(c.fn).args,
                c.params.map((p) => `p_${p}`),
                `${schema}.${c.fn} 的參數`,
            );
        }
        assert.deepEqual(rows.map((r) => r.fn).sort(), calls.map((c) => c.fn).sort(), `${schema} 有清單外的 function`);
    }
});

// 還沒有工作階段的入口：開始登入時只有後端認定的來源（裁決 D78：每個來源各自的上限在資料庫），不是任何人的身分。
const BEFORE_SESSION = { session_begin: ['p_source'] };

test('架構：api function 不接受任何「人」當參數；行為人只來自工作階段或驗過的證明（第一個參數是 p_session 或 p_challenge_id）', async () => {
    for (const fn of await apiFunctions()) {
        assert.ok(!fn.args.some((a) => /person|actor|user/.test(a)), `api.${fn.fn} 有人員參數：${fn.args}`);
        if (BEFORE_SESSION[fn.fn]) assert.deepEqual(fn.args, BEFORE_SESSION[fn.fn], `api.${fn.fn} 只收來源`);
        else if (fn.args.length > 0)
            assert.ok(['p_session', 'p_challenge_id'].includes(fn.args[0]), `api.${fn.fn} 的第一個參數是 ${fn.args[0]}`);
    }
});

// ── 授權單一入口 ──

async function functionSources() {
    const { rows } = await admin.query(
        `select n.nspname || '.' || p.proname as fn, p.prosrc as src
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
         where (n.nspname in ('sgn_internal', 'sgn_sdk', 'api', 'api_sync', 'api_job', 'api_delivery', 'api_verified') or n.nspname like 'pack\\_%')
           and l.lanname in ('sql', 'plpgsql')`,
    );
    return rows;
}

const AUTHORIZATION_CODES = [
    'NOT_APPLICANT',
    'NOT_APPROVER',
    'SELF_APPROVAL',
    'AUDITOR_REQUIRED',
    'NOT_CLAIMABLE',
    'NOT_FULFILLER',
    'SOD_DISTINCT',
    'DECIDER_ROLE_EXCLUDED',
    'ROLE_CHANGE_NOT_PROPOSER',
    'ROLE_CHANGE_NOT_APPROVER',
    'ROLE_CHANGE_SELF',
    'ROLE_CHANGE_EXCLUDED',
    'ROLE_CHANGE_STATE',
    'ROLE_CHANGE_SAME_ROLE',
    'ROLE_CHANGE_SOURCE',
    'ROLE_CHANGE_SCOPE_NOT_COVERED',
    'ROLE_CHANGE_NOT_GOVERNOR',
    'PASSKEY_ENDORSER_NOT_ALLOWED',
    'PASSKEY_SELF_ONLY',
    'ROLE_CHANGE_CEREMONY',
    'NOT_REVOKER',
];
// 授權入口：denial_reason 是唯一的判斷；決定者資格（職責分離）拆成 decider_denial，由 denial_reason 與解析器共用，
// 所以「能不能被指派」和「能不能做決定」是同一個判斷（K-DECISION-ELIGIBLE）。
const AUTHORIZATION_OWNERS = ['sgn_internal.denial_reason', 'sgn_internal.decider_denial'];
// 依「我自己的」挑資料的清單查詢（不是授權判斷）：清單裡每張單能做什麼仍由 denial_reason 算出。
const SELF_SCOPED_FILTERS = {
    'api.case_list_mine': '我的申請：applicant_person_id = 我',
    'api.inbox_list': '待簽候選：approver_person_id = 我，再由 case_actions（denial_reason）篩出可做的',
    'sgn_internal.person_capabilities': '畫面提示「有沒有待簽」：approver_person_id = 我',
};

test('架構：授權檢查只有一個入口——授權的錯誤代碼、角色判斷、申請人／簽核人的比對只出現在授權入口', async () => {
    const sources = await functionSources();
    for (const owner of AUTHORIZATION_OWNERS)
        assert.ok(
            sources.some((s) => s.fn === owner),
            owner,
        );
    for (const { fn, src } of sources.filter((s) => !AUTHORIZATION_OWNERS.includes(s.fn))) {
        for (const code of AUTHORIZATION_CODES)
            assert.ok(!src.includes(`'${code}'`), `${fn} 自己丟授權錯誤 ${code}：要改成呼叫 sgn_internal.authorize`);
        assert.ok(!/sgn_internal\.has_role\s*\(/.test(src), `${fn} 自己判斷角色：要改成呼叫 sgn_internal.authorize`);
        // 比對「某個人」和申請人或簽核人（人員變數一律叫 p_person_id、v_person_id、p_actor）
        const compares =
            /(applicant|approver)_person_id\s*(=|<>|!=|is (not )?distinct from)\s*(p_person_id|v_person_id|p_actor)\b|\b(p_person_id|v_person_id|p_actor)\s*(=|<>|!=|is (not )?distinct from|in)\s*\(?\s*[\w.]*(applicant|approver)_person_id/i;
        if (compares.test(src)) assert.ok(SELF_SCOPED_FILTERS[fn], `${fn} 自己比對申請人或簽核人：要改成呼叫 sgn_internal.authorize`);
    }
});

// 會改狀態、卻不自己呼叫授權入口的內部 function，與理由（呼叫它們的人已經授權過）。
const TRANSITION_WITHOUT_AUTHORIZE = {
    'sgn_internal.case_advance': '關卡推進：只由已授權的送審、決定、執行完成之後呼叫，執行的是 system 動作',
    'sgn_internal.decision_apply': '套用決定：只由 decision_commit 呼叫，decision_commit 先以證明得出的人授權',
    'sgn_internal.fulfilment_progress': '執行關的進度：只由關卡收尾與交付回報（api_delivery，系統）呼叫，執行的是 system 動作',
    'sgn_internal.fulfilment_fail': '交付或驗證失敗：只由交付回報（api_delivery，系統）呼叫，執行的是 system 動作或系統撤銷',
    'sgn_internal.grant_end': '授權結束：撤銷由 api.case_revoke 先授權；到期與驗證失敗是排程與交付回報的 system 動作',
    'sgn_internal.confirmation_expire_due':
        '確認逾期自動撤銷：只由排程（api_job）與交付程式的領取（api_delivery）呼叫，執行的是 system 動作',
    'sgn_internal.case_rebind':
        '外部定義改版後重新綁定（K-CONTENT-REBIND）：只由流程包在改版的交易裡經 sgn_sdk 呼叫（資料庫擁有者執行的目錄載入），執行的是 system 動作',
};

test('架構：會改狀態或讀稽核資料的 function 都經過授權入口', async () => {
    const sources = await functionSources();
    const mustAuthorize = sources.filter(
        (s) =>
            (/sgn_internal\.case_transition\s*\(/.test(s.src) && !TRANSITION_WITHOUT_AUTHORIZE[s.fn]) ||
            /^api\.(audit_|case_get|challenge_issue|task_claim)/.test(s.fn),
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
    const c = kernelCalls.find((x) => x.fn === fn);
    assert.deepEqual(shapeProblems(value, c.returns), [], `api.${fn} 的回傳結構`);
    checked.set(fn, (checked.get(fn) ?? 0) + 1);
    return value;
}

let applicant;
let manager;
let auditor;
let groupMember;
let auditHead;
let auditGovernor;
before(async () => {
    applicant = await login(app, 'p04');
    manager = await login(app, 'p03');
    auditor = await login(app, 'p22');
    groupMember = await login(app, 'p16');
    auditHead = await login(app, 'p21');
    auditGovernor = await login(app, 'p28');
    auditGovernor.key = await registerPasskey(app, auditGovernor);
    auditHead.key = await registerPasskey(app, auditHead);
});

test('契約：每個路由與後端呼叫的回傳結構都符合路由表（真的呼叫一次，結構不多不少）', async () => {
    // 登入流程
    const begin = await check('session_begin', LOGIN_SOURCE);
    const opened = await check('session_open', begin.challenge_id, await idToken('p04', begin.nonce));
    await check('error_catalog');
    // 登記通行金鑰：再驗證之後是待核准；登記人以通行金鑰背書；（模擬）冷卻期過了才能簽
    const key = newAuthenticator();
    const reg = await check('passkey_register_begin', manager.session);
    const pending = await check(
        'passkey_register',
        reg.challenge_id,
        await idToken('p03', registrationNonce(reg.challenge, key.spki)),
        key.credentialIdB64,
        key.spkiB64,
    );
    // D76：已有金鑰就由本人用舊金鑰核准，第一把才由登記人背書；都比對新裝置的完整指紋
    const own = await oldKey(app, manager);
    const endorser = own ? { ...manager, key: own } : await registrar(app);
    await check('passkey_enrollment_list', endorser.session);
    const nonce = await check('passkey_endorse_challenge', endorser.session, pending.enrollment_id, 'qr');
    const signed = endorser.key.assert(
        await endorsementChallenge(app, endorser, pending.enrollment_id, nonce, { method: 'qr', onDevice: await shownOn(key) }),
    );
    await check(
        'passkey_endorse_passkey',
        nonce.challenge_id,
        signed.credentialId,
        signed.authenticatorData,
        signed.clientDataJSON,
        signed.signature,
    );
    await settlePasskey(app, key);
    await check('frontdoor_policy');
    // 申請人
    await check('me', applicant.session);
    await check('process_type_list', applicant.session);
    await check('principal_list', applicant.session);
    const draft = await check('case_create', applicant.session, PROBE, { dataset: 'd', purpose: 'p' }, {});
    await check('case_revise', applicant.session, draft.case_id, { dataset: 'd', purpose: 'p2' }, {});
    await check('case_submit', applicant.session, draft.case_id, null);
    const submitted = await check('case_submit_new', applicant.session, PROBE, { dataset: 'e', purpose: 'q' }, {}, null);
    await check('case_get', applicant.session, submitted.case_id);
    await check('case_list_mine', applicant.session);
    // 捨棄從沒送審過的草稿（K-CASE-DISCARD）
    await check(
        'case_discard',
        applicant.session,
        (await call(app, 'case_create', applicant.session, PROBE, { dataset: 'x' }, {})).case_id,
    );
    // 簽核人：核准一張、退回一張
    await check('inbox_list', manager.session);
    const decide = async (person, caseId, decision, input) => {
        const ch = await check('challenge_issue', person.session, caseId, decision, input);
        const a = key.assert(await decisionChallenge(app, person, caseId, decision, input, ch));
        return check('case_decide_passkey', ch.challenge_id, decision, a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature);
    };
    assert.equal((await decide(manager, submitted.case_id, 'approve', {})).state, 'completed');
    assert.equal((await decide(manager, draft.case_id, 'return', { reason: '請補充用途' })).state, 'returned');
    // 群組認領：多關的測試流程，主管核准後由群組（mis）的一人認領
    const chain = await call(app, 'case_submit_new', applicant.session, 'probe_chain', { dataset: 'f' }, {}, null);
    await decide(manager, chain.case_id, 'approve', {});
    const claimed = await check('task_claim', groupMember.session, chain.case_id);
    assert.deepEqual(claimed.waiting_on, [claimed.waiting_on[0]]);
    // 稽核
    await check('audit_case', auditor.session, submitted.case_no);
    await check('audit_chain', auditor.session, 0, 50);
    await check('audit_code_fingerprint', auditor.session);
    await check('audit_exceptions', auditor.session);
    await check('audit_exception_groups', auditor.session);
    await check('program_health', auditor.session);
    // 角色指派變更：稽核主管提出、稽核治理人以通行金鑰核准；最後撤除，不影響其他測試
    await check('role_change_options', auditHead.session);
    const changeRole = async (change) => {
        const spec = { holderId: applicant.personId, role: 'auditor', scope: null, change, reason: '契約測試' };
        const proposal = await check(
            'role_change_propose_challenge',
            auditHead.session,
            spec.holderId,
            spec.role,
            null,
            change,
            spec.reason,
        );
        const p = auditHead.key.assert(await proposalChallenge(app, auditHead, spec, proposal));
        const proposed = await check(
            'role_change_propose_passkey',
            proposal.challenge_id,
            p.credentialId,
            p.authenticatorData,
            p.clientDataJSON,
            p.signature,
        );
        await check('role_change_list', auditGovernor.session);
        const ch = await check('role_change_challenge', auditGovernor.session, proposed.request_id, 'approve');
        const a = auditGovernor.key.assert(await roleDecisionChallenge(app, auditGovernor, proposed.request_id, 'approve', ch));
        return check(
            'role_change_decide_passkey',
            ch.challenge_id,
            'approve',
            a.credentialId,
            a.authenticatorData,
            a.clientDataJSON,
            a.signature,
        );
    };
    assert.equal((await changeRole('grant')).status, 'approved');
    assert.equal((await changeRole('revoke')).status, 'approved');
    // 停用與撤銷通行金鑰（K-PASSKEY-SUSPEND、K-PASSKEY-REVOKE）：邱冠廷之後的測試都不用；82 留下一把冷卻中的金鑰
    // 只憑登入是「停用」（裁決 D84 (2)）；之後由登記人用通行金鑰撤銷（連停用中的），再走第一把金鑰的背書
    const holder = await login(app, 'p14');
    const keeper = await registrar(app);
    await check('passkey_revocation_list', holder.session);
    await check('passkey_revoke_self', holder.session, '契約測試：只憑登入停用');
    await check('passkey_suspension_list', holder.session);
    const signRevoke = async (signer, reason) => {
        const listed = (await call(app, 'passkey_revocation_list', signer.session)).find((x) => x.display.person.id === holder.personId);
        const revoke = await check('passkey_revoke_challenge', signer.session, holder.personId, reason);
        const r = signer.key.assert(
            await challengeFor({
                purpose: 'passkey.revocation',
                ref: holder.personId,
                content: { ...listed.display, reason },
                decision: 'revoke',
                nonce: revoke.nonce,
            }),
        );
        await check('passkey_revoke_passkey', revoke.challenge_id, r.credentialId, r.authenticatorData, r.clientDataJSON, r.signature);
    };
    await signRevoke(keeper, '契約測試：登記人用金鑰撤銷');
    // 裁決 D88 (1)：撤銷的登記人不能背書替換的金鑰，由第二位登記人背書（安裝時建立；harness 的 oldKey 認得它的金鑰）
    const second = await login(app, config.db.SGN_SEED_REGISTRAR_2);
    second.key = await oldKey(app, second);
    const replacement = newAuthenticator();
    holder.key = await registerPasskey(app, holder, replacement, { endorser: second, settle: false });
    // 冷卻期內本人可以回報「不是我登記的」（K-PASSKEY-NOT-ME）：先看清單；回報之後再登記一把真的（本人只憑登入撤銷之後只能當面掃）
    const disownable = await check('passkey_not_me_list', holder.session);
    assert.equal(disownable.length, 1);
    await check('passkey_report_not_me', holder.session, disownable[0].display.credential_id);
    holder.key = await registerPasskey(app, holder, newAuthenticator(), { endorser: second });
    await signRevoke(holder, '契約測試：用金鑰撤銷');
    // 恢復停用的金鑰：稽核主管（之後不再用）停用 → 本人用原金鑰簽 → 登記人背書
    await call(app, 'passkey_revoke_self', auditHead.session, '契約測試：停用');
    const suspension = (await call(app, 'passkey_suspension_list', auditHead.session))[0].display.suspension_id;
    const restore = async (signer, purpose, decision) => {
        const ch = await check('passkey_restore_challenge', signer.session, suspension);
        const a = signer.key.assert(await challengeFor({ purpose, ref: suspension, content: ch.display, decision, nonce: ch.nonce }));
        return check('passkey_restore_passkey', ch.challenge_id, a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature);
    };
    assert.equal((await restore(auditHead, 'passkey.restore', 'restore')).status, 'self_confirmed');
    assert.equal((await restore(keeper, 'passkey.restore_endorse', 'endorse')).status, 'restored');
    // 生效之後縮小、撤銷（D63）：資料授權的單經交付程式與模擬的外部系統生效之後
    const active = await activeSalesOrderCase(app, admin, applicant, 2008);
    await check('case_reduce', applicant.session, active, salesOrderContent(2008, ['amount', 'order_no']), null, '契約測試：縮小');
    await check('case_revoke', applicant.session, active, '契約測試：撤銷');
    // 申請人確認驗證結果、回報不對（K-CONFIRM）：自動驗證通過、等確認的單
    await check('case_confirm_verification', applicant.session, await confirmableSalesOrderCase(app, admin, applicant, 2006));
    await check(
        'case_dispute_verification',
        applicant.session,
        await confirmableSalesOrderCase(app, admin, applicant, 2007),
        '契約測試：結果不對',
    );
    // 登出
    await check('session_close', opened.session_token);

    const missing = kernelCalls.map((c) => c.fn).filter((fn) => !checked.has(fn));
    assert.deepEqual(missing, [], '每個路由與後端呼叫都要實際檢查過結構');
});

test('契約：畫面（web/）呼叫的每個 function 都在路由表裡', async () => {
    const webDir = new URL('../../../web/', import.meta.url);
    // 畫面拆成多個模組（web/pages/ 等子目錄），所以遞迴掃描；流程包的路由（packRoutes）也是畫面可呼叫的路由
    const used = readdirSync(webDir, { recursive: true })
        .filter((f) => f.endsWith('.js'))
        .flatMap((f) => [...readFileSync(new URL(f, webDir), 'utf8').matchAll(/api\.call\(\s*'(\w+)'/g)].map((m) => m[1]));
    assert.ok(used.length >= 10, `只找到 ${used.length} 個呼叫`);
    const routed = new Set([...routes, ...Object.values(packRoutes).flat()].map((r) => r.fn));
    assert.deepEqual([...new Set(used.filter((fn) => !routed.has(fn)))], []);
});
