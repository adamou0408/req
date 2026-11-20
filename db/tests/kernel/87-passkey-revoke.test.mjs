// 通行金鑰的撤銷與遺失全部裝置的補救（K-PASSKEY-REVOKE）。威脅表見 docs/handoff/leftovers-1.md 第 2 節，
// 每一列對應這裡的一個斷言（列號寫在註解）。攻擊者模型：拿到後端（可以用任何已登入使用者的工作階段、改寫任何回應），
// 不能改頁面程式，也拿不到別人裝置上的私鑰。用的人（p31、p32、p33、p34、p35）其他測試都沒有用到：撤銷之後，
// 測試共用的「舊金鑰」（harness 的 .run/passkeys-<資料庫>.json）就不能再用了。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    PROBE,
    call,
    challengeFor,
    closePools,
    decidePasskey,
    issueChallenge,
    login,
    newAuthenticator,
    one,
    pool,
    registerPasskey,
    rejectsWith,
    requestPasskey,
    approveEnrollment,
    registrar,
    settlePasskey,
    shownOn,
} from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
const users = {};

before(async () => {
    for (const uid of ['p31', 'p32', 'p33', 'p34', 'p35']) {
        users[uid] = await login(app, uid);
        users[uid].key = await registerPasskey(app, users[uid]);
    }
});
after(closePools);

const raw = (a) => [a.credentialId, a.authenticatorData, a.clientDataJSON, a.signature];
const listed = async (viewer, target) =>
    (await call(app, 'passkey_revocation_list', viewer.session)).find((r) => r.display.person.id === target.personId);
const notified = (event, personId) =>
    one(admin, `select count(*)::int as n from sgn.notification_outbox where event_code = $1 and person_id = $2`, [event, personId]).then(
        (r) => r.n,
    );

/** 扮演撤銷人的瀏覽器：從清單（畫面）上的顯示摘要加上自己打的原因算挑戰值並簽。shown 可以是被後端改寫過的摘要。 */
async function revokeSigned(revoker, target, reason, shown = null) {
    const display = shown ?? (await listed(revoker, target)).display;
    const ch = await call(app, 'passkey_revoke_challenge', revoker.session, target.personId, reason);
    const challenge = await challengeFor({
        purpose: 'passkey.revocation',
        ref: target.personId,
        content: { ...display, reason: reason.trim() },
        decision: 'revoke',
        nonce: ch.nonce,
    });
    return call(app, 'passkey_revoke_passkey', ch.challenge_id, ...raw(revoker.key.assert(challenge)));
}

