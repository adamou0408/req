import nodemailer, { type Transporter } from 'nodemailer';
import type { SmtpConfig } from '../../config.ts';
import type { MailMessage, MailPort } from '../mail.ts';

/** 透過公司的 mail server 寄信（SMTP_URL 例：smtp://user:pass@mail.example.com:587）。 */
export class SmtpMail implements MailPort {
  readonly mode = 'smtp' as const;
  private readonly from: string;
  private readonly transport: Transporter;

  constructor(config: SmtpConfig) {
    this.from = config.from;
    this.transport = nodemailer.createTransport({
      url: config.url,
      pool: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(message: MailMessage): Promise<{ ref: string | null }> {
    const info: { messageId?: unknown } = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      cc: message.cc && message.cc.length > 0 ? message.cc : undefined,
      subject: message.subject,
      text: message.text,
      html: message.html ?? undefined,
    });
    return { ref: typeof info.messageId === 'string' ? info.messageId : null };
  }

  async close(): Promise<void> {
    this.transport.close();
  }
}
