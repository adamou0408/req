// mail port 的 SMTP adapter（工程規範第 2 節：對外系統一律走 port 與 adapter）。只用 node:net：
// 開發環境的 sim/mail（Mailpit）不需要 TLS 與帳密；正式環境要換成支援 STARTTLS 與驗證的 adapter，通過同一份合約測試
// （db/tests/kernel/86-notification-mail.test.mjs）。主旨以 RFC 2047、內文以 base64 編碼 UTF-8，繁體中文不會亂碼。
import { connect, type Socket } from 'node:net';

export type MailMessage = { from: string; to: string; toName: string; subject: string; body: string };

/** mail port：寄出一封信，失敗就丟錯。 */
export type MailPort = { send(message: MailMessage): Promise<void> };

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const encodedWord = (text: string) => `=?UTF-8?B?${b64(text)}?=`;
const address = (value: string) => value.replace(/[<>\r\n]/g, '');

/** 讀到一個完整的 SMTP 回應（最後一行是「三位數字＋空白」），回傳狀態碼。 */
function reply(socket: Socket): Promise<number> {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const onData = (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const last = buffer.split('\r\n').filter(Boolean).at(-1) ?? '';
            if (!/^\d{3} /.test(last) || !buffer.endsWith('\r\n')) return;
            socket.off('data', onData);
            socket.off('error', reject);
            resolve(Number(last.slice(0, 3)));
        };
        socket.on('data', onData);
        socket.once('error', reject);
    });
}

async function step(socket: Socket, line: string | null, expected: number): Promise<void> {
    const pending = reply(socket);
    if (line !== null) socket.write(`${line}\r\n`);
    const code = await pending;
    if (Math.floor(code / 100) !== Math.floor(expected / 100)) throw new Error(`SMTP ${line ?? 'greeting'}: ${code}`);
}

function messageText(m: MailMessage): string {
    const body = b64(m.body).replace(/.{1,76}/g, '$&\r\n');
    return [
        `From: ${address(m.from)}`,
        `To: ${encodedWord(m.toName)} <${address(m.to)}>`,
        `Subject: ${encodedWord(m.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        body,
    ].join('\r\n');
}

export function smtpMailer(server: { host: string; port: number }): MailPort {
    return {
        async send(m) {
            const socket = connect(server.port, server.host);
            try {
                await step(socket, null, 220);
                await step(socket, 'EHLO sgn', 250);
                await step(socket, `MAIL FROM:<${address(m.from)}>`, 250);
                await step(socket, `RCPT TO:<${address(m.to)}>`, 250);
                await step(socket, 'DATA', 354);
                await step(socket, `${messageText(m)}\r\n.`, 250);
                await step(socket, 'QUIT', 221);
            } finally {
                socket.destroy();
            }
        },
    };
}
