// 「與前一版的差異」：和看的人上次決定的那一版（或最近一次有人決定的那一版）比較。基準版本、它的顯示、誰縮小過，
// 都在資料庫產生的顯示摘要裡（display.baseline、display.reduced_by；裁決 D75），這裡只把兩份顯示的不同列出來。
// 這次修改算縮小還是擴大，一律以資料庫記下的 change_kind 為準。
import { t } from '../i18n.js';
import { el } from '../ui.js';

function termsDiff(before, after) {
    const out = [];
    if (before.principal?.id !== after.principal?.id)
        out.push(t.termsDiff.principal(before.principal?.name ?? '—', after.principal?.name ?? '—'));
    if (before.validity.from !== after.validity.from) out.push(t.termsDiff.from(before.validity.from ?? '—', after.validity.from ?? '—'));
    if (before.validity.to !== after.validity.to) out.push(t.termsDiff.to(before.validity.to ?? '—', after.validity.to ?? '—'));
    return out;
}

export function versionDiff(shown, pack) {
    const before = shown.baseline;
    if (!before) return el('span', { 'data-testid': 'diff', 'data-diff': 'new' }, t.noPrevious);
    const lines = [...termsDiff(before, shown), ...pack.contentDiff(before.content, shown.content)];
    const by = shown.reduced_by;
    return el(
        'div',
        { 'data-testid': 'diff', 'data-diff': lines.length ? 'changed' : 'same' },
        by
            ? el('p', { class: 'warn-text', 'data-testid': 'reduced-by' }, t.reducedBy(by.name, by.version))
            : el('p', {}, t.diffSince(before.version)),
        lines.length
            ? el(
                  'ul',
                  {},
                  lines.map((l) => el('li', {}, l)),
              )
            : el('p', {}, t.noDiff),
    );
}
