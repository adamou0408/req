import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { CurrentUser, Role } from "./api/endpoints";
import { api } from "./api/endpoints";
import { AuthProvider } from "./auth/AuthContext";
import { ToastProvider } from "./components";
import { MfaProvider } from "./mfa/MfaProvider";
import { jsonResponse } from "./test/render";
import { setViewportWidth } from "./test/viewport";

function person(name: string, roles: Role[]): CurrentUser {
  return { user_id: name, name, dept: "業務分析部", title: null, roles };
}

const APPLICANT = person("林怡君", ["applicant"]);
const MANAGER = person("陳建宏", ["applicant", "approver", "manager"]);
const AUDITOR = person("黃淑芬", ["auditor"]);
const EVERY_ROLE = person("測試人員", [
  "applicant",
  "approver",
  "owner",
  "manager",
  "mis",
  "mis_admin",
  "auditor",
]);
const UNAUTHENTICATED = () =>
  jsonResponse({ code: "UNAUTHENTICATED", message: "尚未登入" }, 401);

type Handler = (init: RequestInit | undefined) => Response;

/** 後端的替身：依「方法 路徑」回應；沒列到的一律 404。 */
function stubBackend(routes: Record<string, Handler>) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    return Promise.resolve(
      handler
        ? handler(init)
        : jsonResponse({ code: "NOT_FOUND", message: key }, 404),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <AuthProvider>
          <MfaProvider>
            <App />
          </MfaProvider>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function navLabels(): string[] {
  const nav = screen.getByRole("navigation", { name: "主要導覽" });
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent ?? "");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("身分與登入", () => {
  it("未登入時導向登入頁；開發模式列出人員，選了之後回到原本要去的頁面", async () => {
    let current: CurrentUser | null = null;
    const fetchMock = stubBackend({
      "GET /auth/me": () =>
        current ? jsonResponse(current) : UNAUTHENTICATED(),
      "GET /auth/dev/users": () => jsonResponse([APPLICANT, MANAGER]),
      "POST /auth/dev/login": (init) => {
        const { user_id: userId } = JSON.parse(String(init?.body)) as {
          user_id: string;
        };
        current =
          [APPLICANT, MANAGER].find((user) => user.user_id === userId) ?? null;
        return jsonResponse(current);
      },
    });
    renderApp("/approvals");

    expect(
      await screen.findByRole("heading", { level: 1, name: "資料授權簽核" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "使用公司帳號登入" })
        .getAttribute("href"),
    ).toBe("/auth/login");
    const people = await screen.findByRole("list", { name: "可扮演的人員" });
    expect(within(people).getAllByRole("button")).toHaveLength(2);

    await userEvent.click(
      within(people).getByRole("button", { name: /陳建宏/ }),
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "待簽清單" }),
    ).toBeTruthy();
    const login = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/auth/dev/login",
    );
    expect(
      (login?.[1]?.headers as Record<string, string>)["X-Requested-With"],
    ).toBe("das-web");
  });

  it("確認登入狀態失敗（後端沒開）時顯示錯誤與重試，不會誤導向登入頁", async () => {
    let healthy = false;
    stubBackend({
      "GET /auth/me": () =>
        healthy
          ? jsonResponse(APPLICANT)
          : jsonResponse({ code: "INTERNAL", message: "伺服器忙碌中" }, 500),
    });
    renderApp("/");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "伺服器忙碌中",
    );
    healthy = true;
    await userEvent.click(screen.getByRole("button", { name: "重試" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "我的申請" }),
    ).toBeTruthy();
  });

  it("使用中登入過期（任何請求回 401）：回到登入頁", async () => {
    stubBackend({
      "GET /auth/me": () => jsonResponse(APPLICANT),
      "GET /api/anything": UNAUTHENTICATED,
      "GET /auth/dev/users": () => jsonResponse([]),
    });
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "我的申請" });
    await api.get("/api/anything").catch(() => undefined);
    expect(
      await screen.findByRole("link", { name: "使用公司帳號登入" }),
    ).toBeTruthy();
  });

  it("登出後回到登入頁", async () => {
    let current: CurrentUser | null = APPLICANT;
    stubBackend({
      "GET /auth/me": () =>
        current ? jsonResponse(current) : UNAUTHENTICATED(),
      "GET /auth/dev/users": () => jsonResponse([]),
      "POST /auth/logout": () => {
        current = null;
        return new Response(null, { status: 204 });
      },
    });
    renderApp("/");
    await userEvent.click(await screen.findByRole("button", { name: "登出" }));
    expect(
      await screen.findByRole("link", { name: "使用公司帳號登入" }),
    ).toBeTruthy();
  });
});

