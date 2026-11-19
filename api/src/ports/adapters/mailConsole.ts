import type { MailMessage, MailPort } from '../mail.ts';

export interface ConsoleMailSink {
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * 不真的寄信，只寫一筆 log（開發與測試用）。
 * 另外把最近寄的信留在記憶體裡（sent），方便測試與本機除錯時查看。
 */
export class ConsoleMail implements MailPort {
  readonly mode = 'console' as const;
  readonly sent: MailMessage[] = [];
  private readonly log: ConsoleMailSink;
  private seq = 0;

  constructor(log: ConsoleMailSink) {
    this.log = log;
  }

  async send(message: MailMessage): Promise<{ ref: string | null }> {
    this.seq += 1;
    const ref = `console-${this.seq}`;
    this.sent.push(message);
    if (this.sent.length > 200) this.sent.shift();
    this.log.info(
      { mail: { ref, to: message.to, cc: message.cc ?? [], subject: message.subject, text: message.text } },
      'mail（console 模式，未實際寄出）',
    );
    return { ref };
  }

  async close(): Promise<void> {}
}
