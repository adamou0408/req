// ESLint 的共用設定（工程規範第 4 節：共用設定放在根目錄）。零警告：tools/check.sh 以 --max-warnings 0 執行。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    // sim/ 與 docs/ 不歸這個 repo 的程式碼品質關卡管（sim 有自己的規範：shellcheck）
    // redteam/exploits/ 是紅隊留下的攻擊證據，必須保持原樣才能重跑對照（任務規定不得修改），不歸程式碼品質關卡管
    { ignores: ['**/node_modules/**', '.run/**', 'sim/**', 'docs/**', 'redteam/exploits/**'] },
    js.configs.recommended,
    ...tseslint.configs.strict,
    {
        languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
        linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
    // 瀏覽器端程式；測試裡交給 page.evaluate 的函式也在瀏覽器執行
    {
        files: ['web/**/*.js', 'e2e/**/*.{mjs,ts}', 'db/tests/**/*.mjs'],
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
    },
    // 原生的 replaceChildren 會把 null 變成文字「null」（稽核證據頁的「nullnull」就是這樣來的）：
    // 換掉節點內容一律用 web/ui.js 的 fill（和 el 一樣丟掉 null、undefined、false）。fill 本身在 ui.js 裡用原生的。
    {
        files: ['web/**/*.js'],
        ignores: ['web/ui.js'],
        rules: {
            'no-restricted-properties': [
                'error',
                { property: 'replaceChildren', message: '請用 web/ui.js 的 fill（原生的會把 null 寫成文字「null」）。' },
            ],
        },
    },
);
