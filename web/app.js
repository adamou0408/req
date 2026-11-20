// 進入點與換頁。網址的 # 決定頁面，清單與詳情之間可以用瀏覽器的上一頁來回。
// 要顯示哪些區塊與按鈕，只依資料庫回傳的 capabilities 與 actions，不自己依狀態或角色推斷。
import { api, ApiFailure } from './api.js';
import { t } from './i18n.js';
import { renderApply } from './pages/apply.js';
import { renderAudit } from './pages/audit.js';
import { renderCase } from './pages/case.js';
import { renderHome } from './pages/home.js';
import { renderPasskeys } from './pages/passkeys.js';
import { renderRoles } from './pages/roles.js';
import { el, explain, flash, loading, takePendingFlash } from './ui.js';

const main = document.getElementById('main');
const ctx = { me: null };

const pages = [
    [/^#new$/, () => renderApply(ctx)],
    [/^#edit\/([0-9a-f-]{36})$/, (m) => renderApply(ctx, m[1])],
    [/^#case\/([0-9a-f-]{36})$/, (m) => renderCase(ctx, m[1])],
    [/^#audit\/(\d+)$/, (m) => renderAudit(ctx, Number(m[1]))],
    [/^#roles$/, () => renderRoles(ctx)],
    [/^#passkeys$/, () => renderPasskeys(ctx)],
];

let rendering = 0;

async function render() {
    const ticket = ++rendering;
    const message = takePendingFlash();
    flash('');
    document.querySelectorAll('.sheet').forEach((s) => s.remove());
    main.replaceChildren(loading());
    try {
        const hit = pages.map(([re, page]) => [location.hash.match(re), page]).find(([m]) => m);
        const nodes = hit ? await hit[1](hit[0]) : await renderHome(ctx);
        if (ticket !== rendering) return;
        main.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
        main.dataset.page = hit ? location.hash.split('/')[0].slice(1) : 'home';
        window.scrollTo(0, 0);
        if (message) flash(message.text, message.ok);
    } catch (err) {
        if (ticket !== rendering) return;
        main.replaceChildren(
            el('p', { class: 'result bad', role: 'alert' }, t.loadFailed(explain(err))),
            el('a', { href: '#' }, `← ${t.home}`),
        );
    }
}

function renderLogin() {
    main.replaceChildren(
        el('p', {}, t.loginHint),
        el('button', { class: 'primary', 'data-testid': 'login', onclick: () => (location.href = api.loginUrl()) }, t.login),
    );
}

function restoreAfterPasskey() {
    try {
        const hash = sessionStorage.getItem('sgn.after-passkey');
        sessionStorage.removeItem('sgn.after-passkey');
        return hash || '';
    } catch {
        return '';
    }
}

/** 網址上的錯誤只收錯誤代碼，文字從錯誤目錄取；不是代碼、目錄裡沒有的一律不顯示（D71：不讓網址放任意文字）。 */
async function loginErrorText(code) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(code ?? '')) return null;
    try {
        return (await api.messages())[code] ?? null;
    } catch {
        return null;
    }
}

async function boot() {
    const params = new URLSearchParams(location.search);
    const registered = params.get('notice') === 'PASSKEY_REGISTERED';
    const loginError = await loginErrorText(params.get('error'));
    if (params.size) history.replaceState(null, '', `/${registered ? restoreAfterPasskey() : location.hash}`);
    try {
        ctx.me = await api.call('me');
    } catch (err) {
        if (err instanceof ApiFailure && err.status === 401) {
            renderLogin();
            if (loginError) flash(loginError);
            return;
        }
        main.replaceChildren(el('p', {}, explain(err)));
        return;
    }
    document
        .getElementById('who')
        .replaceChildren(
            el('span', { 'data-testid': 'me' }, ctx.me.name),
            el('button', { onclick: async () => (await api.logout(), (location.href = '/')) }, t.logout),
        );
    window.addEventListener('hashchange', render);
    await render();
    if (registered) flash(t.passkeyRegistered, true);
    if (loginError) flash(loginError);
}

void boot();
