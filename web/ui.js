// 共用元件：建立節點、提示列、狀態標籤、錯誤說明、底部固定的動作列、確認面板。不含任何業務判斷。
import { ApiFailure } from './api.js';
import { t } from './i18n.js';

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith('on')) node[k] = v;
        else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return node;
}

export function flash(text, ok = false) {
    const box = document.getElementById('flash');
    box.textContent = text;
    box.className = ok ? 'flash ok' : 'flash';
    box.hidden = !text;
}

/** 錯誤一律顯示後端帶回的訊息（來自資料庫的錯誤目錄）；通行金鑰被取消時說明可以重試。 */
export function explain(err) {
    if (err instanceof ApiFailure) return err.message;
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return t.passkeyCancelled;
    console.error(err);
    return t.errorRetry;
}

export const stateBadge = (state) =>
    el('span', { class: `badge state-${state}`, 'data-testid': 'state', 'data-state': state }, t.state[state] ?? state);

export const tierBadge = (tier) => (tier ? el('span', { class: 'badge tier', 'data-testid': 'tier' }, tier) : null);

/** 說明清單：[標題, 內容] 成對。內容為 null 的列不顯示。 */
export function facts(rows, attrs = {}) {
    return el(
        'dl',
        attrs,
        rows
            .filter(([, value]) => value !== null && value !== undefined)
            .map(([label, value]) => [el('dt', {}, label), el('dd', {}, value)]),
    );
}

export const section = (id, title, ...children) =>
    el('section', { 'data-testid': `section-${id}`, 'aria-labelledby': `h-${id}` }, el('h2', { id: `h-${id}` }, title), children);

export const loading = () => el('p', { class: 'muted', role: 'status' }, t.loading);

export const empty = (text) => el('p', { class: 'muted empty', 'data-testid': 'empty' }, text);

/** 底部固定的動作列（手機簽核畫面：主要按鈕隨時按得到）。 */
export function actionBar(buttons) {
    const shown = buttons.filter(Boolean);
    return shown.length ? el('div', { class: 'actions', 'data-testid': 'action-bar' }, shown) : null;
}

/** 從底部滑出的確認面板；回傳面板節點，關閉時移除。focus 移到第一個可輸入或主要按鈕。 */
export function sheet(title, ...children) {
    const panel = el(
        'div',
        { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
        el('div', {}, el('h2', { id: 'sheet-title' }, title), children),
    );
    panel.onkeydown = (event) => {
        if (event.key === 'Escape') panel.remove();
    };
    document.body.append(panel);
    (panel.querySelector('textarea, input, [data-testid=confirm-passkey]') ?? panel.querySelector('button'))?.focus();
    return panel;
}

export const dateText = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—');

let pending = null;

/** 換頁；message 在新頁面畫好之後才顯示（換頁時會先清掉舊的提示）。 */
export const go = (hash, message = null) => {
    pending = message;
    if (location.hash === hash || (hash === '#' && !location.hash)) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = hash;
};

export function takePendingFlash() {
    const message = pending;
    pending = null;
    return message;
}
