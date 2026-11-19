/**
 * 整個測試只做一次：建立臨時資料庫與一個「只能 EXECUTE api.*」的角色，載入測試用 schema；
 * 測試結束後全部刪掉。資料庫與角色的名稱都帶隨機字尾，不會和別人撞。
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** 以受限的 app 角色連線（後端在測試裡都用這個）。 */
    appDbUrl: string;
    /** 以管理者連到同一個臨時資料庫（測試要檢查資料表內容時用）。 */
    adminDbUrl: string;
    /** 第二個一模一樣的臨時資料庫，專門給「把後端當成獨立程式啟動」的測試用，
     *  免得它的背景 worker 和其他測試搶同一份佇列與鎖。 */
    procDbUrl: string;
  }
}

const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://das_dev:das_dev@127.0.0.1:5432/postgres';

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.href;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const suffix = randomBytes(4).toString('hex');
  const database = `das_api_test_${suffix}`;
  const procDatabase = `das_api_test_${suffix}_proc`;
  const role = `das_api_test_${suffix}_app`;
  const password = randomBytes(12).toString('hex');

  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `測試需要 PostgreSQL：連不上 ${new URL(ADMIN_URL).host}（${(err as Error).message}）。` +
        '可用 TEST_DATABASE_ADMIN_URL 指定有建庫權限的連線。',
    );
  }

  const teardown = async (): Promise<void> => {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.query(`drop database if exists ${procDatabase} with (force)`);
    await admin.query(`drop role if exists ${role}`);
    await admin.end();
  };

  try {
    // 名稱只含英數與底線，是這裡自己產生的，可以直接放進 SQL。
    await admin.query(`create role ${role} login password '${password}'`);
    const schemaSql = await readFile(new URL('./fixtures/test-schema.sql', import.meta.url), 'utf8');
    for (const name of [database, procDatabase]) {
      await admin.query(`create database ${name}`);
      const db = new pg.Client({ connectionString: withDatabase(ADMIN_URL, name) });
      await db.connect();
      try {
        await db.query(schemaSql);
        await db.query(`
          revoke all on schema public from public;
          grant usage on schema api to ${role};
          grant execute on all functions in schema api to ${role};
        `);
      } finally {
        await db.end();
      }
    }

    const adminDbUrl = withDatabase(ADMIN_URL, database);
    project.provide('procDbUrl', withDatabase(ADMIN_URL, procDatabase, role, password));
    project.provide('adminDbUrl', adminDbUrl);
    project.provide('appDbUrl', withDatabase(ADMIN_URL, database, role, password));
  } catch (err) {
    await teardown().catch(() => {});
    throw err;
  }

  return teardown;
}
