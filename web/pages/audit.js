// 稽核證據頁：瀏覽器自己重算整條雜湊鏈、比對外部錨點、重驗每個決定的通行金鑰簽章（verify.js），
// 列出這張單完整的多關卡紀錄（每一關開始、認領、每個決定、縮小、核准完成、套用、生效）。
import { api } from '../api.js';
import { t } from '../i18n.js';
import { packOf } from '../packs/index.js';
import { verifyCase } from '../verify.js';
import { programHealth } from './home.js';
import { dateText, el, explain, facts, go, stateBadge, tierBadge } from '../ui.js';

async function stageNames() {
    const types = await api.call('process_type_list');
    return new Map(types.flatMap((x) => x.tiers.flatMap((tier) => tier.stages.map((s) => [`${x.code}:${s.code}`, s.name]))));
}

function eventLine(e, names, processType) {
    const data = e.parsed.data ?? {};
    const stage = data.stage ? (names.get(`${processType}:${data.stage}`) ?? '') : '';
    return el(
        'li',
        { 'data-type': e.parsed.type, 'data-anchored': String(e.anchored) },
        el('strong', {}, t.eventType[e.parsed.type] ?? t.exceptionUnknown),
        stage ? `「${stage}」` : '',
        `・${e.actor_name ?? '—'}・${dateText(e.parsed.at)}`,
        data.version ? `・第 ${data.version} 版` : '',
        data.proof_kind ? `・${t.proofKind[data.proof_kind]}` : '',
        e.anchored ? null : el('span', { class: 'badge state-draft', 'data-testid': 'unanchored' }, t.notAnchored),
        el('div', { class: 'mono muted' }, `#${e.seq} ${e.hash.slice(0, 16)}`),
    );
}

function resultView(v) {
    const headline = { ok: t.auditOk, warn: t.auditUnanchored(v.unanchored), bad: t.auditBad }[v.status];
    return [
        el('div', {}, headline),
        el(
            'ul',
            { 'data-testid': 'audit-problems' },
            v.problems.map((p) => el('li', {}, p)),
        ),
        el(
            'details',
            {},
            el('summary', {}, t.auditChecks),
            el(
                'ul',
                {},
                v.checks.map((c) => el('li', {}, c)),
            ),
        ),
    ];
}

export async function renderAudit(ctx, caseNo) {
    const result = el('div', { class: 'result warn', 'data-testid': 'audit-result', 'data-status': 'pending' }, t.auditVerifying);
    const body = el('div');
    const fill = async () => {
        result.className = 'result warn';
        result.dataset.status = 'pending';
        result.textContent = t.auditVerifying;
        try {
            const [audit, names] = await Promise.all([api.call('audit_case', { case_no: caseNo }), stageNames()]);
            const v = await verifyCase(api, audit);
            result.className = `result ${v.status}`;
            result.dataset.status = v.status;
            result.replaceChildren(...resultView(v));
            const c = audit.case;
            body.replaceChildren(
                el('button', { onclick: fill }, t.auditVerifyAgain),
                el(
                    'div',
                    { class: 'card' },
                    el('p', {}, tierBadge(c.tier), ' ', stateBadge(c.state)),
                    facts([
                        [t.applicant, c.applicant_name],
                        [t.grantee, c.terms.principal?.name ?? '—'],
                        [t.validity, t.validRange(c.terms.valid_from, c.terms.valid_to)],
                        // 使用情形（D92 (4)：使用方系統回報的批次摘要；資料庫算好）
                        [
                            t.usage.title,
                            el(
                                'span',
                                { 'data-testid': 'audit-usage' },
                                audit.usage ? `${t.usage.last(audit.usage.last_used_text)}・${t.usage.recent(audit.usage)}` : t.usage.none,
                            ),
                        ],
                    ]),
                ),
                c.overdue
                    ? el('div', { class: 'result bad', 'data-testid': 'overdue', 'data-kind': c.overdue.kind }, t.overdue.box(c.overdue))
                    : null,
                c.exceptions.length
                    ? el(
                          'div',
                          { class: 'result warn', 'data-testid': 'case-exceptions' },
                          c.exceptions.map((x) =>
                              el(
                                  'p',
                                  {},
                                  packOf(c.process_type)?.exceptionText?.(x.rule_code) ?? t.exception[x.rule_code] ?? t.exceptionUnknown,
                              ),
                          ),
                      )
                    : null,
                el('h2', {}, t.auditEvents),
                el(
                    'ol',
                    { class: 'events', 'data-testid': 'audit-events' },
                    v.events.map((e) => eventLine(e, names, c.process_type)),
                ),
            );
        } catch (err) {
            result.className = 'result bad';
            result.dataset.status = 'error';
            result.textContent = explain(err);
        }
    };
    await fill();
    // 背景程式的存活：稽核頁打開就檢查一次（裁決 D88 (3)：不只靠被檢查的程式）
    return [
        el('button', { onclick: () => go('#') }, `← ${t.home}`),
        await programHealth(),
        el('h2', {}, `${t.caseNo} ${caseNo}`),
        result,
        body,
    ];
}
