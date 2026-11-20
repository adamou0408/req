// 通知寄送程式的入口（裁決 D76）：每一輪由 api/src/notify.ts 領走待寄的通知、經 SMTP adapter 寄出、回報結果。
// 用法：node api/src/mailer.ts              寄一輪
//       node api/src/mailer.ts --every 5    每 5 秒寄一輪（常駐；tools/run-all.sh 啟動）
// 設定只讀自己的（裁決 D81 (1)）：.run/secrets/mailer.env（sgn_job 的密碼）與 sim/mail 的位址。
import pg from 'pg';
import { loadProgramConfig, programDbUrl, simServiceEnv } from '../../db/tools/lib/env.mjs';
import { PROGRAMS } from '../../db/tools/lib/programs.mjs';
import { deliverPending } from './notify.ts';
import { smtpMailer } from './smtp.ts';

type ProgramConfig = { db: Record<string, string>; secret: Record<string, string>; database: string };
const env = loadProgramConfig('mailer') as ProgramConfig;
const mailEnv = simServiceEnv('mail') as Record<string, string>;
/** 通知寄送程式：以排程帳號連線，經 SMTP 寄出（開發環境是 sim/mail 的 Mailpit）。 */
const mailerConfig = {
    dbUrl: programDbUrl(env, PROGRAMS.mailer.roleKey) as string,
    smtp: { host: mailEnv.SIM_MAIL_SMTP_HOST, port: Number(mailEnv.SIM_MAIL_SMTP_PORT) },
    from: env.db.SGN_MAIL_FROM,
};

const db = new pg.Pool({ connectionString: mailerConfig.dbUrl, max: 2 });
const mail = smtpMailer(mailerConfig.smtp);
const everyIndex = process.argv.indexOf('--every');
const once = async () =>
    console.log(JSON.stringify({ at: new Date().toISOString(), ...(await deliverPending(db, mail, mailerConfig.from)) }));

await once();
if (everyIndex > 0) setInterval(() => once().catch((err: unknown) => console.error(err)), Number(process.argv[everyIndex + 1]) * 1000);
else await db.end();
