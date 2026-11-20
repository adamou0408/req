// 登出（K-SESSION）：資料庫裡的工作階段要立即失效，不是只清掉瀏覽器的 cookie。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { call, closePools, login, one, pool, PROBE, rejectsWith } from './lib/harness.mjs';

const app = pool('APP');
const admin = pool('ADMIN');
after(closePools);

test('K-SESSION 登出後同一個工作階段代碼一律 SESSION_INVALID；登出可以重複按；登出寫進鏈', async () => {
    const user = await login(app, 'p04');
    const other = await login(app, 'p04');
    assert.equal((await call(app, 'me', user.session)).name, '林怡君');

    assert.deepEqual(await call(app, 'session_close', user.session), { closed: true });
    await rejectsWith(call(app, 'me', user.session), 'SESSION_INVALID');
    await rejectsWith(call(app, 'case_submit_new', user.session, PROBE, { a: 1 }, {}, null), 'SESSION_INVALID');
    await rejectsWith(call(app, 'passkey_register_begin', user.session), 'SESSION_INVALID');
    assert.deepEqual(await call(app, 'session_close', user.session), { closed: false });
    assert.deepEqual(await call(app, 'session_close', 'not-a-session'), { closed: false });

    // 只關掉這一個工作階段，同一個人的其他工作階段不受影響
    assert.equal((await call(app, 'me', other.session)).name, '林怡君');

    const event = await one(
        admin,
        `select actor_person_id from sgn.audit_event where event_type = 'session.closed' order by seq desc limit 1`,
    );
    assert.equal(event.actor_person_id, user.personId);
});
