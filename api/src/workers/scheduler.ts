/**
 * Scheduler：定時呼叫 api.run_scheduled_jobs。
 * 要做哪些事（催辦、升級、到期失效、自動撤銷…）全部由那個 SQL function 決定。
 */
import type { Config } from '../config.ts';
import type { SystemCalls } from '../contract/systemCalls.ts';
import type { LeaderLock } from './leaderLock.ts';
import { PollLoop, type LoopLogger } from './pollLoop.ts';

export interface SchedulerDeps {
  sys: Pick<SystemCalls, 'runScheduledJobs'>;
  lock: Pick<LeaderLock, 'ensure'>;
  log: LoopLogger;
  config: Pick<Config, 'schedulerIntervalSec'>;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly loop: PollLoop;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    const intervalMs = deps.config.schedulerIntervalSec * 1000;
    this.loop = new PollLoop({
      name: 'scheduler',
      intervalMs,
      maxBackoffMs: Math.max(intervalMs, 10 * 60_000),
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

  async tick(): Promise<void> {
    const { sys, lock, log } = this.deps;
    if (!(await lock.ensure())) return;
    const started = Date.now();
    const result = await sys.runScheduledJobs();
    log.debug({ worker: 'scheduler', ms: Date.now() - started, result }, '排程工作執行完成');
  }
}
