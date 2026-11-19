import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { allowedFunctions, createSystemCalls, type SystemCalls } from '../src/contract/index.ts';
import { createPool, Db } from '../src/db.ts';
import type { MailMessage, MailPort } from '../src/ports/mail.ts';
import { LeaderLock, LOCK_OUTBOX, LOCK_SCHEDULER } from '../src/workers/leaderLock.ts';
import { startWorkers } from '../src/workers/index.ts';
import { OutboxWorker, retryAfterSec } from '../src/workers/outbox.ts';
import { PollLoop, type LoopLogger } from '../src/workers/pollLoop.ts';
import { Scheduler } from '../src/workers/scheduler.ts';
import { testContract } from './fixtures/testContract.ts';
import { adminPool, baseEnv } from './helpers.ts';

interface LogLine {
  level: string;
  msg: string;
  [k: string]: unknown;
}
function memoryLog(): LoopLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg: string) => void lines.push({ level, msg, ...obj });
  return { lines, info: at('info'), warn: at('warn'), debug: at('debug') };
}

/** 假的郵件伺服器：主旨含 FAIL 的信寄不出去。 */
class FakeMail implements MailPort {
  readonly mode = 'console' as const;
  sent: MailMessage[] = [];
  down = false;
  async send(message: MailMessage): Promise<{ ref: string | null }> {
    if (this.down || message.subject.includes('FAIL')) throw new Error('550 mailbox unavailable');
    this.sent.push(message);
    return { ref: `ref-${this.sent.length}` };
  }
  async close(): Promise<void> {}
}

const alwaysLeader = { ensure: async () => true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等太久了');
    await sleep(20);
  }
}

