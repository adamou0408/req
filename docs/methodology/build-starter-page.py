#!/usr/bin/env python3
"""Builds the copy-and-paste page from starter-kit.md so the kit text has a single source."""
import html
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
kit = (HERE / "starter-kit.md").read_text(encoding="utf-8")
match = re.search(r"````text\n(.*?)\n````", kit, re.S)
if not match:
    sys.exit("starter-kit.md: no ````text block found")
body = html.escape(match.group(1))

PAGE = """<title>AI 產品開發導入包</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap">
<style>
/* Layout: one reading column; the kit text sits in a scrollable block with a sticky copy button. */
:root { --bg:#F4F6F9; --surface:#FFFFFF; --fg:#1B2330; --muted:#566070; --line:#D5DBE3; --accent:#0B5CAD; --on-accent:#FFFFFF; --code:#F0F3F7;
  --font:'Noto Sans TC','PingFang TC','Microsoft JhengHei',system-ui,sans-serif; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#10151C; --surface:#18202A; --fg:#E6EBF2; --muted:#9AA6B5; --line:#2C3744; --accent:#6FB1F5; --on-accent:#0B1622; --code:#131A23; color-scheme:dark } }
:root[data-theme="dark"] { --bg:#10151C; --surface:#18202A; --fg:#E6EBF2; --muted:#9AA6B5; --line:#2C3744; --accent:#6FB1F5; --on-accent:#0B1622; --code:#131A23; color-scheme:dark }
body { background:var(--bg); color:var(--fg); font-family:var(--font); font-size:16px; line-height:1.7;
  padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:24px 64px; }
.page { max-width:760px; margin:0 auto; display:flex; flex-direction:column; gap:28px; }
h1 { font-size:1.6rem; line-height:1.3; margin:0; text-wrap:balance; }
h2 { font-size:1.2rem; line-height:1.4; margin:0; }
p { margin:0; } .muted { color:var(--muted); font-size:.9rem; }
section { display:flex; flex-direction:column; gap:12px; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:16px; display:flex; flex-direction:column; gap:8px; }
ol { margin:0; padding-left:1.3em; display:flex; flex-direction:column; gap:6px; }
.bar { display:flex; flex-wrap:wrap; gap:12px; align-items:center; justify-content:space-between; }
button { font:inherit; font-weight:700; min-height:44px; padding:0 20px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:var(--on-accent); cursor:pointer; }
button:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
pre { margin:0; background:var(--code); border:1px solid var(--line); border-radius:10px; padding:16px; font-family:var(--mono); font-size:.85rem; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere; max-height:70vh; overflow-y:auto; }
</style>
<div class="page">
<header style="display:flex;flex-direction:column;gap:8px">
<h1>用 AI 從零做出產品：導入包</h1>
<p>一段貼給 Claude Code 的指示。AI 會先問清楚目的，用最小的可執行路徑驗證做法，再擴展；你糾正過的事，它要記下來並改掉。</p>
</header>
<section>
<h2>給人讀</h2>
<div class="card"><ol>
<li>按「複製」，貼成新工作階段的第一則訊息。</li>
<li>把最後一行換成你的想法。</li>
<li>開始後隔幾分鐘看兩次用量，把數字告訴它。</li>
</ol></div>
<div class="card"><p><strong>你要盯的三件事</strong></p><ol>
<li>它有沒有先跑出程式，而不是一直寫文件。</li>
<li>它說「完成」時，是寫了、跑過，還是沒驗證。</li>
<li>你重複提醒的事，它有沒有記下來並改掉。</li>
</ol>
<p class="muted">2026-11 第一版。走過實戰的只到設計階段，實作以後的步驟仍在驗證中。</p></div>
</section>
<section>
<div class="bar"><h2>給 AI 讀</h2><button type="button" id="copy">複製</button></div>
<p class="muted" id="status" role="status" aria-live="polite"></p>
<pre id="kit" tabindex="0">__KIT__</pre>
</section>
</div>
<script>
const button = document.getElementById('copy');
const status = document.getElementById('status');
const kit = document.getElementById('kit');
button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(kit.textContent);
    status.textContent = '已複製。';
  } catch (error) {
    const range = document.createRange();
    range.selectNodeContents(kit);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = '無法自動複製。內容已選取，請用系統的複製功能。';
  }
});
</script>
"""
out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "site" / "starter-kit.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(PAGE.replace("__KIT__", body), encoding="utf-8")
print(out)
