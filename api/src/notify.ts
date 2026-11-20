// 通知寄送程式（裁決 D76：冷卻期內的通知要真的寄出）。以寄信帳號 sgn_mailer（裁決 D84 (6)）從資料庫領走待寄的通知
// （api_job.notification_claim：主旨與內文由 sgn.notification_template 產生），經 mail port 寄出，再回報結果
// （api_job.notification_mark）。寄送失敗由資料庫決定重試或標為失敗。
// 執行的入口是 api/src/mailer.ts；這裡是一輪寄送（測試直接呼叫）。
import type pg from 'pg';
import { mailerCalls } from '@sgn/contract';
import type { MailPort } from './smtp.ts';

const BATCH = 50;

type Claimed = { id: number; to_email: string; to_name: string; subject: string; body: string };

/** 寄一輪：領走、寄出、回報。回傳寄出與失敗的筆數。 */
export async function deliverPending(db: pg.Pool, mail: MailPort, from: string): Promise<{ sent: number; failed: number }> {
    const claimed = (await db.query<{ r: Claimed[] }>(`select api_job.${mailerCalls.notificationClaim.fn}($1) as r`, [BATCH])).rows[0].r;
    let sent = 0;
    for (const n of claimed) {
        let error: string | null = null;
        try {
            await mail.send({ from, to: n.to_email, toName: n.to_name, subject: n.subject, body: n.body });
            sent += 1;
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        await db.query(`select api_job.${mailerCalls.notificationMark.fn}($1, $2, $3)`, [n.id, error === null, error]);
    }
    return { sent, failed: claimed.length - sent };
}
