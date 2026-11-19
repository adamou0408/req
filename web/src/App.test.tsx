import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Area } from "./api/endpoints";
import { api } from "./api/endpoints";
import { AuthProvider } from "./auth/AuthContext";
import { ToastProvider } from "./components";
import { MfaProvider } from "./mfa/MfaProvider";
import { jsonResponse } from "./test/render";
import { setViewportWidth } from "./test/viewport";

/** 後端 GET /api/auth/me 的回應外型。 */
function session(actorId: string, name: string, areas: Area[]) {
  return {
    actor_id: actorId,
    profile: { name, org_unit: "業務分析部", title: null, roles: [], areas },
  };
}

const APPLICANT = session("4", "林怡君", ["requests"]);
const MANAGER = session("3", "陳建宏", ["requests", "approvals", "grants"]);
const AUDITOR = session("22", "黃淑芬", ["audit"]);
const EVERY_AREA = session("16", "謝明哲", [
  "requests",
  "approvals",
  "grants",
  "fulfilment",
  "audit",
]);
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
const UNAUTHENTICATED = () =>
  jsonResponse({ code: "unauthenticated", message: "請先登入" }, 401);

type Handler = (init: RequestInit | undefined) => Response;

/** 後端的替身：依「方法 路徑」回應；沒列到的一律 404。 */
function stubBackend(routes: Record<string, Handler>) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const handler = routes[key];
    const fallback = jsonResponse(
      { code: "not_found", message: "找不到資料" },
      404,
    );
    return Promise.resolve(handler ? handler(init) : fallback);
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

describe("登入頁", () => {
  it("未登入時導向登入頁；開發模式列出人員，選了之後回到原本要去的頁面", async () => {
    let current: ReturnType<typeof session> | null = null;
    const fetchMock = stubBackend({
      "GET /api/auth/me": () =>
        current ? jsonResponse(current) : UNAUTHENTICATED(),
      "GET /api/auth/config": () => jsonResponse(DEV_CONFIG),
      "GET /api/auth/dev-users": () =>
        jsonResponse([
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
            roles: [{ code: "any", name: "主管" }],
          },
        ]),
      "POST /api/auth/dev-login": (init) => {
        const body = JSON.parse(String(init?.body)) as { actor_id: string };
        current = body.actor_id === "3" ? MANAGER : APPLICANT;
        return jsonResponse(current);
      },
    });
    renderApp("/approvals");

    expect(
      await screen.findByRole("heading", { level: 1, name: "簽核平台" }),
    ).toBeTruthy();
    const people = await screen.findByRole("list", { name: "可扮演的人員" });
    expect(within(people).getAllByRole("button")).toHaveLength(2);
    expect(within(people).getByText("主管")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "使用公司帳號登入" })).toBeNull();

    await userEvent.click(
      within(people).getByRole("button", { name: /陳建宏/ }),
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "待簽清單" }),
    ).toBeTruthy();
    const login = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/auth/dev-login",
    );
    expect(login?.[1]?.body).toBe('{"actor_id":"3"}');
    expect(
      (login?.[1]?.headers as Record<string, string>)["X-Requested-With"],
    ).toBe("sgn-web");
  });

  it("後端沒有提供人員名單時，可以直接輸入人員代號登入", async () => {
    let current: ReturnType<typeof session> | null = null;
    stubBackend({
      "GET /api/auth/me": () =>
        current ? jsonResponse(current) : UNAUTHENTICATED(),
      "GET /api/auth/config": () => jsonResponse(DEV_CONFIG),
      "POST /api/auth/dev-login": () => {
        current = APPLICANT;
        return jsonResponse(current);
      },
    });
    renderApp("/");
    expect(
      await screen.findByText("後端沒有提供人員名單，請直接輸入人員代號。"),
    ).toBeTruthy();
    await userEvent.type(screen.getByLabelText("人員代號"), "4{Enter}");
    expect(
      await screen.findByRole("heading", { level: 1, name: "我的申請" }),
    ).toBeTruthy();
  });

  it("開發登入失敗時顯示後端的訊息", async () => {
    stubBackend({
      "GET /api/auth/me": UNAUTHENTICATED,
      "GET /api/auth/config": () => jsonResponse(DEV_CONFIG),
      "POST /api/auth/dev-login": () =>
        jsonResponse(
          { code: "person_not_found", message: "找不到這個人" },
          404,
        ),
    });
    renderApp("/");
    await userEvent.type(
      await screen.findByLabelText("人員代號"),
      "999{Enter}",
    );
    expect((await screen.findByRole("alert")).textContent).toBe("找不到這個人");
  });

  it("單一登入模式只有公司帳號登入的連結，並帶上登入後要回去的位置", async () => {
    stubBackend({
      "GET /api/auth/me": UNAUTHENTICATED,
      "GET /api/auth/config": () => jsonResponse(OIDC_CONFIG),
    });
    renderApp("/approvals/DA-1");
    const link = await screen.findByRole("link", { name: "使用公司帳號登入" });
    expect(link.getAttribute("href")).toBe(
      "/api/auth/oidc/login?return_to=%2Fapprovals%2FDA-1",
    );
    expect(screen.queryByLabelText("人員代號")).toBeNull();
  });

  it("單一登入還沒設定好時說明原因，不給一個按了沒用的按鈕", async () => {
    stubBackend({
      "GET /api/auth/me": UNAUTHENTICATED,
      "GET /api/auth/config": () =>
        jsonResponse({
          auth_mode: "oidc",
          oidc_enabled: false,
          oidc_login_url: null,
        }),
    });
    renderApp("/");
    expect(
      await screen.findByText("單一登入尚未設定完成，請聯絡系統管理員。"),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "使用公司帳號登入" })).toBeNull();
  });

  it("單一登入失敗被導回時，用人看得懂的話說明原因", async () => {
    stubBackend({
      "GET /api/auth/me": UNAUTHENTICATED,
      "GET /api/auth/config": () => jsonResponse(OIDC_CONFIG),
    });
    renderApp("/?login_error=not_provisioned");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "你的帳號還沒有開通這個系統，請聯絡系統管理員。",
    );
    const link = await screen.findByRole("link", { name: "使用公司帳號登入" });
    expect(link.getAttribute("href")).toBe(
      "/api/auth/oidc/login?return_to=%2F",
    );
  });
});