describe("導覽依角色顯示", () => {
  it.each([
    { user: APPLICANT, labels: ["我的申請"] },
    { user: MANAGER, labels: ["我的申請", "待簽", "授權總覽"] },
    {
      user: EVERY_ROLE,
      labels: ["我的申請", "待簽", "授權總覽", "MIS", "稽核"],
    },
  ])("桌面上方導覽：$user.name 看到 $labels", async ({ user, labels }) => {
    stubBackend({ "GET /auth/me": () => jsonResponse(user) });
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "我的申請" });
    expect(navLabels()).toEqual(labels);
    expect(document.querySelector(".bottomnav")).toBeNull();
  });

  it("手機改用底部導覽（最多 5 項），並標出目前位置", async () => {
    setViewportWidth(390);
    stubBackend({ "GET /auth/me": () => jsonResponse(EVERY_ROLE) });
    renderApp("/approvals/DA-2026-0142");
    await screen.findByRole("heading", { level: 1, name: "簽核詳情" });
    const nav = screen.getByRole("navigation", { name: "主要導覽" });
    expect(nav.className).toBe("bottomnav");
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(5);
    expect(
      links
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent),
    ).toEqual(["待簽"]);
    expect(document.documentElement.classList.contains("has-bottomnav")).toBe(
      true,
    );
  });

  it("手機上只有一個去處的人不顯示底部導覽", async () => {
    setViewportWidth(390);
    stubBackend({ "GET /auth/me": () => jsonResponse(APPLICANT) });
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "我的申請" });
    expect(screen.queryByRole("navigation", { name: "主要導覽" })).toBeNull();
  });

  it("沒有申請人導覽的人（只有稽核）首頁改送到他的第一個去處", async () => {
    stubBackend({ "GET /auth/me": () => jsonResponse(AUDITOR) });
    renderApp("/");
    expect(
      await screen.findByRole("heading", { level: 1, name: "稽核查詢" }),
    ).toBeTruthy();
    expect(navLabels()).toEqual(["稽核"]);
  });
});

describe("路由與頁面骨架", () => {
  it.each([
    ["/", "我的申請", "Main.dc.html"],
    ["/requests/new", "新申請", "Apply-Form.dc.html"],
    ["/requests/DA-1", "申請單", "Request-Detail.dc.html"],
    ["/approvals", "待簽清單", "Approver-Inbox.dc.html"],
    ["/approvals/DA-1", "簽核詳情", "Approver-Review.dc.html"],
    ["/grants", "授權總覽", "Owner-Grants.dc.html"],
    ["/mis", "MIS 佇列", "MIS-Queue.dc.html"],
    ["/mis/DA-1", "MIS 檢查", "MIS-Check.dc.html"],
    ["/settings", "系統設定", "MIS-Settings.dc.html"],
    ["/audit", "稽核查詢", "Audit-Search.dc.html"],
    ["/audit/DA-1", "證據頁", "Audit-Evidence.dc.html"],
  ])("%s 顯示「%s」並標明 %s", async (route, title, wireframe) => {
    stubBackend({ "GET /auth/me": () => jsonResponse(EVERY_ROLE) });
    renderApp(route);
    expect(
      await screen.findByRole("heading", { level: 1, name: title }),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`docs/wireframes/${wireframe}`)),
    ).toBeTruthy();
  });

  it("手機寬度的 /approvals 與 /approvals/:id 改照手機 wireframe", async () => {
    setViewportWidth(390);
    stubBackend({ "GET /auth/me": () => jsonResponse(EVERY_ROLE) });
    const { unmount } = renderApp("/approvals");
    expect(
      await screen.findByRole("heading", { level: 1, name: "待我簽" }),
    ).toBeTruthy();
    expect(screen.getByText(/Mobile-Inbox\.dc\.html/)).toBeTruthy();
    unmount();
    renderApp("/approvals/DA-1");
    await screen.findByRole("heading", { level: 1, name: "簽核詳情" });
    expect(
      screen.getByText(
        /Mobile-Review\.dc\.html、docs\/wireframes\/Mobile-MFA\.dc\.html/,
      ),
    ).toBeTruthy();
  });

  it("不存在的網址顯示找不到頁面", async () => {
    stubBackend({ "GET /auth/me": () => jsonResponse(EVERY_ROLE) });
    renderApp("/nope");
    expect(
      await screen.findByRole("heading", { level: 1, name: "找不到這個頁面" }),
    ).toBeTruthy();
  });

  it("開發模式有元件展示頁，不需要登入", async () => {
    stubBackend({ "GET /auth/me": UNAUTHENTICATED });
    renderApp("/dev/components");
    expect(
      await screen.findByRole("heading", { level: 1, name: "共用元件" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "DataList" })).toBeTruthy(),
    );
  });
});