test('K-PASSKEY-SUSPEND 本人只憑登入只能「停用」全部金鑰（裁決 D84 (2)，原本是撤銷）：立即生效（進行中的挑戰值也不能用）、沒被核准的登記作廢、進鏈、通知本人與主管', async () => {
    const me = users.p35;
    // 進行中的工作：本人送出的單，撤回要簽的挑戰值在停用之前就發了
    const caseId = (await call(app, 'case_submit_new', me.session, PROBE, { dataset: 'revoke', n: Math.random() }, {}, null)).case_id;
    const pendingChallenge = await issueChallenge(app, me, caseId, 'recall', { reason: '撤回' });
    // 列 4：停用前排著的登記（例如被入侵的後端趁機排的）
    const queued = await requestPasskey(app, me, newAuthenticator());
    assert.equal(queued.status, 'pending');
    assert.deepEqual((await listed(me, me)).actions, ['revoke_self', 'revoke']);
    await rejectsWith(call(app, 'passkey_revoke_self', me.session, '  '), 'REASON_REQUIRED');
    const done = await call(app, 'passkey_revoke_self', me.session, '手機與筆電都遺失了');
    assert.equal(done.person.id, me.personId);
    assert.equal(done.suspended, 1);
    assert.equal(done.cancelled_enrollments, 1);
    // 列 5：停用前發的挑戰值、停用後的新挑戰值，都簽不了
    await rejectsWith(
        call(app, 'case_decide_passkey', pendingChallenge.challenge_id, 'recall', ...raw(me.key.assert(pendingChallenge.challenge))),
        'PASSKEY_SUSPENDED',
    );
    const after = await call(app, 'me', me.session);
    assert.equal(after.passkeys, 0);
    assert.equal(after.passkey_suspended, 1);
    assert.deepEqual(after.passkey_pending, []);
    // 停用不是撤銷：金鑰還在（沒有 revoked_at），恢復要本人的原金鑰加上主管背書
    assert.equal(
        (
            await one(admin, 'select count(*)::int as n from sgn.passkey_credential where person_id = $1 and revoked_at is null', [
                me.personId,
            ])
        ).n,
        1,
    );
    // 列 7：進鏈（不放原因的原文）、通知本人與主管
    const event = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event where event_type = 'passkey.suspended' and actor_person_id = $1 order by seq desc limit 1`,
        [me.personId],
    );
    assert.equal(event.body.data.credentials.length, 1);
    // 裁決 D88 (2)：每次停用都檢查全公司的上限，事件也列出這條規則與它的參數
    assert.deepEqual(event.body.data.rules, ['K-PASSKEY-SUSPEND', 'K-PASSKEY-SUSPEND-FLOOD']);
    assert.ok(!JSON.stringify(event.body).includes('遺失'));
    assert.equal(await notified('passkey.suspended', me.personId), 1);
    assert.equal(await notified('passkey.suspended', users.p32.personId), 1);
    // 都停用了：再停一次沒有對象
    await rejectsWith(call(app, 'passkey_revoke_self', me.session, '再一次'), 'PASSKEY_NONE');
});

test('K-PASSKEY-SUSPEND 停用之後：不能只憑登入另登第一把；恢復要本人用原金鑰簽、再由主管或登記人背書（順序不能反、別的金鑰不行、無關的人不行）；每人每日停用有上限', async () => {
    const me = users.p35;
    // 推論未驗證 1（findings-5）：停用中的金鑰仍算「有金鑰」，主管不能替他背書一把新的
    const enrollment = await requestPasskey(app, me, newAuthenticator());
    await rejectsWith(call(app, 'passkey_endorse_challenge', users.p32.session, enrollment.enrollment_id, 'qr'), 'PASSKEY_SELF_ONLY');
    const [row] = (await call(app, 'passkey_suspension_list', me.session)).filter((r) => r.display.person.id === me.personId);
    assert.equal(row.status, 'suspended');
    assert.deepEqual(row.actions, ['restore']);
    // 主管不能先背書（本人還沒用原金鑰簽）；無關的人看不到、也做不了
    assert.equal((await call(app, 'passkey_suspension_list', users.p32.session)).length, 0);
    await rejectsWith(call(app, 'passkey_restore_challenge', users.p32.session, row.display.suspension_id), 'PASSKEY_NONE');
    const sign = async (who, key, decision) => {
        const ch = await call(app, 'passkey_restore_challenge', who.session, row.display.suspension_id);
        assert.equal(ch.decision, decision);
        const challenge = await challengeFor({
            purpose: decision === 'restore' ? 'passkey.restore' : 'passkey.restore_endorse',
            ref: row.display.suspension_id,
            content: ch.display,
            decision,
            nonce: ch.nonce,
        });
        return call(app, 'passkey_restore_passkey', ch.challenge_id, ...raw(key.assert(challenge)));
    };
    // 拿到裝置的人以外（例如冒用登入的人）沒有原金鑰：用別的金鑰簽不行
    await rejectsWith(sign(me, newAuthenticator(), 'restore'), 'PASSKEY_RESTORE_KEY');
    assert.equal((await sign(me, me.key, 'restore')).status, 'self_confirmed');
    assert.equal((await call(app, 'me', me.session)).passkeys, 0, '本人簽了還不夠');
    await rejectsWith(call(app, 'passkey_restore_challenge', users.p33.session, row.display.suspension_id), 'PASSKEY_RESTORE_NOT_ALLOWED');
    const forManager = await call(app, 'passkey_suspension_list', users.p32.session);
    assert.deepEqual(
        forManager.map((r) => [r.display.person.id, r.status, r.actions]),
        [[me.personId, 'self_confirmed', ['endorse_restore']]],
    );
    assert.equal((await sign(users.p32, users.p32.key, 'endorse')).status, 'restored');
    assert.equal((await call(app, 'me', me.session)).passkeys, 1, '恢復可用');
    const chain = await admin.query(
        `select event_type from sgn.audit_event where event_type in ('passkey.restore_requested', 'passkey.restored') and convert_from(body, 'UTF8')::jsonb #>> '{data,person}' = $1::text order by seq`,
        [me.personId],
    );
    assert.deepEqual(
        chain.rows.map((r) => r.event_type),
        ['passkey.restore_requested', 'passkey.restored'],
    );
    // 恢復的金鑰可以再簽
    const caseId = (await call(app, 'case_submit_new', me.session, PROBE, { dataset: 'restore', n: Math.random() }, {}, null)).case_id;
    const ch = await issueChallenge(app, me, caseId, 'recall', { reason: '撤回' });
    assert.ok(await decidePasskey(app, ch.challenge_id, 'recall', me.key.assert(ch.challenge)));
    // 每人每 24 小時停用的上限（passkey.suspend_daily_max 預設 1）：冒用登入的人不能反覆停用
    await rejectsWith(call(app, 'passkey_revoke_self', me.session, '又遺失了'), 'PASSKEY_SUSPEND_LIMIT');
    assert.equal((await call(app, 'me', me.session)).passkeys, 1);
});

