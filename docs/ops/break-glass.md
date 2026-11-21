# 破窗程序

結論：破窗＝以資料庫最高權限（主機 root 經本機 peer 的 superuser，再 `set role sgn_owner`）直接處理平台內做不到的事。**只有 §2 列的情況可以用；見證人是資安長或其代理人（D98）；事後由稽核複核紀錄。** 錨點比對能證明「稽核鏈沒有被改寫或刪除」，但不能證明業務資料表沒被直接改過（§7），所以破窗期間的每一行 SQL 都要留下來。

依據：`docs/decision-log.md` D65、D84 (1)、D88 (2)、D89 (1)、D98 (2)；`docs/handoff/redteam-fixes-7.md` §4；`db/admin.env`；`db/kernel/520_passkey_recovery.sql` 的 `passkey_bootstrap`；`db/tools/verify-chain.mjs`。契約的 `K-BREAKGLASS`（`docs/contract/00-spine.md`：預先封存、分持的破窗帳號，使用即告警）**尚未實作**，本程序是在那之前的做法。

與交接紀錄不同的地方：`redteam-fixes-7.md` §4 寫的是「稽核主管與資安長兩人在場」；本手冊依較晚的 D98，見證人是資安長或其代理人，稽核在事後複核。若公司內控要求稽核也在場，可以加，不可以減。

## 1. 誰能破窗

- 執行者：能以 root 登入資料庫主機的技術維運（`tech_ops`）。管理者連線沒有密碼，只限本機 unix socket 的 peer（`db/admin.env` 的 `SGN_PG_ADMIN_URL=postgres://root@%2Fvar%2Frun%2Fpostgresql/postgres`；`db/build.sh` 在 `pg_hba.conf` 拒絕 superuser 經 TCP）。
- 見證人：資安長（`ciso`）或其代理人。**任一人是當事人時換人**（例如補的登記人就是資安長本人）；執行者不得是被處理的當事人。
- 程式裡沒有「資安長代理人」的角色代碼。代理人身分以書面指派為準，並寫進紀錄（gaps G-17）。

## 2. 什麼時候可以用

| 情況 | 平台內為什麼做不到 | 使用的入口 |
|---|---|---|
| 可用的登記人少於 `passkey.registrar_min`（K-REGISTRAR-MIN 開著），而且平台內沒有人能恢復（例如登記人與他的主管同時被停用、第二位也不可用） | 背書需要另一位有金鑰的登記人（D65） | `sgn_internal.passkey_bootstrap`（只有 owner；可用登記人達到下限時資料庫拒絕 `PASSKEY_BOOTSTRAP_DONE`） |
| 換交付簽章金鑰、登記外部系統的回應公鑰 | 只有 owner 能執行 | `sgn_internal.signing_key_create`、`sgn_internal.channel_key_register`（key-rotation.md §3.3、§3.4） |
| 還原備份、建角色、授連線權限 | 沒有不刪資料的工具 | backup-restore.md §3 |
| 套用 migration（升級） | 沒有升級工具 | upgrade.md §3 |
| 讀證據（例外總表、事件明細）供調查 | 沒有唯讀的維運角色 | 唯讀 `select`（exceptions.md §1）；**也算破窗，照樣記錄** |

**不可以做的**（就算技術上做得到）：改或刪 `sgn.audit_event`、`sgn.audit_chain_head`；停用或繞過 trigger（包括 `set session_replication_role`）；替任何人做簽核決定或確認；直接改 `sgn.grant_record`、`sgn.request_case`、角色指派等業務資料（要改就寫 migration 或用平台的流程）；改錨點存放處的資料檔。

## 3. 事前（執行者準備，見證人確認）

1. 開一張破窗紀錄（§5 格式），寫明情況、對應的例外編號（例如 K-REGISTRAR-MIN 的 `sgn.exception_record.id`）、預計執行的 SQL 全文。見證人看過 SQL 才開始。
2. 記下破窗前的鏈狀態：
   ```bash
   node db/tools/verify-chain.mjs <資料庫> > before.json; echo $?
   ```
   結束碼必須是 0；不是 0 就先停下來，依 §7 處理（不能在已經不一致的鏈上破窗，否則事後分不清）。把 `before.json` 的 `head`（序號與雜湊）抄進紀錄。
3. 錨點要追上：`before.json` 的 `unanchored` 應為 0 或很小；必要時等錨定程式跑完一輪再做第 2 步。

## 4. 執行（見證人在場）

以 root，把整段操作記到檔案（`psql -L` 是 psql 自己的查詢紀錄選項）：

```bash
source db/sgn.env; source db/admin.env
psql -X -v ON_ERROR_STOP=1 -L breakglass-<紀錄編號>.log "${SGN_PG_ADMIN_URL%/*}/<資料庫>"
```

進入後先 `set role sgn_owner;`（`db/build.sh` 的建置與 `delivery-keys.mjs`、`bootstrap-registrar.mjs` 都是這樣做），只執行紀錄上寫的 SQL，執行完 `reset role;` 並離開。

### 4.1 範例：補登記人（安裝儀式）

