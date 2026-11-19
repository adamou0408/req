/**
 * 用 PostgreSQL session 層級的 advisory lock 選出「唯一一個在跑的實例」。
 * 拿到鎖的實例一直握著（握在一條專用連線上），其他實例每一輪試一次、拿不到就跳過。
 * 握鎖的實例掛掉或斷線時，資料庫會自動放掉鎖，由別的實例接手。
 *
 * 注意：session 層級的鎖不能經過 transaction 模式的連線池（PgBouncer 等）；
 * 這條連線要直連資料庫，或用 session 模式。
 */
import pg from 'pg';

/** 鎖的第一個鍵：固定值，代表「本系統」。第二個鍵區分不同的 worker。 */
export const LOCK_NAMESPACE = 0x44415301; // 'DAS' + 1
export const LOCK_OUTBOX = 1;
export const LOCK_SCHEDULER = 2;

export class LeaderLock {
  private readonly connectionString: string;
  private readonly key: number;
  private client: pg.Client | null = null;
  private held = false;

  constructor(connectionString: string, key: number) {
    this.connectionString = connectionString;
    this.key = key;
  }

  get isHeld(): boolean {
    return this.held;
  }

  /**
   * 確認自己握著鎖；沒握著就試著去拿。回 true 才可以做事。
   * 連線有問題時丟例外（由呼叫端的輪詢迴圈退避重試）。
   */
  async ensure(): Promise<boolean> {
    try {
      let client = this.client;
      if (client === null) {
        const fresh = new pg.Client({
          connectionString: this.connectionString,
          application_name: 'das-api-lock',
          connectionTimeoutMillis: 5_000,
          query_timeout: 5_000,
          keepAlive: true,
        });
        // 連線斷掉＝鎖也沒了。
        fresh.on('error', () => this.drop(fresh));
        fresh.on('end', () => this.drop(fresh));
        await fresh.connect();
        this.client = client = fresh;
      }
      if (this.held) {
        // 連線還活著，鎖就還在。
        await client.query('select 1');
        return this.client === client && this.held;
      }
      const res = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1, $2) as locked', [
        LOCK_NAMESPACE,
        this.key,
      ]);
      if (this.client !== client) return false;
      this.held = res.rows[0]?.locked === true;
      return this.held;
    } catch (err) {
      const client = this.client;
      if (client) {
        this.drop(client);
        client.end().catch(() => {});
      }
      throw err;
    }
  }

  /** 放掉鎖並關閉連線。 */
  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.held = false;
    if (client) await client.end().catch(() => {});
  }

  private drop(client: pg.Client): void {
    if (this.client === client) {
      this.client = null;
      this.held = false;
    }
  }
}
