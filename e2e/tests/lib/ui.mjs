// 端對端共用：每個人一個手機尺寸的瀏覽器環境（各自帶虛擬通行金鑰驗證器）、真的 Dex 登入、
// 走畫面填申請、走畫面做決定、版面自動檢查（ux-acceptance 第 3 節：390px 沒有水平捲動、觸控目標 44px）。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { approveEnrollment, call, closePools, pool, rememberKey, settlePasskey } from '../../../db/tests/kernel/lib/harness.mjs';
import { loadConfig } from '../../../db/tools/lib/env.mjs';
import { groupedCode, shortCode } from '../../../web/lib/signing.js';

const config = loadConfig();
/** 頁面的來源（瀏覽器開的網址）；後端在另一個來源，只回 JSON（裁決 D68）。 */
export const ORIGIN = config.db.SGN_WEB_ORIGIN;
export const API = config.db.SGN_RP_ORIGIN;
const PASSWORD = config.ldap.SIM_LDAP_USER_PASSWORD;
// 登記人的背書走資料庫（測試扮演登記人的瀏覽器；harness 的 registrar），端對端只在專門的測試裡走畫面背書
const app = pool('APP');

let browser;
const people = {};

export async function startBrowser() {
    browser = await chromium.launch();
    return browser;
}

export async function stopBrowser() {
    await browser?.close();
    await closePools();
}
export const theBrowser = () => browser;

/** 營業日期（Asia/Taipei），YYYY-MM-DD；可加減月數與天數。 */
export function day(months = 0, days = 0) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + months);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** 一個人一個瀏覽器環境（手機尺寸），各自帶一個虛擬通行金鑰驗證器。同一個人只建立一次。 */
export async function person(uid) {
    if (people[uid]) return people[uid];
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW' });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
    });
    const p = { uid, page, cdp, authenticatorId, registered: false };
    people[uid] = p;
    return p;
}

/** 走真的 Dex 登入頁。 */
export async function dexLogin(page, uid) {
    await page.waitForURL(/127\.0\.0\.1:5556\/dex/);
    await page.fill('#login', uid);
    await page.fill('#password', PASSWORD);
    await page.click('#submit-login');
    await page.waitForURL(`${ORIGIN}/**`);
}

export async function login(p) {
    await p.page.goto(ORIGIN);
    await p.page.click('[data-testid=login]');
    await dexLogin(p.page, p.uid);
    await p.page.waitForSelector('[data-testid=me]');
    await waitPage(p.page);
    return p;
}

export async function loggedIn(uid) {
    const p = await person(uid);
    if (!p.loggedIn) {
        await login(p);
        p.loggedIn = true;
    }
    return p;
}

/** 等頁面畫完（不在「載入中」）。 */
export const waitPage = (page) => page.waitForSelector('main[data-page]');

export async function home(p) {
    await p.page.goto(`${ORIGIN}/#`);
    await p.page.reload();
    await waitPage(p.page);
}

/** 在頁面裡直接打後端（模擬「拿到工作階段的人」繞過畫面）。後端在另一個來源，帶 cookie。 */
export async function callApi(page, path, body = {}) {
    return page.evaluate(
        async ({ url, body }) => {
            const r = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { status: r.status, ...(await r.json()) };
        },
        { url: `${API}${path}`, body },
    );
}

/** 這個人在瀏覽器裡的工作階段代碼（cookie）；測試用它在資料庫那一側扮演同一個人。 */
export async function sessionOf(p) {
    const sid = (await p.page.context().cookies(API)).find((c) => c.name === 'sid');
    return { session: sid.value, uid: p.uid };
}