在登記人本人面前，以本人的真驗證器產生公鑰（credential id 與 SPKI，base64url）。開發環境的 `db/tools/bootstrap-registrar.mjs` 用軟體金鑰，**正式環境不可用**。

```sql
set role sgn_owner;
select sgn_internal.passkey_bootstrap(
    '<人員 id>'::uuid, '<credential id>', '<SPKI>',
    'K-REGISTRAR-MIN 例外 <編號>；見證：<資安長或代理人姓名>；紀錄 <紀錄編號>');
reset role;
```

會留下：鏈上的 `passkey.bootstrapped`（人員、角色、金鑰指紋、原因、儀式前可用的登記人、參數）與 `passkey.registered`；登記人角色的指派（`change_event_seq` 指向儀式事件）；可用登記人回到下限時 K-REGISTRAR-MIN 自動結案（`exception.closed`）。原因欄會進鏈，所以**不要寫任何密鑰**。若補的人只是臨時補位，事後由角色變更流程撤除。

## 5. 紀錄格式（存放在平台以外，由稽核主管保管）

```
破窗紀錄編號：BG-<年>-<序號>
日期與起訖時間：
情況（§2 的哪一列）與例外編號：
執行者：                 見證人（資安長或代理人，代理依據）：
預計執行的 SQL（全文）：
實際執行的 SQL：附 psql -L 的紀錄檔與其 SHA-256
破窗前：verify-chain 結束碼、head.seq、head.hash
破窗後：verify-chain 結束碼、head.seq、head.hash
期間新增的稽核事件序號區間與事件種類：
是否改到程式指紋（CODE_CHANGED）：是／否；是的話對應的升級單
稽核複核人與日期、結論：
```

## 6. 事後：稽核複核什麼

稽核主管（或指派的稽核）在破窗後 5 個工作天內（**建議值**）複核：

1. 紀錄完整：§5 每一欄都有；SQL 紀錄檔的 SHA-256 和紀錄上的一致。
2. 做的事只有紀錄上寫的：比對 `psql -L` 紀錄檔與「預計執行的 SQL」。
3. 鏈上留下的事件和做的事對得上：破窗前後鏈頭之間的事件（例如 `passkey.bootstrapped`、`delivery.signing_key_created`、`exception.closed`）原因欄有紀錄編號與見證人。稽核頁的查詢只依單號（`web/pages/home.js` 的 `auditSearch`、`api.audit_case`），不屬於任何一張單的事件在畫面上沒有瀏覽入口；API 有 `api.audit_chain(session, after_seq, limit)`（稽核角色）可依序號讀，但沒有畫面（gaps G-12）。在那之前，由見證人以外的人以唯讀查詢列出 `before.head.seq` 之後的事件，附在紀錄裡。
4. 稽核鏈沒有被改寫（§7）。
5. 情況確實符合 §2；同一原因一年內第二次破窗，要求開發補平台內的路徑。

## 7. 用錨點確認沒有動到稽核鏈

```bash
node db/tools/verify-chain.mjs <資料庫> > after.json; echo $?
```

通過的條件，全部都要成立：

- 結束碼 0（`ok: true`）。工具從創世重算整條鏈，並把存放處的**每一個**錨點和重算結果比對（`db/tools/chain-lib.mjs` 的 `verifyChain`）。破窗前已存在的錨點全部對得上，就證明破窗前的事件一筆都沒有被改、刪或重排。
- `after.json` 的 `head.seq` ≥ `before.json` 的 `head.seq`，而且在破窗之後錨定程式又成功寫了新的錨點（存放處最後一筆的 `seq` ≥ 破窗後的鏈頭）。
- 沒有 `CODE_CHANGED`（除非這次破窗就是核准的升級，而且紀錄上有對應的升級單）。

這個方法**證明不了**的事（所以 §4 要留下每一行 SQL、§6 要比對）：

- 直接改業務資料表（例如 `sgn.grant_record`、`sgn.role_assignment`）而不寫事件：鏈與錨點不會變。
- 改流程包 schema、`sgn_sdk`、`api_delivery`、`api_idp` 的 function：不在程式指紋涵蓋範圍（`10_audit_chain.sql` 的 `code_fingerprint` 只算 `sgn`、`sgn_internal`、`api`、`api_sync`、`api_job`、`api_verified`；gaps G-10）。
- 以 `session_replication_role` 暫時繞過防改寫的 trigger：trigger 沒有設為 `ENABLE ALWAYS`（`10_audit_chain.sql`；契約 `K-AUDIT-APPEND` 要求 ALWAYS），所以這樣做不改指紋。改了的事件仍會被雜湊與錨點抓到，但「試過」本身不留痕跡（gaps G-11）。
- 破窗期間 superuser 的所有語句：沒有 `pgaudit` 之類的資料庫層紀錄（契約 §14.2 有寫，尚未實作；gaps G-11）。

錨點比對不一致時：立刻停止所有變更、保全現場（資料庫、存放處資料檔、`.run/*.log`、破窗紀錄檔），通報資安長與稽核主管，依 backup-restore.md §4 的判讀表找出是哪一段序號不一致。
