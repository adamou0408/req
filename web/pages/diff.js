// 「與前一版的差異」：和看的人上次決定的那一版（或最近一次有人決定的那一版）比較；新申請在草稿期間的逐次儲存不算「前一版」。
// 這裡只把兩份內容的不同列出來給人看；這次修改算縮小還是擴大，一律顯示資料庫記下的 change_kind。
import { t } from '../i18n.js';
import { el } from '../ui.js';

/**
 * 比較的基準：看的人自己上次做決定的那一版；他沒決定過，就用任何人最近一次做決定的那一版（比目前版本舊的）。
 * 都沒有就是新申請。只比對姓名來挑基準，不影響任何權限或判定。
 */
function baselineVersion(c, viewerName) {
    const tasks = c.stages.flatMap((s) => s.tasks).filter((x) => x.decided_version !== null && x.decided_version < c.version);
    const mine = tasks.filter((x) => x.assignee_name === viewerName).map((x) => x.decided_version);
    const any = tasks.map((x) => x.decided_version);
    if (mine.length) return Math.max(...mine);
    return any.length ? Math.max(...any) : null;
}

function termsDiff(before, after) {
    const out = [];
    if (before.principal?.principal_id !== after.principal?.principal_id)
        out.push(t.termsDiff.principal(before.principal?.name ?? '—', after.principal?.name ?? '—'));
    if (before.valid_from !== after.valid_from) out.push(t.termsDiff.from(before.valid_from ?? '—', after.valid_from ?? '—'));
    if (before.valid_to !== after.valid_to) out.push(t.termsDiff.to(before.valid_to ?? '—', after.valid_to ?? '—'));
    return out;
}

/** 這段期間內由申請人以外的人做的縮小（簽核人縮小後核准）。 */
function reducers(c, since) {
    return c.versions.filter((v) => v.version > since && v.change_kind === 'reduce' && v.created_by_name !== c.applicant_name);
}

export function versionDiff(c, pack, cat, viewerName) {
    const since = baselineVersion(c, viewerName);
    if (since === null) return el('span', { 'data-testid': 'diff', 'data-diff': 'new' }, t.noPrevious);
    const before = c.versions.find((v) => v.version === since);
    const now = c.versions.find((v) => v.version === c.version);
    const lines = [...termsDiff(before.terms, now.terms), ...pack.contentDiff(cat, before.content, now.content)];
    const by = reducers(c, since).at(-1);
    return el(
        'div',
        { 'data-testid': 'diff', 'data-diff': lines.length ? 'changed' : 'same' },
        by
            ? el('p', { class: 'warn-text', 'data-testid': 'reduced-by' }, t.reducedBy(by.created_by_name, by.version))
            : el('p', {}, t.diffSince(since)),
        lines.length
            ? el(
                  'ul',
                  {},
                  lines.map((l) => el('li', {}, l)),
              )
            : el('p', {}, t.noDiff),
    );
}