/** 手機版面的自動檢查：沒有水平捲動、可點擊元素至少 44×44。 */
export async function layoutProblems(page, label) {
    const problems = await page.evaluate(() => {
        const out = [];
        if (document.documentElement.scrollWidth > window.innerWidth) out.push(`水平捲動 ${document.documentElement.scrollWidth}px`);
        for (const node of document.querySelectorAll('button, input, select, textarea, a, summary')) {
            const r = node.getBoundingClientRect();
            if (r.width > 0 && (r.width < 44 || r.height < 44))
                out.push(`${node.tagName} "${(node.textContent || node.id).trim().slice(0, 12)}" ${r.width}x${r.height}`);
        }
        return out;
    });
    return problems.map((p) => `${label}: ${p}`);
}

/**
 * 在畫面上登記通行金鑰：瀏覽器建立金鑰 → Dex 再驗證一次 → 資料庫建立待核准的登記。
 * 回傳新裝置畫面上顯示的 12 位數核對碼（分組的樣子）與完整指紋（QR 碼的內容；裁決 D76）。
 */
export async function requestPasskeyInUi(p) {
    await p.page.locator('[data-testid=passkey-missing] button').first().click();
    await dexLogin(p.page, p.uid);
    await p.page.waitForSelector('#flash.ok');
    await waitPage(p.page);
    const code = p.page.locator('[data-testid=passkey-pending] [data-testid=short-code]');
    await code.filter({ hasText: /^\d{4} \d{4} \d{4}$/ }).waitFor();
    const fingerprint = (await p.page.textContent('[data-testid=passkey-pending] [data-testid=device-fingerprint]'))
        .replace(/^[^：]*：/, '')
        .replace(/\s/g, '');
    return { code: (await code.textContent()).trim(), fingerprint };
}

/** 瀏覽器虛擬驗證器裡的這把金鑰（私鑰），記成這個人的舊金鑰（之後的測試或攻擊腳本扮演本人用它核准新金鑰；D76）。 */
async function rememberBrowserKey(p, personId, credentialIdB64url) {
    const { credentials } = await p.cdp.send('WebAuthn.getCredentials', { authenticatorId: p.authenticatorId });
    const cred = credentials.find((c) => Buffer.from(c.credentialId, 'base64').toString('base64url') === credentialIdB64url);
    if (cred) rememberKey(personId, null, { privateKeyPkcs8: cred.privateKey, credentialId: credentialIdB64url });
}

/**
 * 第一次要做決定的人：畫面上登記（待核准）→ 核准（D76：第一把由登記人背書，看新裝置畫面上的完整指紋；
 * 本人已有舊金鑰就用舊金鑰）→ 模擬冷卻期已過 → 重新整理。畫面有提示才做。
 */
export async function ensurePasskey(p) {
    const notice = p.page.locator('[data-testid=passkey-missing] button');
    if ((await notice.count()) === 0) return false;
    const shown = await requestPasskeyInUi(p);
    const user = { ...(await sessionOf(p)) };
    const me = await call(app, 'me', user.session);
    const [pending] = me.passkey_pending;
    assert.equal(
        groupedCode(await shortCode(pending.display.public_key_sha256, pending.code_cost)),
        shown.code,
        '清單上的指紋算出的核對碼和本人畫面上的一樣',
    );
    await approveEnrollment(app, { ...user, personId: me.person_id }, pending.enrollment_id, { fingerprint: shown.fingerprint });
    await settlePasskey(app, { credentialId: Buffer.from(pending.credential_id, 'base64url') });
    await rememberBrowserKey(p, me.person_id, pending.credential_id);
    await p.page.reload();
    await waitPage(p.page);
    return true;
}

export const principalIds = async (page) =>
    Object.fromEntries((await callApi(page, '/api/principal_list')).result.map((x) => [x.name, x.principal_id]));

/**
 * 在新申請畫面填一張申請。spec：{ principal, from, to, packages: { 代碼: { fields, filters: { 條件: [值] } } },
 * period: {from, to}, purpose, description, exportAllowed }。回傳時即時檢查已經更新完。
 */
