/**
 * Outbox worker：輪詢寄信佇列 → 寄信 → 標記結果。
 * 佇列本身（哪些信該寄、狀態、重試次數）由 SQL function 管；這裡只負責「把信寄出去」。
 * 寄送保證是「至少一次」：寄出後、標記前如果當掉，那封信會再寄一次。
 */
import type { Config } from '../config.ts';
import type { OutboxMessage, SystemCalls } from '../contract/systemCalls.ts';
import type { MailPort } from '../ports/mail.ts';
import type { LeaderLock } from './leaderLock.ts';
import { PollLoop, type LoopLogger } from './pollLoop.ts';

export interface OutboxWorkerDeps {
  sys: Pick<SystemCalls, 'outboxClaim' | 'outboxMarkSent' | 'outboxMarkFailed'>;
  mail: MailPort;
  lock: Pick<LeaderLock, 'ensure'>;
  log: LoopLogger;
  config: Pick<Config, 'outboxIntervalSec' | 'outboxBatchSize' | 'outboxRetryBaseSec' | 'outboxRetryMaxSec'>;
}

/** 第 n 次失敗後隔多久再試：base × 2^n，不超過 max。 */
export function retryAfterSec(attempts: number, baseSec: number, maxSec: number): number {
  const n = Math.max(0, Math.min(attempts, 30));
  return Math.min(baseSec * 2 ** n, maxSec);
}

/** 錯誤訊息只留前面一段，避免把整封信或連線字串寫進資料庫。 */
function shortError(err: unknown): string {
  const e = err as { code?: unknown; responseCode?: unknown; message?: unknown };
  const parts = [e?.code, e?.responseCode, e?.message].filter((p) => p !== undefined && p !== null);
  return (parts.length > 0 ? parts.join(' ') : String(err)).slice(0, 300);
}

export class OutboxWorker {
  private readonly deps: OutboxWorkerDeps;
  private readonly loop: PollLoop;

  constructor(deps: OutboxWorkerDeps) {
    this.deps = deps;
    this.loop = new PollLoop({
      name: 'outbox',
      intervalMs: deps.config.outboxIntervalSec * 1000,
      maxBackoffMs: Math.max(deps.config.outboxIntervalSec * 1000, 5 * 60_000),
      tick: () => this.tick(),
      log: deps.log,
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** 跑一輪。回 true 代表這一批是滿的，可能還有信，馬上再跑。 */
  async tick(): Promise<boolean> {
    const { sys, lock, log, config } = this.deps;
    if (!(await lock.ensure())) return false;
    const batch = await sys.outboxClaim(config.outboxBatchSize);
    let sent = 0;
    let failed = 0;
    for (const message of batch) {
      if (await this.deliver(message)) sent += 1;
      else failed += 1;
    }
    if (batch.length > 0) log.info({ worker: 'outbox', sent, failed }, 'outbox 處理完一批');
    // 整批都失敗多半是郵件伺服器有問題，不要馬上再領下一批。
    return batch.length >= config.outboxBatchSize && sent > 0;
  }

  private async deliver(message: OutboxMessage): Promise<boolean> {
    const { sys, mail, log, config } = this.deps;
    let ref: string | null;
    try {
      if (message.to.length === 0) throw new Error('沒有收件人');
      ({ ref } = await mail.send({
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        text: message.text,
        html: message.html,
      }));
    } catch (err) {
      const wait = retryAfterSec(message.attempts, config.outboxRetryBaseSec, config.outboxRetryMaxSec);
      const error = shortError(err);
      // 不記收件人與內容，只記編號。
      log.warn({ worker: 'outbox', outbox_id: message.id, attempts: message.attempts + 1, retry_after_sec: wait, err: error }, '寄信失敗');
      await sys.outboxMarkFailed(message.id, error, wait);
      return false;
    }
    await sys.outboxMarkSent(message.id, ref);
    return true;
  }
}