describe("登入狀態", () => {
  it("確認登入狀態失敗（後端沒開）時顯示錯誤與重試，不會誤導向登入頁", async () => {
    let healthy = false;
    const down = () =>
      jsonResponse(
        { code: "service_unavailable", message: "系統暫時無法使用" },
        503,
      );
    stubBackend({
      "GET /api/auth/me": () => (healthy ? jsonResponse(APPLICANT) : down()),
    });
    renderApp("/");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "系統暫時無法使用",
    );
    healthy = true;
    await userEvent.click(screen.getByRole("button", { name: "重試" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "我的申請" }),
    ).toBeTruthy();
  });

  it("使用中登入過期（任何請求回 401）：回到登入頁", async () => {
    stubBackend({
      "GET /api/auth/me": () => jsonResponse(APPLICANT),
      "GET /api/anything": UNAUTHENTICATED,
      "GET /api/auth/config": () => jsonResponse(OIDC_CONFIG),
    });
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "我的申請" });
    await api.get("/api/anything").catch(() => undefined);
    expect(
      await screen.findByRole("link", { name: "使用公司帳號登入" }),
    ).toBeTruthy();
  });

  it("登出後回到登入頁", async () => {
    let current: ReturnType<typeof session> | null = APPLICANT;
    stubBackend({
      "GET /api/auth/me": () =>
        current ? jsonResponse(current) : UNAUTHENTICATED(),
      "GET /api/auth/config": () => jsonResponse(OIDC_CONFIG),
      "POST /api/auth/logout": () => {
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

  it("契約還沒提供個人資料時，先用代號當名字，照樣能進首頁", async () => {
    stubBackend({
      "GET /api/auth/me": () =>
        jsonResponse({ actor_id: "p04", profile: null }),
    });
    renderApp("/");
    expect(
      await screen.findByRole("heading", { level: 1, name: "我的申請" }),
    ).toBeTruthy();
    expect(screen.getByText("p04")).toBeTruthy();
  });
});

describe("導覽依後端回傳的工作區顯示", () => {
  it.each([
    { who: APPLICANT, labels: ["我的申請"] },
    { who: MANAGER, labels: ["我的申請", "待簽", "授權總覽"] },
    {
      who: EVERY_AREA,
      labels: ["我的申請", "待簽", "授權總覽", "執行", "稽核"],
    },
  ])(
    "桌面上方導覽：$who.profile.name 看到 $labels",
    async ({ who, labels }) => {
      stubBackend({ "GET /api/auth/me": () => jsonResponse(who) });
      renderApp("/");
      await screen.findByRole("heading", { level: 1, name: "我的申請" });
      expect(navLabels()).toEqual(labels);
      expect(document.querySelector(".bottomnav")).toBeNull();
    },
  );

  it("手機改用底部導覽（最多 5 項），並標出目前位置", async () => {
    setViewportWidth(390);
    stubBackend({ "GET /api/auth/me": () => jsonResponse(EVERY_AREA) });
    renderApp("/approvals/DA-2026-0142");
    await screen.findByRole("heading", { level: 1, name: "簽核詳情" });
    const nav = screen.getByRole("navigation", { name: "主要導覽" });
    expect(nav.className).toBe("bottomnav");
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(5);
    const current = links.filter(
      (link) => link.getAttribute("aria-current") === "page",
    );
    expect(current.map((link) => link.textContent)).toEqual(["待簽"]);
    expect(document.documentElement.classList.contains("has-bottomnav")).toBe(
      true,
    );
  });

  it("手機上只有一個去處的人不顯示底部導覽", async () => {
    setViewportWidth(390);
    stubBackend({ "GET /api/auth/me": () => jsonResponse(APPLICANT) });
    renderApp("/");
    await screen.findByRole("heading", { level: 1, name: "我的申請" });
    expect(screen.queryByRole("navigation", { name: "主要導覽" })).toBeNull();
  });

  it("沒有「我的申請」的人（只做稽核）首頁改送到他的第一個去處", async () => {
    stubBackend({ "GET /api/auth/me": () => jsonResponse(AUDITOR) });
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
    ["/fulfilment", "執行佇列", "MIS-Queue.dc.html"],
    ["/fulfilment/DA-1", "執行詳情", "MIS-Check.dc.html"],
    ["/mis", "執行佇列", "MIS-Queue.dc.html"],
    ["/mis/DA-1", "執行詳情", "MIS-Check.dc.html"],
    ["/settings", "系統設定", "MIS-Settings.dc.html"],
    ["/audit", "稽核查詢", "Audit-Search.dc.html"],
    ["/audit/DA-1", "證據頁", "Audit-Evidence.dc.html"],
  ])("%s 顯示「%s」並標明 %s", async (route, title, wireframe) => {
    stubBackend({ "GET /api/auth/me": () => jsonResponse(EVERY_AREA) });
    renderApp(route);
    expect(
      await screen.findByRole("heading", { level: 1, name: title }),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`docs/wireframes/${wireframe}`)),
    ).toBeTruthy();
  });

  it("詳情頁顯示網址上的單號", async () => {
    stubBackend({ "GET /api/auth/me": () => jsonResponse(EVERY_AREA) });
    renderApp("/mis/DA-2026-0142");
    expect(await screen.findByText("單號 DA-2026-0142")).toBeTruthy();
  });

  it("手機寬度的 /approvals 與 /approvals/:id 改照手機 wireframe", async () => {
    setViewportWidth(390);
    stubBackend({ "GET /api/auth/me": () => jsonResponse(EVERY_AREA) });
    const { unmount } = renderApp("/approvals");
    expect(
      await screen.findByRole("heading", { level: 1, name: "待我簽" }),
    ).toBeTruthy();
    expect(screen.getByText(/Mobile-Inbox\.dc\.html/)).toBeTruthy();
    unmount();
    renderApp("/approvals/DA-1");
    await screen.findByRole("heading", { level: 1, name: "簽核詳情" });
    const both =
      /Mobile-Review\.dc\.html、docs\/wireframes\/Mobile-MFA\.dc\.html/;
    expect(screen.getByText(both)).toBeTruthy();
  });

  it("不存在的網址顯示找不到頁面", async () => {
    stubBackend({ "GET /api/auth/me": () => jsonResponse(EVERY_AREA) });
    renderApp("/nope");
    const heading = await screen.findByRole("heading", {
      level: 1,
      name: "找不到這個頁面",
    });
    expect(heading).toBeTruthy();
  });

  it("開發模式有元件展示頁，不需要登入", async () => {
    stubBackend({ "GET /api/auth/me": UNAUTHENTICATED });
    renderApp("/dev/components");
    expect(
      await screen.findByRole("heading", { level: 1, name: "共用元件" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "DataList" })).toBeTruthy(),
    );
  });
});
