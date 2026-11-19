/** 請求脈絡：actor、ip、device、mfa_verified。每個請求一開始就算好，掛在 req.ctx。 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { Device, RouteCtx } from '../routing/types.ts';
import { openSession, parseCookies, sealSession, serializeCookie, type SessionData } from '../session.ts';

export interface RequestContext extends RouteCtx {
  session: SessionData | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini/i;

/** 依 User-Agent（與 Client Hints，如果瀏覽器有送）判斷手機或桌機。 */
export function detectDevice(userAgent: string | undefined, chMobile?: string | undefined): Device {
  if (chMobile === '?1') return 'mobile';
  if (chMobile === '?0') return 'desktop';
  return userAgent !== undefined && MOBILE_UA.test(userAgent) ? 'mobile' : 'desktop';
}

/** session 多久沒更新「最後活動時間」就重發一次 cookie。 */
const REFRESH_AFTER_SEC = 60;

export class Sessions {
  private readonly config: Config;
  private readonly now: () => number;

  constructor(config: Config, now: () => number) {
    this.config = config;
    this.now = now;
  }

  nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  read(req: FastifyRequest): SessionData | null {
    const token = parseCookies(req.headers.cookie).get(this.config.cookieName);
    return openSession(token, this.config.sessionSecrets, this.nowSec(), this.config.sessionIdleSec);
  }

  write(reply: FastifyReply, session: SessionData): void {
    const value = sealSession(session, this.config.sessionSecrets[0] as string);
    this.setCookie(reply, this.config.cookieName, value, session.exp - this.nowSec());
  }

  clear(reply: FastifyReply): void {
    this.setCookie(reply, this.config.cookieName, '', 0);
  }

  /** 設定 cookie；同一個回應裡同名的舊值會被換掉，不會送出兩個。 */
  setCookie(reply: FastifyReply, name: string, value: string, maxAge: number): void {
    const existing = reply.getHeader('set-cookie');
    const kept = (Array.isArray(existing) ? existing : existing ? [String(existing)] : []).filter(
      (c) => !c.startsWith(`${name}=`),
    );
    reply.removeHeader('set-cookie');
    reply.header('set-cookie', [...kept, serializeCookie(name, value, { secure: this.config.cookieSecure, maxAge })]);
  }

  mfaValid(session: SessionData | null): boolean {
    if (!session || session.mfa === null) return false;
    const age = this.nowSec() - session.mfa;
    return age >= 0 && age < this.config.mfaTtlSec;
  }

  /** 建立這個請求的脈絡；順便延長 session 的閒置計時。 */
  buildContext(req: FastifyRequest, reply: FastifyReply): RequestContext {
    const session = this.read(req);
    if (session && this.nowSec() - session.seen >= REFRESH_AFTER_SEC) {
      session.seen = this.nowSec();
      this.write(reply, session);
    }
    const ua = req.headers['user-agent'];
    const chMobile = req.headers['sec-ch-ua-mobile'];
    const mfaVerified = this.mfaValid(session);
    return {
      session,
      actor: session?.sub ?? null,
      sessionId: session?.sid ?? null,
      ip: req.ip,
      device: detectDevice(ua, Array.isArray(chMobile) ? chMobile[0] : chMobile),
      userAgent: (ua ?? '').slice(0, 500),
      mfaVerified,
      mfaVerifiedAt: mfaVerified && session?.mfa != null ? new Date(session.mfa * 1000).toISOString() : null,
      requestId: req.id,
    };
  }
}