test('K-PASSKEY-REVOKE 主管替部屬撤銷：一律用自己的通行金鑰簽顯示摘要（本人、每一把金鑰、原因）；後端改寫摘要就對不上；部屬手上的工作不改派', async () => {
    const target = users.p32;
    // 部屬手上的工作：p35 送的單在 p32（主管關）
    const caseId = (await call(app, 'case_submit_new', users.p35.session, PROBE, { dataset: 'revoke-task', n: Math.random() }, {}, null))
        .case_id;
    assert.deepEqual((await call(app, 'case_get', users.p35.session, caseId)).waiting_on, ['田中美咲']);
    const row = await listed(users.p31, target);
    assert.deepEqual(row.actions, ['revoke']);
    assert.equal(row.display.credentials.length, 1);
    // 列 3：後端改寫畫面上的摘要（少列一把金鑰、換成別人）——簽了也對不上，什麼都沒撤
    const forged = [
        { ...row.display, credentials: [] },
        { ...row.display, person: { ...row.display.person, name: '別人' } },
    ];
    for (const shown of forged) await rejectsWith(revokeSigned(users.p31, target, '裝置被偷', shown), 'SIGNED_CONTENT_MISMATCH');
    assert.equal((await call(app, 'me', target.session)).passkeys, 1);
    const done = await revokeSigned(users.p31, target, '裝置被偷');
    assert.equal(done.revoked, 1);
    assert.deepEqual(done.reenroll_methods, ['qr', 'code'], '用金鑰簽的撤銷：重新登記可以用兩種核對方式');
    // 列 6：工作不改派，部屬的舊金鑰簽不了
    assert.deepEqual((await call(app, 'case_get', users.p35.session, caseId)).waiting_on, ['田中美咲']);
    const ch = await issueChallenge(app, target, caseId);
    await rejectsWith(
        call(app, 'case_decide_passkey', ch.challenge_id, 'approve', ...raw(target.key.assert(ch.challenge))),
        'PASSKEY_REVOKED',
    );
    // 重新登記：第一把金鑰的背書（本人不能自己核准）；過冷卻期後繼續處理同一件工作。
    // 裁決 D88 (1)：撤銷的主管不能背書替換的金鑰，改由登記人背書
    const replacement = newAuthenticator();
    const pending = await requestPasskey(app, target, replacement);
    await rejectsWith(call(app, 'passkey_endorse_challenge', users.p31.session, pending.enrollment_id, 'qr'), 'PASSKEY_ENDORSER_REVOKER');
    await approveEnrollment(app, target, pending.enrollment_id, await shownOn(replacement), await registrar(app));
    await settlePasskey(app, replacement);
    target.key = replacement;
    const again = await issueChallenge(app, target, caseId);
    assert.equal(await decidePasskey(app, again.challenge_id, 'approve', target.key.assert(again.challenge)), 'completed');
});

