-- 示範與驗收用的種子（不進正式環境）：受管系統的交付方式（裁決 D63：系統對系統是預設，也是目標）。
-- 資料中心（dc）有介面（sim/dc），走系統對系統、通道 dc；人資系統（hr_saas）在示範環境沒有介面，維持人工執行（退路）。
select sgn_internal.register_setting_value(v.key, v.scope_ref, v.value::jsonb, v.reason)
from (values
    ('delivery.mode', 'system:dc', '"system"', '示範環境：資料中心有系統對系統的介面（sim/dc）'),
    ('delivery.channel', 'system:dc', '"dc"', '示範環境：資料中心走交付通道 dc')
) as v (key, scope_ref, value, reason);
