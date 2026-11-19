/**
 * 匯入人員組織資料／資料目錄：
 *   npm run sync -- directory   （讀 DIRECTORY_FILE）
 *   npm run sync -- catalog     （讀 CATALOG_FILE）
 * 只負責讀檔並整份交給 SQL function；資料怎麼合併、誰離職了，都由 SQL function 判斷。
 */
import { ConfigError, loadConfig } from '../config.ts';
import { allowedFunctions, contract, createSystemCalls } from '../contract/index.ts';
import { createPool, Db } from '../db.ts';
import { JsonFileCatalog, JsonFileDirectory } from '../ports/adapters/jsonFile.ts';

async function main(): Promise<number> {
  const what = process.argv[2];
  if (what !== 'directory' && what !== 'catalog') {
    console.error('用法：npm run sync -- directory｜catalog');
    return 2;
  }
  const config = loadConfig();
  const file = what === 'directory' ? config.directoryFile : config.catalogFile;
  if (!file) {
    console.error(`請先設定環境變數 ${what === 'directory' ? 'DIRECTORY_FILE' : 'CATALOG_FILE'}`);
    return 2;
  }
  const pool = createPool(config);
  try {
    const sys = createSystemCalls(new Db(pool, allowedFunctions(contract)), contract.sqlNames, contract.systemActor);
    const result =
      what === 'directory'
        ? await sys.importDirectory(await new JsonFileDirectory(file).fetch())
        : await sys.importCatalog(await new JsonFileCatalog(file).fetch());
    console.log(JSON.stringify({ imported: what, file, result }));
    return 0;
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof ConfigError ? err.message : `匯入失敗：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
