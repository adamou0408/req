// 通行金鑰：登記的核准（裁決 D65、D76）與撤銷（K-PASSKEY-REVOKE）。
// 核准：已有金鑰的人由本人用舊金鑰核准；第一把金鑰由本人的主管或登記人背書。都要和新裝置畫面核對完整指紋：
//   當面：用手機相機掃新裝置畫面上的 QR 碼（瀏覽器內建的 BarcodeDetector；沒有就不能掃），掃到的指紋和清單上的一樣才簽；
//   不在場：本人念出新裝置上的 12 位數核對碼，輸入完這個頁面從清單上的指紋自己算一次（慢速雜湊，約一秒），一樣才簽。
//   這筆登記允許哪些方式（methods）由資料庫決定（本人只憑登入撤銷金鑰之後只能當面掃）。
// 簽的內容是清單的顯示摘要（本人、金鑰編號、指紋）加上核對方式與成本，資料庫用自己的紀錄重算（D75）。
// 撤銷：清單與按鈕只依資料庫回傳的 actions；替別人撤銷一律用自己的通行金鑰簽撤銷的顯示摘要加上原因。
// 不是我登記的（K-PASSKEY-NOT-ME）：別人背書、還在冷卻期的新金鑰，本人只憑登入回報，金鑰立即撤銷（只會收回）。
import { api } from '../api.js';
import { passkeyNotice } from '../decide.js';
import { t } from '../i18n.js';
import { fingerprintFromPayload } from '../lib/qr.js';
import { groupedCode, shortCode, signingChallenge } from '../lib/signing.js';
import { dateText, el, empty, explain, facts, go, section, sheet } from '../ui.js';
import { signChallenge } from '../webauthn.js';

const k = t.passkeys;
const SCAN_INTERVAL_MS = 250;

const assertionArgs = (a) => ({
    credential_id: a.credentialId,
    authenticator_data: a.authenticatorData,
    client_data_json: a.clientDataJSON,
    signature: a.signature,
});

/** 背書：method 是 qr（fingerprint＝掃到的指紋）或 code（指紋＝清單上的、頁面算過核對碼的那一個）。 */
async function endorseWithPasskey(e, method, fingerprint) {
    const nonce = await api.call('passkey_endorse_challenge', { enrollment_id: e.enrollment_id, method });
    const content = {
        ...e.display,
        public_key_sha256: fingerprint,
        method,
        code_cost: method === 'code' ? e.code_cost : null,
    };
    const assertion = await signChallenge(
        await signingChallenge({ purpose: 'passkey.enrollment', ref: e.enrollment_id, content, decision: 'endorse', nonce: nonce.nonce }),
    );
    return api.call('passkey_endorse_passkey', { challenge_id: nonce.challenge_id, ...assertionArgs(assertion) });
}

function confirmEndorse(e, method, fingerprint, consequence) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        k.confirmTitle,
        el('p', { 'data-testid': 'consequence' }, consequence),
        error,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'confirm-passkey', onclick: () => run() }, t.confirmWithPasskey),
        ),
    );
    async function run() {
        try {
            await endorseWithPasskey(e, method, fingerprint);
            panel.remove();
            go('#passkeys', { text: k.endorsed, ok: true });
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
}

/** 本人念的碼和這個頁面從指紋算的一樣，才打開確認面板；不一樣就不簽。輸入滿 12 位數就自動核對。 */
async function checkCode(e, input, result) {
    const typed = input.value.replace(/\D/g, '');
    if (typed.length !== 12) {
        result.hidden = true;
        return;
    }
    result.hidden = false;
    result.className = 'result';
    result.textContent = t.passkeyCodeComputing;
    try {
        const expected = await shortCode(e.display.public_key_sha256, e.code_cost);
        if (input.value.replace(/\D/g, '') !== typed) return;
        if (typed !== expected) {
            result.className = 'result bad';
            result.textContent = k.codeMismatch;
            return;
        }
        result.hidden = true;
        confirmEndorse(e, 'code', e.display.public_key_sha256, k.consequence(e.display.person.name, groupedCode(expected)));
    } catch (err) {
        result.className = 'result bad';
        result.textContent = err instanceof RangeError ? t.passkeyCodeUnavailable : explain(err);
    }
}

const canScan = () => typeof globalThis.BarcodeDetector === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * 用相機掃新裝置的 QR 碼：掃到的指紋和清單上的一樣才打開確認面板（簽的是掃到的那一個；資料庫再和自己的紀錄比對）。
 * 掃到別的指紋就停下來警告，不簽。
 */
async function scanQr(e) {
    const status = el('p', { role: 'status', 'data-testid': 'scan-status' }, k.scanHint);
    const video = el('video', { class: 'scanner', autoplay: true, muted: true, playsinline: true, 'data-testid': 'scanner' });
    let stream = null;
    let timer = null;
    const stop = () => {
        clearInterval(timer);
        stream?.getTracks().forEach((track) => track.stop());
        panel.remove();
    };
    const panel = sheet(k.scanTitle, video, status, el('div', { class: 'row sheet-buttons' }, el('button', { onclick: stop }, t.cancel)));
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
        status.className = 'result bad';
        status.textContent = k.scanNoCamera;
        return;
    }
    video.srcObject = stream;
    const detector = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
    timer = setInterval(async () => {
        const found = (await detector.detect(video).catch(() => [])).map((c) => fingerprintFromPayload(c.rawValue)).find(Boolean);
        if (!found) return;
        stop();
        if (found !== e.display.public_key_sha256) {
            const warn = sheet(
                k.scanTitle,
                el('p', { class: 'result bad', role: 'alert', 'data-testid': 'scan-mismatch' }, k.scanMismatch),
                el('div', { class: 'row sheet-buttons' }, el('button', { onclick: () => warn.remove() }, t.cancel)),
            );
            return;
        }
        confirmEndorse(e, 'qr', found, k.consequenceQr(e.display.person.name));
    }, SCAN_INTERVAL_MS);
}

