-- 資料授權流程包的角色（K-ROLE-SOURCE）。資料擁有者是業務類：依範圍的指派由資料目錄帶入（catalog_load），
-- 人員目錄的群組也可以帶入（有冷卻期並開例外，db/kernel/230_directory_sync.sql）；不需要平台內的角色指派變更。
-- 與 docs/contract/seed-directory.md 的「類別」欄（control）不同：依紅隊修復的裁決，資料擁有者列為業務類（docs/handoff/redteam-fixes.md）。

select sgn_sdk.register_role('data_owner', '資料擁有者', 'business', 'sync_proposed', 'data_access');
