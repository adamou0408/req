/**
 * 輪詢迴圈：每隔一段時間跑一次 tick。
 * - tick 回 true 代表「還有工作」，不等待直接再跑一次。
 * - tick 丟例外：記 log，等待時間加倍（退避），直到上限；成功後恢復原本的間隔。
 * - stop() 會等正在跑的那一次 tick 結束。
 */
export interface LoopLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface PollLoopOptions {
  name: string;
  intervalMs: number;
  maxBackoffMs: number;
  tick: () => Promise<boolean | void>;
  log: LoopLogger;
}

export class PollLoop {
  private readonly opts: PollLoopOptions;
  private running: Promise<void> | null = null;
  private stopping = false;
  private wake: (() => void) | null = null;
  private failures = 0;

  constructor(opts: PollLoopOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.running;
    this.running = null;
  }

  /** 下一次要等多久：正常是 interval，連續失敗時加倍到上限。 */
  nextDelayMs(): number {
    if (this.failures === 0) return this.opts.intervalMs;
    return Math.min(this.opts.intervalMs * 2 ** Math.min(this.failures, 20), this.opts.maxBackoffMs);
  }

  private async run(): Promise<void> {
    const { name, log } = this.opts;
    log.info({ worker: name, interval_ms: this.opts.intervalMs }, 'worker 啟動');
    while (!this.stopping) {
      let more = false;
      try {
        more = (await this.opts.tick()) === true;
        this.failures = 0;
      } catch (err) {
        this.failures += 1;
        const e = err as { message?: unknown; code?: unknown };
        log.warn(
          { worker: name, failures: this.failures, retry_in_ms: this.nextDelayMs(), err: String(e?.message ?? err), sqlstate: e?.code },
          'worker 這一輪失敗，稍後重試',
        );
      }
      if (this.stopping) break;
      if (!more) await this.sleep(this.nextDelayMs());
    }
    log.info({ worker: name }, 'worker 停止');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