test('K-PASSKEY-REVOKE 誰不能撤：沒有關係的人、主管鏈上更高的人、持有不能做決定的角色的主管；替別人撤一定要簽（沒有只憑登入替別人撤的入口）', async () => {
    const target = users.p34;
    // 列 8：同事（田中美咲）、別的主管（佐藤健一，不是直屬）
    await rejectsWith(call(app, 'passkey_revoke_challenge', users.p32.session, target.personId, '惡作劇'), 'PASSKEY_REVOKE_NOT_ALLOWED');
    await rejectsWith(call(app, 'passkey_revoke_challenge', users.p31.session, target.personId, '惡作劇'), 'PASSKEY_REVOKE_NOT_ALLOWED');
    assert.equal(await listed(users.p32, target), undefined);
    // 直屬主管鈴木大輔可以；他暫時持有稽核角色時不行（K-AUDITOR-INDEPENDENT）
    assert.deepEqual((await listed(users.p33, target)).actions, ['revoke']);
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source) values ($1, 'auditor', clock_timestamp(), 'manual')`,
        [users.p33.personId],
    );
    try {
        await rejectsWith(call(app, 'passkey_revoke_challenge', users.p33.session, target.personId, '離職'), 'DECIDER_ROLE_EXCLUDED');
    } finally {
        await admin.query(
            `update sgn.role_assignment set valid_to = clock_timestamp() where person_id = $1 and role_code = 'auditor' and valid_to is null`,
            [users.p33.personId],
        );
    }
    // 只憑登入的撤銷只撤自己：參數裡沒有對象
    const fn = await one(
        admin,
        `select p.proargnames as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname = 'passkey_revoke_self'`,
    );
    assert.deepEqual(fn.args, ['p_session', 'p_reason']);
    assert.equal((await call(app, 'me', target.session)).passkeys, 1, '都沒有撤成');
});

// 裁決 D86 (3)：只憑登入停用時，持有控制類或治理類角色的人就當場開例外並通知（500 只看治理類）。
// 角色依 sgn.role 的類別挑（不寫死角色名）；指派以管理者連線暫時加上，結束後收掉（同上一個測試的稽核角色）。
const roleOf = (category) =>
    one(admin, 'select code from sgn.role where category = $1 order by code limit 1', [category]).then((r) => r.code);
const holderExceptions = (rule, personId) =>
    admin
        .query(`select detail from sgn.exception_record where rule_code = $1 and detail ->> 'person' = $2::text order by id`, [
            rule,
            personId,
        ])
        .then((r) => r.rows.map((x) => x.detail));
const notifyPeople = () =>
    one(
        admin,
        `select coalesce(array_agg(distinct h order by h), '{}') as people
         from jsonb_array_elements_text(sgn_internal.setting('passkey.suspend_exception_notify_roles')) as n (code)
         cross join lateral unnest(sgn_internal.role_holders(n.code)) as h`,
    ).then((r) => r.people);

async function suspendHolding(user, roleCode) {
    await admin.query(
        `insert into sgn.role_assignment (person_id, role_code, valid_from, source) values ($1, $2, clock_timestamp(), 'manual')`,
        [user.personId, roleCode],
    );
    try {
        return await call(app, 'passkey_revoke_self', user.session, '手機遺失');
    } finally {
        await admin.query(
            `update sgn.role_assignment set valid_to = clock_timestamp() where person_id = $1 and role_code = $2 and valid_to is null`,
            [user.personId, roleCode],
        );
    }
}

test('K-PASSKEY-SUSPEND-HOLDER 只憑登入停用時，當事人持有控制類角色（例如登記人、資安長）就當場開例外並通知；治理類另開 K-GOVERNANCE-KEY；業務類與平台類不開', async () => {
    const control = await roleOf('control');
    const governance = await roleOf('governance');
    const people = (await notifyPeople()).filter((id) => id !== users.p34.personId);
    assert.ok(people.length >= 1, '參數的通知對象至少有一人');
    const before = await Promise.all(people.map((id) => notified('passkey.holder_suspended', id)));
    // 控制類（拿掉 D86 (3) 的修法、只看治理類時，這裡沒有例外）
    assert.equal((await suspendHolding(users.p34, control)).suspended, 1);
    const [flagged] = await holderExceptions('K-PASSKEY-SUSPEND-HOLDER', users.p34.personId);
    assert.deepEqual(flagged.roles, [{ code: control, category: 'control' }]);
    assert.deepEqual(flagged.settings['passkey.suspend_exception_categories'], ['control', 'governance']);
    assert.deepEqual(await holderExceptions('K-GOVERNANCE-KEY', users.p34.personId), [], '控制類不是治理類的例外');
    for (const [i, id] of people.entries()) assert.equal(await notified('passkey.holder_suspended', id), before[i] + 1, `通知 ${id}`);
    assert.equal(await notified('passkey.holder_suspended', users.p34.personId), 0, '不通知當事人（他收到 passkey.suspended）');
    const event = await one(
        admin,
        `select convert_from(body, 'UTF8')::jsonb as body from sgn.audit_event where event_type = 'passkey.suspended' and actor_person_id = $1 order by seq desc limit 1`,
        [users.p34.personId],
    );
    assert.deepEqual(event.body.data.flagged_roles, [{ code: control, category: 'control' }]);
    // 治理類：兩個例外都開
    assert.equal((await suspendHolding(users.p31, governance)).suspended, 1);
    assert.deepEqual(
        (await holderExceptions('K-PASSKEY-SUSPEND-HOLDER', users.p31.personId)).map((d) => d.roles),
        [[{ code: governance, category: 'governance' }]],
    );
    assert.deepEqual(
        (await holderExceptions('K-GOVERNANCE-KEY', users.p31.personId)).map((d) => d.roles),
        [[governance]],
    );
    // 種子資料裡本來就持有控制類角色的人（第一個測試停用的 p35）也開了，列的正是他持有的那些
    const held = await admin.query(
        `select distinct r.code, r.category from sgn.role_assignment a join sgn.role r on r.code = a.role_code
         where a.person_id = $1 and a.valid_to is null and r.category in ('control', 'governance') order by r.code`,
        [users.p35.personId],
    );
    assert.deepEqual(
        (await holderExceptions('K-PASSKEY-SUSPEND-HOLDER', users.p35.personId)).map((d) => d.roles),
        [held.rows],
    );
    // 只持有平台類角色的人（p32）：不開，也不通知
    const platform = await one(
        admin,
        `select count(*)::int as n from sgn.role_assignment a join sgn.role r on r.code = a.role_code
         where a.person_id = $1 and a.valid_to is null and r.category not in ('business', 'platform')`,
        [users.p32.personId],
    );
    assert.equal(platform.n, 0, 'p32 只持有業務類或平台類角色');
    const quiet = await Promise.all(people.map((id) => notified('passkey.holder_suspended', id)));
    assert.equal((await call(app, 'passkey_revoke_self', users.p32.session, '手機遺失')).suspended, 1);
    assert.deepEqual(await holderExceptions('K-PASSKEY-SUSPEND-HOLDER', users.p32.personId), []);
    assert.deepEqual(await Promise.all(people.map((id) => notified('passkey.holder_suspended', id))), quiet);
});
