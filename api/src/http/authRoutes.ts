/**
 * 登入相關端點（都在 API_PREFIX/auth 底下）：
 *   GET  /auth/config        前端用來決定顯示哪一種登入畫面
 *   POST /auth/dev-login     只在 AUTH_MODE=dev 才有
 *   GET  /auth/oidc/login    只在 AUTH_MODE=oidc 才有；導到身分提供者
 *   GET  /auth/oidc/callback 身分提供者導回來
 *   GET  /auth/me
 *   POST /auth/logout
 *   POST /auth/mfa/verify    MFA step-up
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { SystemCalls } from '../contract/systemCalls.ts';
import { badRequest, HttpError, unauthorized } from '../errors.ts';
import type { MfaPort } from '../ports/mfa.ts';
import type { OidcPort } from '../ports/oidc.ts';
import { newSession, sign, verify, parseCookies, type SessionData } from '../session.ts';
import type { Sessions } from './context.ts';
import type { RateLimiter } from './rateLimit.ts';

export interface AuthDeps {
  config: Config;
  sessions: Sessions;
  sys: Pick<SystemCalls, 'me' | 'resolveLogin'>;
  mfa: MfaPort;
  oidc: OidcPort | null;
  limiter: RateLimiter;
  /** MFA 連續輸入錯誤的計數（依人）。 */
  mfaFailures: RateLimiter;
}

interface OidcState {
  state: string;
  nonce: string;
  cv: string;
  rt: string;
  exp: number;
}

const OIDC_PURPOSE = 'oidc-login';
const OIDC_STATE_TTL_SEC = 600;

const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/** 登入後要導回的位置只接受本站的相對路徑，避免被拿來當跳板。 */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || v.length > 2000) return '/';
  if (!v.startsWith('/') || v.startsWith('//') || /[\\\u0000-\u001f]/.test(v)) return '/';
  return v;
}

