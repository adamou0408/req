// 執行期的程式與各自的密鑰（裁決 D81 (1)：每個程式只拿得到自己的密鑰）。這張表是唯一來源：
//   - db/tools/provision-secrets.mjs 依它建立作業系統帳號、寫 .run/secrets/<程式>.env（擁有者是該帳號，0400）
//   - tools/run-all.sh 以該帳號啟動程式（tools/lib/as-program.sh）
//   - db/tests/kernel/95-program-secrets.test.mjs 檢查每個檔案只有這裡列的鍵、別的程式讀不到、程式的記憶體裡沒有別人的密鑰
// roleKey：連資料庫用的登入角色（sgn.env 的 SGN_ROLE_<鍵>），null＝不連資料庫。密鑰檔的 SGN_DB_PASSWORD 是那個角色的密碼。
// 排程、對帳、錨點、寄信各用各的角色（裁決 D84 (6)）；合併角色 sgn_job 只給操作者，沒有任何程式拿得到。
export const PROGRAMS = {
    /** 後端（api/src/server.ts）：sgn_app、身分提供者的 client secret */
    api: { roleKey: 'APP', secrets: ['SGN_IDP_CLIENT_SECRET'], entry: 'api/src/server.ts' },
    /** 交付程式（api/src/delivery.ts）：sgn_delivery、外部系統的 platform 金鑰 */
    delivery: { roleKey: 'DELIVERY', secrets: ['SGN_DC_KEY'], entry: 'api/src/delivery.ts' },
    /** 對帳程式（api/src/reconciler.ts）：sgn_reconciler、外部系統的 auditor 唯讀金鑰 */
    reconciler: { roleKey: 'RECONCILER', secrets: ['SGN_DC_KEY'], entry: 'api/src/reconciler.ts' },
    /** 排程（db/tools/jobs.mjs） */
    jobs: { roleKey: 'SCHEDULER', secrets: [], entry: 'db/tools/jobs.mjs' },
    /** 通知寄送（api/src/mailer.ts） */
    mailer: { roleKey: 'MAILER', secrets: [], entry: 'api/src/mailer.ts' },
    /** 錨定程式（db/tools/anchor.mjs）：讀鏈頭，寫到錨點存放處（寫入金鑰） */
    anchor: { roleKey: 'ANCHOR', secrets: ['SGN_ANCHOR_WRITE_KEY'], entry: 'db/tools/anchor.mjs' },
    /** 錨點存放處（db/tools/anchor-store.mjs）：只存寫入金鑰的雜湊，不連資料庫 */
    'anchor-store': { roleKey: null, secrets: ['SGN_ANCHOR_WRITE_KEY_SHA256'], entry: 'db/tools/anchor-store.mjs' },
    /** 身分提供者的金鑰更新（db/tools/idp-keys.mjs）：sgn_idp_keys */
    'idp-keys': { roleKey: 'IDP_KEYS', secrets: [], entry: 'db/tools/idp-keys.mjs' },
    /** 頁面的靜態伺服器（web/server.mjs）：沒有任何密鑰 */
    web: { roleKey: null, secrets: [], entry: 'web/server.mjs' },
};

/** 程式的作業系統帳號。 */
export const osUser = (program) => `sgn-${program}`;

/** 密鑰檔裡應該有的鍵。 */
export const secretKeys = (program) => [...(PROGRAMS[program].roleKey ? ['SGN_DB_PASSWORD'] : []), ...PROGRAMS[program].secrets];
