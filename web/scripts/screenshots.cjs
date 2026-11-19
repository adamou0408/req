/**
 * 對 /dev/components、/login 與登入後的外框截圖（390px 與 1280px，淺色與深色），
 * 同時檢查「沒有水平捲動」與「可點擊的元素至少 44×44px」（docs/ux-acceptance.md 第 3 節）。
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
const MOBILE_MAX = 640;
const CLICKABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, [role="tab"]';

// 截圖用的假回應。外型跟著 src/api/endpoints.ts；人員取自 docs/contract/seed-directory.md。
const role = (code, name) => ({ code, name });
const PEOPLE = [
  {
    actor_id: "4",
    name: "林怡君",
    org_unit: "業務分析部",
    title: "分析師",
    roles: [],
  },
  {
    actor_id: "3",
    name: "陳建宏",
    org_unit: "業務分析部",
    title: "經理",
    roles: [],
  },
  {
    actor_id: "11",
    name: "張美玲",
    org_unit: "財務部",
    title: "經理",
    roles: [role("r1", "資料擁有者")],
  },
  {
    actor_id: "17",
    name: "李志偉",
    org_unit: "資訊部",
    title: "工程師",
    roles: [role("r2", "MIS")],
  },
  {
    actor_id: "22",
    name: "黃淑芬",
    org_unit: "稽核室",
    title: "稽核員",
    roles: [role("r3", "稽核")],
  },
];
const session = (person, areas) => ({
  actor_id: person.actor_id,
  profile: {
    name: person.name,
    org_unit: person.org_unit,
    title: person.title,
    roles: person.roles,
    areas,
  },
});
const EVERY_AREA = session(
  {
    actor_id: "16",
    name: "謝明哲",
    org_unit: "資訊部",
    title: "經理",
    roles: [],
  },
  ["requests", "approvals", "grants", "fulfilment", "audit"],
);
const APPLICANT = session(PEOPLE[0], ["requests"]);
const DEV_CONFIG = {
  auth_mode: "dev",
  oidc_enabled: false,
  oidc_login_url: null,
};
const OIDC_CONFIG = {
  auth_mode: "oidc",
  oidc_enabled: true,
  oidc_login_url: "/api/auth/oidc/login",
};

const SHOTS = [
  { name: "dev-components", url: "/dev/components" },
  { name: "login", url: "/login" },
  {
    name: "login-sso",
    url: "/login?login_error=login_failed",
    config: OIDC_CONFIG,
  },
  { name: "app-home", url: "/", user: EVERY_AREA },
  { name: "app-approvals", url: "/approvals", user: EVERY_AREA },
  {
    name: "app-approval-detail",
    url: "/approvals/DA-2026-0142",
    user: EVERY_AREA,
  },
  { name: "app-fulfilment", url: "/fulfilment", user: EVERY_AREA },
  { name: "app-single-area", url: "/", user: APPLICANT },
  {
    name: "dialog-mfa",
    url: "/dev/components",
    before: (page) =>
      page.getByRole("button", { name: "核准（需要 MFA）" }).click(),
    viewportOnly: true,
  },
  {
    name: "dialog-confirm",
    url: "/dev/components",
    before: (page) =>
      page.getByRole("button", { name: "撤銷（要填原因）" }).click(),
    viewportOnly: true,
  },
  {
    name: "focus-ring",
    url: "/dev/components",
    before: async (page) => {
      for (let step = 0; step < 3; step += 1) await page.keyboard.press("Tab");
    },
    viewportOnly: true,
  },
];

function json(body, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function mockAuth(page, shot) {
  const unauthenticated = json(
    { code: "unauthenticated", message: "請先登入" },
    401,
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill(shot.user ? json(shot.user) : unauthenticated),
  );
  await page.route("**/api/auth/config", (route) =>
    route.fulfill(json(shot.config ?? DEV_CONFIG)),
  );
  await page.route("**/api/auth/dev-users", (route) =>
    route.fulfill(json(PEOPLE)),
  );
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

/** 回傳這個畫面的問題清單；空陣列代表通過。在瀏覽器裡執行。 */
function inspect({ minTap, selector }) {
  const problems = [];
  const root = document.documentElement;
  const describe = (element) =>
    `<${element.tagName.toLowerCase()} class="${element.className}">`;
  if (root.scrollWidth > root.clientWidth) {
    problems.push(
      `水平捲動：內容寬 ${root.scrollWidth}px > 畫面寬 ${root.clientWidth}px`,
    );
    const wide = [...document.querySelectorAll("body *")].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.right > root.clientWidth + 1;
    });
    if (wide) problems.push(`  超出畫面：${describe(wide)}`);
  }
  for (const element of document.querySelectorAll(selector)) {
    // 核取方塊與單選的可點範圍是包住它的 label。
    const boxed = element.matches(
      'input[type="checkbox"], input[type="radio"]',
    );
    const target = boxed ? (element.closest("label") ?? element) : element;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.height < minTap - 0.5 || rect.width < minTap - 0.5) {
      const text = (
        target.textContent ||
        target.getAttribute("aria-label") ||
        ""
      )
        .trim()
        .slice(0, 12);
      problems.push(
        `可點擊範圍太小：${Math.round(rect.width)}×${Math.round(rect.height)} ${describe(target)} ${text}`,
      );
    }
  }
  return problems;
}

async function capture(browser, shot, width, scheme) {
  const context = await browser.newContext({
    viewport: { width, height: width < MOBILE_MAX ? 844 : 800 },
    colorScheme: scheme,
    deviceScaleFactor: width < MOBILE_MAX ? 2 : 1,
    hasTouch: width < MOBILE_MAX,
    locale: "zh-TW",
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await mockAuth(page, shot);
  await page.goto(BASE_URL + shot.url, { waitUntil: "networkidle" });
  await page.locator("h1").first().waitFor();
  if (shot.before) await shot.before(page);
  await page.waitForTimeout(150);
  const file = `${shot.name}-${width}-${scheme}.png`;
  await page.screenshot({
    path: path.join(OUT_DIR, file),
    fullPage: !shot.viewportOnly,
  });
  const problems = await page.evaluate(inspect, {
    minTap: MIN_TAP,
    selector: CLICKABLE,
  });
  // 沒登入時 /auth/me 回 401 是預期行為，瀏覽器會把它記成一筆 console error。
  const unexpected = consoleErrors.filter((text) => !text.includes("401"));
  await context.close();
  return {
    file,
    problems: [
      ...problems,
      ...unexpected.map((text) => `console error：${text}`),
    ],
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const vite = spawn(
    process.execPath,
    [
      path.join(ROOT, "node_modules/vite/bin/vite.js"),
      "--port",
      String(PORT),
      "--strictPort",
      "--host",
      "127.0.0.1",
    ],
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