function plainBody(req: FastifyRequest): Record<string, unknown> {
  const b: unknown = req.body;
  return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { config, sessions, sys, mfa, oidc, limiter, mfaFailures } = deps;
  const base = `${config.apiPrefix}/auth`;
  const oidcCookie = `${config.cookieName}_oidc`;

  const throttle = (bucket: string, req: FastifyRequest): void => {
    const decision = limiter.hit(`${bucket}:${req.ctx.ip}`);
    if (!decision.allowed) {
      throw new HttpError(429, 'too_many_requests', '嘗試太多次，請稍後再試', {
        'retry-after': String(decision.retryAfterSec),
      });
    }
  };

  const describe = (session: SessionData, req: FastifyRequest, profile: unknown): Record<string, unknown> => {
    const mfaOk = sessions.mfaValid(session);
    return {
      actor_id: session.sub,
      auth_method: session.amr,
      session_expires_at: iso(session.exp),
      mfa_verified: mfaOk,
      mfa_verified_at: mfaOk && session.mfa !== null ? iso(session.mfa) : null,
      mfa_expires_at: mfaOk && session.mfa !== null ? iso(session.mfa + config.mfaTtlSec) : null,
      device: req.ctx.device,
      profile: profile ?? null,
    };
  };

  app.get(`${base}/config`, async () => ({
    auth_mode: config.authMode,
    oidc_enabled: oidc !== null,
    oidc_login_url: oidc !== null ? `${base}/oidc/login` : null,
    mfa_mode: config.mfaMode,
    mfa_ttl_sec: config.mfaTtlSec,
  }));

  // ── 開發用登入 ────────────────────────────────────────────────
  if (config.authMode === 'dev') {
    app.post(`${base}/dev-login`, async (req, reply) => {
      throttle('login', req);
      const raw = plainBody(req).actor_id;
      const actorId = typeof raw === 'number' ? String(raw) : raw;
      if (typeof actorId !== 'string' || actorId.trim() === '' || actorId.length > 200) {
        throw badRequest('actor_id_required', '請提供 actor_id');
      }
      const actor = actorId.trim();
      // 契約有提供「我的資料」function 時，順便確認這個人存在（不存在會丟 SQL 端定義的錯誤）。
      const profile = await sys.me(actor);
      const session = newSession(actor, 'dev', sessions.nowSec(), config.sessionTtlSec);
      sessions.write(reply, session);
      req.log.info({ actor, sid: session.sid }, '登入（dev）');
      return describe(session, req, profile);
    });
  }

  // ── OIDC ──────────────────────────────────────────────────────
  if (config.authMode === 'oidc') {
    const fail = (reply: FastifyReply, code: string): FastifyReply =>
      reply.redirect(`/?login_error=${encodeURIComponent(code)}`, 302);

    app.get(`${base}/oidc/login`, async (req, reply) => {
      if (oidc === null) {
        throw new HttpError(503, 'oidc_not_configured', '單一登入尚未設定完成，請聯絡系統管理員');
      }
      throttle('login', req);
      let start;
      try {
        start = await oidc.startLogin();
      } catch (err) {
        req.log.error({ err: String((err as Error)?.message ?? err) }, 'OIDC：無法開始登入');
        throw new HttpError(502, 'oidc_unavailable', '單一登入暫時無法使用，請稍後再試');
      }
      const state: OidcState = {
        state: start.state,
        nonce: start.nonce,
        cv: start.codeVerifier,
        rt: safeReturnTo((req.query as Record<string, unknown>).return_to),
        exp: sessions.nowSec() + OIDC_STATE_TTL_SEC,
      };
      sessions.setCookie(
        reply,
        oidcCookie,
        sign(OIDC_PURPOSE, state, config.sessionSecrets[0] as string),
        OIDC_STATE_TTL_SEC,
      );
      return reply.redirect(start.url, 302);
    });

    app.get(`${base}/oidc/callback`, async (req, reply) => {
      if (oidc === null) {
        throw new HttpError(503, 'oidc_not_configured', '單一登入尚未設定完成，請聯絡系統管理員');
      }
      throttle('login', req);
      const token = parseCookies(req.headers.cookie).get(oidcCookie);
      const state = verify<OidcState>(OIDC_PURPOSE, token, config.sessionSecrets);
      sessions.setCookie(reply, oidcCookie, '', 0);
      if (!state || typeof state.exp !== 'number' || state.exp < sessions.nowSec()) {
        return fail(reply, 'login_expired');
      }
      let identity;
      try {
        identity = await oidc.finishLogin(new URL(req.url, 'http://callback.invalid'), {
          state: state.state,
          nonce: state.nonce,
          codeVerifier: state.cv,
        });
      } catch (err) {
        req.log.warn({ err: String((err as Error)?.message ?? err) }, 'OIDC：登入驗證失敗');
        return fail(reply, 'login_failed');
      }
      const actor = await sys.resolveLogin(identity, req.ctx.ip, req.ctx.device);
      if (actor === null) {
        req.log.warn({ oidc_sub: identity.subject }, 'OIDC：身分沒有對應到本站的人員');
        return fail(reply, 'not_provisioned');
      }
      const session = newSession(actor, 'oidc', sessions.nowSec(), config.sessionTtlSec);
      sessions.write(reply, session);
      req.log.info({ actor, sid: session.sid }, '登入（oidc）');
      return reply.redirect(safeReturnTo(state.rt), 302);
    });
  }

  // ── 目前登入者 ────────────────────────────────────────────────
  app.get(`${base}/me`, async (req) => {
    const session = req.ctx.session;
    if (!session) throw unauthorized();
    return describe(session, req, await sys.me(session.sub));
  });

  app.post(`${base}/logout`, async (req, reply) => {
    if (req.ctx.session) req.log.info({ actor: req.ctx.actor, sid: req.ctx.sessionId }, '登出');
    sessions.clear(reply);
    return reply.code(204).send();
  });

  // ── MFA step-up ───────────────────────────────────────────────
  app.post(`${base}/mfa/verify`, async (req, reply) => {
    const session = req.ctx.session;
    if (!session) throw unauthorized();
    throttle('mfa', req);
    const failKey = `mfa-fail:${session.sub}`;
    const locked = mfaFailures.peek(failKey);
    if (!locked.allowed) {
      throw new HttpError(429, 'mfa_locked', '驗證碼輸入錯誤太多次，請稍後再試', {
        'retry-after': String(locked.retryAfterSec),
      });
    }
    const code = plainBody(req).code;
    if (typeof code !== 'string' || code.trim() === '' || code.length > 16) {
      throw badRequest('code_required', '請輸入驗證碼');
    }
    const result = await mfa.verify(session.sub, code);
    if (result === 'not_enrolled') {
      throw new HttpError(409, 'mfa_not_enrolled', '你還沒有設定多因子驗證，請聯絡系統管理員');
    }
    if (result !== 'ok') {
      mfaFailures.hit(failKey);
      req.log.warn({ actor: session.sub, sid: session.sid }, 'MFA 驗證失敗');
      throw new HttpError(422, 'mfa_invalid', '驗證碼不正確');
    }
    mfaFailures.reset(failKey);
    session.mfa = sessions.nowSec();
    sessions.write(reply, session);
    req.log.info({ actor: session.sub, sid: session.sid }, 'MFA 驗證成功');
    return {
      mfa_verified: true,
      mfa_verified_at: iso(session.mfa),
      mfa_expires_at: iso(session.mfa + config.mfaTtlSec),
    };
  });
}