export async function fillApplication(p, spec) {
    const { page } = p;
    const ids = await principalIds(page);
    await page.selectOption('#f-principal', ids[spec.principal]);
    await page.fill('#f-valid-from', spec.from);
    await page.fill('#f-valid-to', spec.to);
    for (const [pkg, item] of Object.entries(spec.packages)) {
        for (const field of item.fields) await page.check(`#f-${pkg}-f-${field}`);
        for (const [filter, values] of Object.entries(item.filters ?? {}))
            for (const value of values) await page.check(`#f-${pkg}-r-${filter}-${value}`);
    }
    if (spec.period) {
        await page.fill('#f-period-from', spec.period.from);
        await page.fill('#f-period-to', spec.period.to);
    }
    await page.selectOption('#f-purpose', spec.purpose ?? 'reporting');
    await page.fill('#f-purpose-text', spec.description ?? '例行分析');
    if (spec.exportAllowed) await page.check('#f-export');
    await checkSettled(page);
}

/** 等即時檢查（草稿版本）存好、畫面更新完。 */
export async function checkSettled(page) {
    await page.waitForFunction(() => {
        const box = document.querySelector('[data-testid=check]');
        return box && !box.dataset.busy && box.querySelector('[data-testid=path]');
    });
}

export async function openNew(p) {
    await home(p);
    await p.page.click('[data-testid=new-case]');
    await p.page.waitForSelector('[data-testid=apply-form]');
}

/** 先藏起舊的提示，做完動作後等新的提示出現；回傳 { ok, text }。 */
export async function flashAfter(page, action) {
    await page.evaluate(() => {
        document.getElementById('flash').hidden = true;
    });
    await action();
    await page.waitForSelector('#flash:not([hidden])');
    return { ok: (await page.locator('#flash.ok').count()) > 0, text: await page.textContent('#flash') };
}

/** 按「送出申請」，回傳單號與提示文字；送不出時拋出畫面上的錯誤訊息。 */
export async function submitForm(p, reason = null) {
    if (reason) await p.page.fill('#f-overlap-reason', reason);
    const { ok, text } = await flashAfter(p.page, () => p.page.click('[data-testid=submit]'));
    if (!ok) throw new Error(`送不出：${text}`);
    return { caseNo: Number(/單號 (\d+)/.exec(text)[1]), text };
}

export async function apply(uid, spec) {
    const p = await loggedIn(uid);
    await openNew(p);
    await fillApplication(p, spec);
    return submitForm(p, spec.overlapReason);
}

/** 從首頁的清單打開一張單。 */
export async function openFromHome(p, caseNo) {
    await home(p);
    await ensurePasskey(p);
    await p.page.click(`[data-case-no="${caseNo}"]`);
    await p.page.waitForSelector('[data-testid=decision-facts]');
}

/** 在詳情頁做一個決定：按按鈕 →（填原因）→ 用通行金鑰確認，等首頁顯示結果。 */
export async function decideHere(p, decision, reason = null) {
    await p.page.click(`[data-action=${decision}]`);
    if (reason !== null) await p.page.fill('[data-testid=decision-reason]', reason);
    const { ok, text } = await flashAfter(p.page, () => p.page.click('[data-testid=confirm-passkey]'));
    if (!ok) throw new Error(`決定失敗：${text}`);
    return text;
}

/** 從待辦做決定；需要認領的先認領。 */
export async function decide(uid, caseNo, decision = 'approve', reason = null) {
    const p = await loggedIn(uid);
    await openFromHome(p, caseNo);
    if ((await p.page.locator('[data-action=claim]').count()) > 0) {
        await p.page.click('[data-action=claim]');
        await p.page.waitForSelector(`[data-action=${decision}]`);
    }
    return decideHere(p, decision, reason);
}

export async function caseByNo(p, caseNo, path = '/api/case_list_mine') {
    const list = (await callApi(p.page, path)).result;
    const found = list.find((c) => c.case_no === caseNo);
    return found ? (await callApi(p.page, '/api/case_get', { case_id: found.case_id })).result : null;
}