function codeEntry(e) {
    const id = `code-${e.enrollment_id}`;
    const result = el('p', { role: 'status', hidden: true, 'data-testid': 'endorse-check' });
    const input = el('input', { id, inputmode: 'numeric', autocomplete: 'off', 'data-testid': 'endorse-code', maxlength: 14 });
    input.oninput = () => checkCode(e, input, result);
    return [el('label', { for: id }, k.codeLabel), input, result];
}

function endorseControls(e) {
    if (!e.actions.includes('endorse')) return null;
    const qr = e.methods.includes('qr');
    return [
        qr && canScan() ? el('button', { class: 'primary wide', 'data-testid': 'endorse-scan', onclick: () => scanQr(e) }, k.scan) : null,
        qr && !canScan() ? el('p', { class: 'muted', 'data-testid': 'scan-unsupported' }, k.scanUnsupported) : null,
        e.methods.includes('code') ? codeEntry(e) : el('p', { class: 'muted' }, k.qrOnly),
    ];
}

function enrollmentCard(e) {
    return el(
        'div',
        { class: 'card', 'data-testid': 'enrollment-item', 'data-person': e.display.person.name },
        facts([
            [k.person, e.display.person.name],
            [k.requestedAt, dateText(e.requested_at)],
        ]),
        endorseControls(e),
    );
}

// ── 撤銷 ──

/** 用通行金鑰撤銷：簽的是清單（畫面）上的顯示摘要加上原因（去掉前後空白）。 */
async function revokeWithPasskey(row, reason) {
    const nonce = await api.call('passkey_revoke_challenge', { holder_id: row.display.person.id, reason });
    const content = { ...row.display, reason: reason.trim() };
    const assertion = await signChallenge(
        await signingChallenge({
            purpose: 'passkey.revocation',
            ref: row.display.person.id,
            content,
            decision: 'revoke',
            nonce: nonce.nonce,
        }),
    );
    return api.call('passkey_revoke_passkey', { challenge_id: nonce.challenge_id, ...assertionArgs(assertion) });
}

