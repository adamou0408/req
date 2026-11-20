// 通知寄送程式的入口（裁決 D76）：每一輪由 api/src/notify.ts 領走待寄的通知、經 SMTP adapter 寄出、回報結果。
// 用法：node api/src/mailer.ts              寄一輪
//       node api/src/mailer.ts --every 5    每 5 秒寄一輪（常駐；tools/run-all.sh 啟動）
import pg from 'pg';
import { mailerConfig } from './config.ts';
import { deliverPending } from './notify.ts';
import { smtpMailer } from './smtp.ts';

const db = new pg.Pool({ connectionString: mailerConfig.dbUrl, max: 2 });
const mail = smtpMailer(mailerConfig.smtp);
const everyIndex = process.argv.indexOf('--every');
const once = async () =>
    console.log(JSON.stringify({ at: new Date().toISOString(), ...(await deliverPending(db, mail, mailerConfig.from)) }));

await once();
if (everyIndex > 0) setInterval(() => once().catch((err: unknown) => console.error(err)), Number(process.argv[everyIndex + 1]) * 1000);
else await db.end();