describe('workers', () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  let sys: SystemCalls;
  const config = loadConfig(
    baseEnv({ OUTBOX_BATCH_SIZE: '2', OUTBOX_RETRY_BASE_SEC: '60', OUTBOX_RETRY_MAX_SEC: '3600', OUTBOX_INTERVAL_SEC: '1', SCHEDULER_INTERVAL_SEC: '1' }),
  );
  const appDbUrl = inject('appDbUrl');

  beforeAll(() => {
    pool = createPool(config);
    admin = adminPool();
    sys = createSystemCalls(new Db(pool, allowedFunctions(testContract)), testContract.sqlNames, null);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  beforeEach(async () => {
    await admin.query('truncate das.outbox restart identity; truncate das.job_runs restart identity');
  });

  const enqueue = async (subject: string, recipients = ['u1@example.test']): Promise<void> => {
    await admin.query('insert into das.outbox (recipients, subject, body_text) values ($1, $2, $3)', [
      recipients,
      subject,
      `內文：${subject}`,
    ]);
  };
  const outbox = async () =>
    (
      await admin.query(
        `select id::int, status, attempts, last_error, provider_ref,
                round(extract(epoch from next_attempt_at - now()))::int as wait_sec
         from das.outbox order by id`,
      )
    ).rows;

  describe('outbox worker', () => {
    it('領信 → 寄出 → 標記已寄', async () => {
      await enqueue('第一封');
      const mail = new FakeMail();
      const log = memoryLog();
      const worker = new OutboxWorker({ sys, mail, lock: alwaysLeader, log, config });
      expect(await worker.tick()).toBe(false);
      expect(mail.sent).toEqual([
        { to: ['u1@example.test'], cc: [], subject: '第一封', text: '內文：第一封', html: null },
      ]);
      expect(await outbox()).toMatchObject([{ status: 'sent', attempts: 0, provider_ref: 'ref-1', last_error: null }]);
      // 沒有信的時候不做事。
      expect(await worker.tick()).toBe(false);
      expect(mail.sent).toHaveLength(1);
    });

    it('寄失敗：記下錯誤、次數加一、依退避排下一次；不影響同一批的其他信', async () => {
      await enqueue('FAIL 壞掉的');
      await enqueue('正常的');
      const mail = new FakeMail();
      const log = memoryLog();
      const worker = new OutboxWorker({ sys, mail, lock: alwaysLeader, log, config });
      await worker.tick();
      const rows = await outbox();
      expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: '550 mailbox unavailable' });
      expect(rows[0].wait_sec).toBeGreaterThanOrEqual(58);
      expect(rows[0].wait_sec).toBeLessThanOrEqual(60);
      expect(rows[1]).toMatchObject({ status: 'sent', attempts: 0 });
      // 還沒到重試時間，不會再領到。
      await worker.tick();
      expect((await outbox())[0].attempts).toBe(1);
      // log 只記編號，不記收件人與內容。
      const warned = log.lines.find((l) => l.msg === '寄信失敗');
      expect(warned).toMatchObject({ outbox_id: '1', attempts: 1, retry_after_sec: 60 });
      expect(JSON.stringify(log.lines)).not.toContain('u1@example.test');
      expect(JSON.stringify(log.lines)).not.toContain('內文');
    });

    it('重試間隔每次加倍，直到上限', async () => {
      expect([0, 1, 2, 3, 5, 6, 7, 50].map((n) => retryAfterSec(n, 60, 3600))).toEqual([
        60, 120, 240, 480, 1920, 3600, 3600, 3600,
      ]);
      await enqueue('FAIL 一直壞');
      const worker = new OutboxWorker({ sys, mail: new FakeMail(), lock: alwaysLeader, log: memoryLog(), config });
      const waits: number[] = [];
      for (let i = 0; i < 3; i++) {
        await worker.tick();
        waits.push((await outbox())[0].wait_sec);
        await admin.query('update das.outbox set next_attempt_at = now()'); // 假裝時間到了
      }
      expect(waits[0]).toBeGreaterThanOrEqual(58);
      expect(waits[1]).toBeGreaterThanOrEqual(118);
      expect(waits[2]).toBeGreaterThanOrEqual(238);
      expect((await outbox())[0].attempts).toBe(3);
    });

    it('沒有收件人的信標記失敗，不會送到郵件伺服器', async () => {
      await enqueue('沒人收', []);
      const mail = new FakeMail();
      await new OutboxWorker({ sys, mail, lock: alwaysLeader, log: memoryLog(), config }).tick();
      expect(mail.sent).toHaveLength(0);
      expect(await outbox()).toMatchObject([{ status: 'pending', attempts: 1, last_error: '沒有收件人' }]);
    });

    it('一批滿了就馬上再領；整批都失敗則不急著再領', async () => {
      for (let i = 1; i <= 3; i++) await enqueue(`信 ${i}`);
      const mail = new FakeMail();
      const worker = new OutboxWorker({ sys, mail, lock: alwaysLeader, log: memoryLog(), config });
      expect(await worker.tick()).toBe(true); // 批次大小 2，領滿
      expect(await worker.tick()).toBe(false);
      expect(mail.sent.map((m) => m.subject)).toEqual(['信 1', '信 2', '信 3']);

      await enqueue('信 4');
      await enqueue('信 5');
      mail.down = true;
      expect(await worker.tick()).toBe(false);
    });

    it('沒拿到鎖就什麼都不做', async () => {
      await enqueue('不該被寄出');
      const mail = new FakeMail();
      const worker = new OutboxWorker({ sys, mail, lock: { ensure: async () => false }, log: memoryLog(), config });
      expect(await worker.tick()).toBe(false);
      expect(mail.sent).toHaveLength(0);
      expect(await outbox()).toMatchObject([{ status: 'pending', attempts: 0 }]);
    });
  });

  describe('scheduler', () => {
    it('每一輪呼叫一次 api.run_scheduled_jobs', async () => {
      const scheduler = new Scheduler({ sys, lock: alwaysLeader, log: memoryLog(), config });
      await scheduler.tick();
      await scheduler.tick();
      const { rows } = await admin.query('select count(*)::int as n from das.job_runs');
      expect(rows[0].n).toBe(2);
    });

    it('沒拿到鎖就不呼叫', async () => {
      const scheduler = new Scheduler({ sys, lock: { ensure: async () => false }, log: memoryLog(), config });
      await scheduler.tick();
      const { rows } = await admin.query('select count(*)::int as n from das.job_runs');
      expect(rows[0].n).toBe(0);
    });
  });

  describe('advisory lock：多個實例只有一個在跑', () => {
    it('第一個拿到鎖，第二個拿不到；第一個放掉後第二個接手', async () => {
      const a = new LeaderLock(appDbUrl, LOCK_OUTBOX);
      const b = new LeaderLock(appDbUrl, LOCK_OUTBOX);
      try {
        expect(await a.ensure()).toBe(true);
        expect(await b.ensure()).toBe(false);
        expect(await a.ensure()).toBe(true); // 重複確認不會出錯
        expect(await b.ensure()).toBe(false);
        expect(a.isHeld).toBe(true);
        expect(b.isHeld).toBe(false);
        await a.release();
        expect(a.isHeld).toBe(false);
        expect(await b.ensure()).toBe(true);
      } finally {
        await a.release();
        await b.release();
      }
    });

    it('不同的 worker 用不同的鎖，互不影響', async () => {
      const outboxLock = new LeaderLock(appDbUrl, LOCK_OUTBOX);
      const schedulerLock = new LeaderLock(appDbUrl, LOCK_SCHEDULER);
      try {
        expect(await outboxLock.ensure()).toBe(true);
        expect(await schedulerLock.ensure()).toBe(true);
      } finally {
        await outboxLock.release();
        await schedulerLock.release();
      }
    });

    it('握鎖的連線被切斷：鎖自動釋放，由別的實例接手；原本的實例之後可以重新排隊', async () => {
      const a = new LeaderLock(appDbUrl, LOCK_OUTBOX);
      const b = new LeaderLock(appDbUrl, LOCK_OUTBOX);
      try {
        expect(await a.ensure()).toBe(true);
        await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'das-api-lock' and datname = current_database()");
        await until(() => !a.isHeld);
        expect(await b.ensure()).toBe(true);
        expect(await a.ensure()).toBe(false); // 重新連線，但鎖已經在 b 手上
      } finally {
        await a.release();
        await b.release();
      }
    });

    it('兩個實例同時跑：每封信只寄一次', async () => {
      for (let i = 1; i <= 6; i++) await enqueue(`信 ${i}`);
      const mail = new FakeMail();
      const lockA = new LeaderLock(appDbUrl, LOCK_OUTBOX);
      const lockB = new LeaderLock(appDbUrl, LOCK_OUTBOX);
      const a = new OutboxWorker({ sys, mail, lock: lockA, log: memoryLog(), config });
      const b = new OutboxWorker({ sys, mail, lock: lockB, log: memoryLog(), config });
      try {
        for (let round = 0; round < 4; round++) await Promise.all([a.tick(), b.tick()]);
        expect(mail.sent.map((m) => m.subject).sort()).toEqual(['信 1', '信 2', '信 3', '信 4', '信 5', '信 6']);
        expect([lockA.isHeld, lockB.isHeld].filter(Boolean)).toHaveLength(1);
      } finally {
        await lockA.release();
        await lockB.release();
      }
    });

    it('連不上資料庫時 ensure 丟例外（交給輪詢迴圈退避）', async () => {
      const url = new URL(appDbUrl);
      url.port = '1';
      const lock = new LeaderLock(url.href, LOCK_OUTBOX);
      await expect(lock.ensure()).rejects.toThrow();
      expect(lock.isHeld).toBe(false);
      await lock.release();
    });
  });

  describe('輪詢迴圈', () => {
    it('失敗時等待時間加倍到上限，成功後恢復', async () => {
      const log = memoryLog();
      let fail = true;
      let ticks = 0;
      const loop = new PollLoop({
        name: 't',
        intervalMs: 5,
        maxBackoffMs: 40,
        log,
        tick: async () => {
          ticks += 1;
          if (fail) throw Object.assign(new Error('db down'), { code: '08006' });
        },
      });
      loop.start();
      await until(() => log.lines.filter((l) => l.level === 'warn').length >= 5);
      const delays = log.lines.filter((l) => l.level === 'warn').map((l) => l.retry_in_ms);
      expect(delays.slice(0, 5)).toEqual([10, 20, 40, 40, 40]);
      expect(log.lines.find((l) => l.level === 'warn')).toMatchObject({ worker: 't', err: 'db down', sqlstate: '08006' });
      fail = false;
      const seen = ticks;
      await until(() => ticks > seen + 1);
      expect(loop.nextDelayMs()).toBe(5);
      await loop.stop();
      const after = ticks;
      await sleep(30);
      expect(ticks).toBe(after); // 停了就不再跑
    });

    it('tick 回 true 時不等待，直接再跑', async () => {
      let remaining = 5;
      const loop = new PollLoop({
        name: 't',
        intervalMs: 60_000,
        maxBackoffMs: 60_000,
        log: memoryLog(),
        tick: async () => {
          remaining -= 1;
          return remaining > 0;
        },
      });
      loop.start();
      await until(() => remaining === 0, 2000);
      await loop.stop(); // 正在等 60 秒，stop 會立刻叫醒
    });

    it('stop 會等正在跑的那一輪結束', async () => {
      let finished = false;
      const loop = new PollLoop({
        name: 't',
        intervalMs: 5,
        maxBackoffMs: 5,
        log: memoryLog(),
        tick: async () => {
          await sleep(100);
          finished = true;
        },
      });
      loop.start();
      await sleep(20);
      await loop.stop();
      expect(finished).toBe(true);
    });
  });

  describe('startWorkers：依設定啟動與關閉', () => {
    it('啟動後會寄信、會跑排程；stop 後放掉鎖', async () => {
      await enqueue('由背景寄出');
      const mail = new FakeMail();
      const workers = startWorkers({ config, sys, mail, log: memoryLog() });
      try {
        await until(async () => mail.sent.length === 1 && (await admin.query('select 1 from das.job_runs')).rowCount! > 0);
      } finally {
        await workers.stop();
      }
      const { rows } = await admin.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())");
      expect(rows[0].n).toBe(0);
    });

    it('OUTBOX_ENABLED=false、SCHEDULER_ENABLED=false 時都不啟動', async () => {
      await enqueue('不該被寄出');
      const off = loadConfig(baseEnv({ OUTBOX_ENABLED: 'false', SCHEDULER_ENABLED: 'false', OUTBOX_INTERVAL_SEC: '1', SCHEDULER_INTERVAL_SEC: '1' }));
      const mail = new FakeMail();
      const log = memoryLog();
      const workers = startWorkers({ config: off, sys, mail, log });
      await sleep(300);
      await workers.stop();
      expect(mail.sent).toHaveLength(0);
      expect((await admin.query('select 1 from das.job_runs')).rowCount).toBe(0);
      expect(log.lines.map((l) => l.msg)).toEqual([
        'worker 已用 OUTBOX_ENABLED=false 關閉',
        'worker 已用 SCHEDULER_ENABLED=false 關閉',
      ]);
    });
  });
});