function confirmRevoke(row, action) {
    const self = action === 'revoke_self';
    const n = row.display.credentials.length;
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const reason = el('textarea', { id: 'revoke-reason', rows: 3, 'data-testid': 'revoke-reason', required: true });
    const panel = sheet(
        k.revokeConfirmTitle,
        el('p', { 'data-testid': 'consequence' }, self ? k.revokeSelfConsequence(n) : k.revokeConsequence(row.display.person.name, n)),
        el('label', { for: 'revoke-reason' }, k.revokeReason),
        reason,
        error,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el(
                'button',
                { class: 'primary', 'data-testid': self ? 'confirm-revoke' : 'confirm-passkey', onclick: () => run() },
                self ? k.revokeConfirm : t.confirmWithPasskey,
            ),
        ),
    );
    async function run() {
        try {
            const done = self
                ? await api.call('passkey_revoke_self', { reason: reason.value })
                : await revokeWithPasskey(row, reason.value);
            // 全公司只憑登入的停用超過上限（K-PASSKEY-SUSPEND-FLOOD）：資料庫沒有停用、已開例外，顯示它給的訊息
            if (done.refused) {
                error.textContent = done.refused.message;
                error.hidden = false;
                return;
            }
            panel.remove();
            go('#passkeys', { text: self ? k.suspended(done.suspended) : k.revoked(done.revoked), ok: true });
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
}

/** 一個人的撤銷卡片：本人只給「遺失所有裝置」那一種（只憑登入）；替別人撤銷用通行金鑰確認。依資料庫回傳的 actions。 */
function revocationCard(row) {
    const self = row.actions.includes('revoke_self');
    return el(
        'div',
        { class: 'card', 'data-testid': 'revocation-item', 'data-person': row.display.person.name },
        facts([
            [k.person, row.display.person.name],
            [
                k.keys,
                el(
                    'ul',
                    { class: 'mono' },
                    row.display.credentials.map((c) => el('li', {}, k.keyLine(c))),
                ),
            ],
        ]),
        self
            ? el('button', { class: 'wide', 'data-testid': 'revoke-self', onclick: () => confirmRevoke(row, 'revoke_self') }, k.revokeSelf)
            : el(
                  'button',
                  { class: 'wide', 'data-testid': 'revoke', onclick: () => confirmRevoke(row, 'revoke') },
                  k.revokeOther(row.display.person.name),
              ),
    );
}

// ── 停用的恢復（K-PASSKEY-SUSPEND）：本人用原金鑰簽、主管或登記人背書；簽的都是清單上的顯示摘要 ──

async function restoreWithPasskey(row) {
    const ch = await api.call('passkey_restore_challenge', { suspension_id: row.display.suspension_id });
    const purpose = ch.decision === 'restore' ? 'passkey.restore' : 'passkey.restore_endorse';
    const assertion = await signChallenge(
        await signingChallenge({ purpose, ref: row.display.suspension_id, content: row.display, decision: ch.decision, nonce: ch.nonce }),
    );
    return api.call('passkey_restore_passkey', { challenge_id: ch.challenge_id, ...assertionArgs(assertion) });
}

function confirmRestore(row, action) {
    const self = action === 'restore';
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        k.restoreConfirmTitle,
        el('p', { 'data-testid': 'consequence' }, self ? k.restoreConsequence : k.endorseRestoreConsequence(row.display.person.name)),
        error,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'confirm-passkey', onclick: () => run() }, t.confirmWithPasskey),
        ),
    );
    async function run() {
        try {
            await restoreWithPasskey(row);
            panel.remove();
            go('#passkeys', { text: self ? k.restoreRequested : k.restored, ok: true });
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
}

function suspensionCard(row) {
    const action = ['restore', 'endorse_restore'].find((a) => row.actions.includes(a));
    return el(
        'div',
        { class: 'card', 'data-testid': 'suspension-item', 'data-person': row.display.person.name, 'data-status': row.status },
        facts([
            [k.person, row.display.person.name],
            [k.suspendedAt, dateText(row.display.suspended_at)],
            [
                k.keys,
                el(
                    'ul',
                    { class: 'mono' },
                    row.display.credentials.map((c) => el('li', {}, k.keyLine(c))),
                ),
            ],
        ]),
        el('p', { class: 'muted' }, k.restoreStatus[row.status]),
        action
            ? el(
                  'button',
                  {
                      class: 'primary wide',
                      'data-testid': action === 'restore' ? 'restore' : 'endorse-restore',
                      onclick: () => confirmRestore(row, action),
                  },
                  action === 'restore' ? k.restore : k.endorseRestore(row.display.person.name),
              )
            : null,
    );
}

// ── 不是我登記的（K-PASSKEY-NOT-ME） ──

function confirmNotMe(row) {
    const error = el('p', { class: 'result bad', role: 'alert', hidden: true, 'data-testid': 'decision-error' });
    const panel = sheet(
        k.notMeConfirmTitle,
        el('p', { 'data-testid': 'consequence' }, k.notMeConsequence(row.display.endorsed_by.name)),
        error,
        el(
            'div',
            { class: 'row sheet-buttons' },
            el('button', { onclick: () => panel.remove() }, t.cancel),
            el('button', { class: 'primary', 'data-testid': 'confirm-not-me', onclick: () => run() }, k.notMeConfirm),
        ),
    );
    async function run() {
        try {
            await api.call('passkey_report_not_me', { credential_id: row.display.credential_id });
            panel.remove();
            go('#passkeys', { text: k.notMeDone, ok: true });
        } catch (err) {
            error.textContent = explain(err);
            error.hidden = false;
        }
    }
}

function notMeCard(row) {
    return el(
        'div',
        { class: 'card', 'data-testid': 'not-me-item' },
        facts([
            [k.keys, el('span', { class: 'mono' }, `${row.display.public_key_sha256.slice(0, 16)}…`)],
            [k.endorsedBy, row.display.endorsed_by.name],
            [k.endorsedAt, dateText(row.display.endorsed_at)],
            [k.usableFrom, dateText(row.display.usable_from)],
        ]),
        row.actions.includes('report_not_me')
            ? el('button', { class: 'wide', 'data-testid': 'not-me', onclick: () => confirmNotMe(row) }, k.notMe)
            : null,
    );
}

export async function renderPasskeys(ctx) {
    const [list, revocable, suspended, disownable] = await Promise.all([
        api.call('passkey_enrollment_list'),
        api.call('passkey_revocation_list'),
        api.call('passkey_suspension_list'),
        api.call('passkey_not_me_list'),
    ]);
    return [
        el('a', { href: '#' }, `← ${t.home}`),
        passkeyNotice(ctx.me),
        disownable.length ? section('not-me', k.notMeTitle, el('p', { class: 'muted' }, k.notMeHint), disownable.map(notMeCard)) : null,
        suspended.length
            ? section('restore', k.restoreTitle, el('p', { class: 'muted' }, k.restoreHint), suspended.map(suspensionCard))
            : null,
        section('passkeys', k.title, el('p', { class: 'muted' }, k.hint), list.length ? list.map(enrollmentCard) : empty(k.empty)),
        section(
            'revoke',
            k.revokeTitle,
            el('p', { class: 'muted' }, k.revokeHint),
            revocable.length ? revocable.map(revocationCard) : empty(k.revokeEmpty),
        ),
    ];
}
