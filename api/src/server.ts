/** 進入點：讀設定 → 接好各個零件 → 開始聽 → 收到訊號時優雅關機。 */
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { allowedFunctions, contract, createSystemCalls } from './contract/index.ts';
import { createPool, Db } from './db.ts';
import { createPorts } from './ports/index.ts';
import { startWorkers, type Workers } from './workers/index.ts';

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const pool = createPool(config);
  const db = new Db(pool, allowedFunctions(contract));
  const sys = createSystemCalls(db, contract.sqlNames, contract.systemActor);

  // ports 需要 logger，logger 在 app 裡；先用轉接的方式接上。
  let logInfo: (obj: Record<string, unknown>, msg: string) => void = () => {};
  const ports = createPorts({ config, sys, log: { info: (o, m) => logInfo(o, m) }, now: Date.now });

  const app = await buildApp({ config, db, contract, sys, ports });
  const log = app.log;
  logInfo = (o, m) => log.info(o, m);

  // 閒置連線出錯（資料庫重啟等）不能讓整個程式掛掉。
  pool.on('error', (err) => log.error({ err: err.message }, '資料庫連線發生錯誤'));

  if (config.authMode === 'oidc' && config.oidc === null) {
    log.warn({ missing: config.oidcMissing }, 'AUTH_MODE=oidc 但 OIDC 設定不全：單一登入未啟用，目前沒有人能登入');
  }
  if (config.isProduction && !config.cookieSecure) {
    log.warn({}, 'COOKIE_SECURE=false：session cookie 會經由未加密的連線傳送');
  }

  let workers: Workers | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, '收到關機訊號，開始優雅關機');
    const force = setTimeout(() => {
      log.error({}, '關機逾時，強制結束');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await workers?.stop(); // 等手上的那一輪做完
      await app.close(); // 不再收新請求，等進行中的請求結束
      await ports.mail.close();
      await pool.end();
      log.info({}, '已關機');
      process.exit(0);
    } catch (err) {
      log.error({ err: String((err as Error)?.message ?? err) }, '關機過程出錯');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  log.info(
    {
      node_env: config.nodeEnv,
      api_prefix: config.apiPrefix || '/',
      auth_mode: config.authMode,
      mfa_mode: config.mfaMode,
      mail_mode: config.mailMode,
      dc_mode: config.dcMode,
      web_dist: config.webDist,
      routes: contract.routes.length,
    },
    '後端已啟動',
  );

  workers = startWorkers({ config, sys, mail: ports.mail, log });
}

main().catch((err) => {
  console.error('啟動失敗：', err instanceof Error ? err.message : err);
  process.exit(1);
});
