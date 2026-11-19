/** Mail port：寄通知信。 */
export interface MailMessage {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string | null;
}

export interface MailPort {
  readonly mode: 'console' | 'smtp';
  /** 寄出後回傳郵件伺服器給的識別碼（沒有就 null）。寄不出去就丟例外。 */
  send(message: MailMessage): Promise<{ ref: string | null }>;
  close(): Promise<void>;
}
