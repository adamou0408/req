/** 依設定啟動 outbox worker 與 scheduler；兩個各自用一把 advisory lock。 */
import type { Config } from '../config.ts';
import type { SystemCalls } from '../contract/systemCalls.ts';
import type { MailPort } from '../ports/mail.ts';
import { LeaderLock, LOCK_OUTBOX, LOCK_SCHEDULER } from './leaderLock.ts';
import { OutboxWorker } from './outbox.ts';
import type { LoopLogger } from './pollLoop.ts';
import { Scheduler } from './scheduler.ts';

export interface Workers {
  /** 等正在跑的那一輪結束，並放掉鎖。 */
  stop(): Promise<void>;
}

export function startWorkers(deps: { config: Config; sys: SystemCalls; mail: MailPort; log: LoopLogger }): Workers {
  const { config, sys, mail, log } = deps;
  const stoppers: Array<() => Promise<void>> = [];

  if (config.outboxEnabled) {
    const lock = new LeaderLock(config.databaseUrl, LOCK_OUTBOX);
    const worker = new OutboxWorker({ sys, mail, lock, log, config });
    worker.start();
    stoppers.push(async () => {
      await worker.stop();
      await lock.release();
    });
  } else {
    log.info({ worker: 'outbox' }, 'worker 已用 OUTBOX_ENABLED=false 關閉');
  }

  if (config.schedulerEnabled) {
    const lock = new LeaderLock(config.databaseUrl, LOCK_SCHEDULER);
    const scheduler = new Scheduler({ sys, lock, log, config });
    scheduler.start();
    stoppers.push(async () => {
      await scheduler.stop();
      await lock.release();
    });
  } else {
    log.info({ worker: 'scheduler' }, 'worker 已用 SCHEDULER_ENABLED=false 關閉');
  }

  return {
    async stop() {
      await Promise.all(stoppers.map((s) => s()));
    },
  };
}
