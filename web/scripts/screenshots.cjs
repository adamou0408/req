/**
 * 對 /dev/components、/login 與登入後的外框截圖（390px 與 1280px，淺色與深色），
 * 同時檢查「沒有水平捲動」與「手機上的觸控目標至少 44px」。
 * 任何一項沒過就以非 0 結束。圖存在 web/.screenshots/。
 *
 * 用法：npm run screenshots（需要全域安裝的 playwright）。
 * 不需要後端：/auth/* 由這支腳本攔截回應。
 */
const { spawn } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, ".screenshots");
const PORT = 5199;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WIDTHS = [390, 1280];
const SCHEMES = ["light", "dark"];
const MIN_TAP = 44;
const TAP_TARGETS = [
  ".btn",
  ".bottomnav__item",
  ".field__control",
  ".tabs__tab",
  ".choice__row",
  ".seg__option",
  ".login__person",
  ".topbar__logout",
  ".topbar__brand",
  ".pagehead__back",
  ".modal__close",
].join(",");

// 截圖用的假回應；欄位名稱跟著 src/api/endpoints.ts 的 CurrentUser。
const PEOPLE = [
  { user_id: "u01", name: "林怡君", dept: "業務分析部", title: null, roles: ["applicant"] },
  { user_id: "u02", name: "陳建宏", dept: "業務分析部", title: "經理", roles: ["applicant", "manager", "approver"] },
  { user_id: "u03", name: "張美玲", dept: "財務部", title: "經理", roles: ["applicant", "owner", "manager"] },
  { user_id: "u04", name: "李志偉", dept: "資訊部", title: null, roles: ["applicant", "mis", "mis_admin"] },
  { user_id: "u05", name: "黃淑芬", dept: "稽核室", title: null, roles: ["auditor"] },
];
const EVERY_ROLE = {
  user_id: "u99",
  name: "測試人員",
  dept: "資訊部",
  title: null,
  roles: ["applicant", "approver", "owner", "manager", "mis", "mis_admin", "auditor"],
};

const SHOTS = [
  { name: "dev-components", url: "/dev/components", user: null },
  { name: "login", url: "/login", user: null },
  { name: "app-home", url: "/", user: EVERY_ROLE },
  { name: "app-approvals", url: "/approvals", user: EVERY_ROLE },
  { name: "app-approval-detail", url: "/approvals/DA-2026-0142", user: EVERY_ROLE },
  { name: "app-single-role", url: "/", user: PEOPLE[0] },
  {
    name: "dialog-mfa",
    url: "/dev/components",
    user: null,
    before: (page) => page.getByRole("button", { name: "核准（需要 MFA）" }).click(),
    viewportOnly: true,
  },
  {
    name: "dialog-confirm",
    url: "/dev/components",
    user: null,
    before: (page) => page.getByRole("button", { name: "撤銷（要填原因）" }).click(),
    viewportOnly: true,
  },
];

function json(body, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

async function mockAuth(page, user) {
  await page.route("**/auth/me", (route) =>
    route.fulfill(user ? json(user) : json({ code: "UNAUTHENTICATED", message: "尚未登入" }, 401)),
  );
  await page.route("**/auth/dev/users", (route) => route.fulfill(json(PEOPLE)));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // 伺服器還沒起來，再等一下。
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("vite 開發伺服器沒有在時限內啟動");
}

/** 回傳這個畫面的問題清單；空陣列代表通過。 */
function inspect({ minTap, selector, checkTaps }) {
  const problems = [];
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth) {
    problems.push(`水平捲動：內容寬 ${root.scrollWidth}px > 畫面寬 ${root.clientWidth}px`);
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.right > root.clientWidth + 1 && rect.width > 0) {
        problems.push(`  超出畫面：<${element.tagName.toLowerCase()} class="${element.className}">`);
        break;
      }
    }
  }
  if (!checkTaps) return problems;
  for (const element of document.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.height < minTap - 0.5 || rect.width < minTap - 0.5) {
      const text = (element.textContent || element.getAttribute("aria-label") || "").trim().slice(0, 12);
      problems.push(
        `觸控目標太小：${Math.round(rect.width)}×${Math.round(rect.height)} <${element.tagName.toLowerCase()} class="${element.className}"> ${text}`,
      );
    }
  }
  return problems;
}

async function capture(browser, shot, width, scheme) {
  const context = await browser.newContext({
    viewport: { width, height: width < 640 ? 844 : 800 },
    colorScheme: scheme,
    deviceScaleFactor: width < 640 ? 2 : 1,
    hasTouch: width < 640,
    locale: "zh-TW",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await mockAuth(page, shot.user);
  await page.goto(BASE_URL + shot.url, { waitUntil: "networkidle" });
  await page.locator("h1").first().waitFor();
  if (shot.before) await shot.before(page);
  await page.waitForTimeout(150);
  const file = `${shot.name}-${width}-${scheme}.png`;
  await page.screenshot({ path: path.join(OUT_DIR, file), fullPage: !shot.viewportOnly });
  const problems = await page.evaluate(inspect, {
    minTap: MIN_TAP,
    selector: TAP_TARGETS,
    checkTaps: width < 640,
  });
  // 沒登入時 /auth/me 回 401 是預期行為，瀏覽器會把它記成一筆 console error。
  const unexpected = consoleErrors.filter((text) => !text.includes("401"));
  await context.close();
  return { file, problems: [...problems, ...unexpected.map((text) => `console error：${text}`)] };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const vite = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: ROOT, stdio: "ignore" },
  );
  let failed = false;
  try {
    await waitForServer();
    const browser = await chromium.launch();
    for (const shot of SHOTS) {
      for (const width of WIDTHS) {
        for (const scheme of SCHEMES) {
          const result = await capture(browser, shot, width, scheme);
          const mark = result.problems.length === 0 ? "ok  " : "FAIL";
          console.log(`${mark} ${result.file}`);
          for (const problem of result.problems) console.log(`     ${problem}`);
          if (result.problems.length > 0) failed = true;
        }
      }
    }
    await browser.close();
  } finally {
    vite.kill();
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
