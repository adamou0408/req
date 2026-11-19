// 伺服器端的工作階段（記憶體內）。瀏覽器只拿到隨機的 id，放在 httpOnly cookie。
// 探針用：重啟就清空。之後改由資料庫的 api.session_open 發 session token。
import { randomBytes } from 'node:crypto';
import type { PendingLogin } from './oidc.ts';

export interface SessionUser {
    /** 穩定識別：iss + sub。 */
    iss: string;
    sub: string;
    /** 目錄帳號（LDAP uid），用來和人員資料對起來。 */
    uid: string;
    name: string;
    email: string;
    groups: string[];
}

export interface Session {
    id: string;
    createdAt: number;
    user?: SessionUser;
    pendingLogin?: PendingLogin;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const LOGIN_TTL_MS = 10 * 60 * 1000;

export class SessionStore {
    private readonly sessions = new Map<string, Session>();

    create(): Session {
        const session: Session = { id: randomBytes(32).toString('base64url'), createdAt: Date.now() };
        this.sessions.set(session.id, session);
        return session;
    }

    get(id: string | undefined): Session | undefined {
        if (!id) return undefined;
        const session = this.sessions.get(id);
        if (!session) return undefined;
        if (Date.now() - session.createdAt > SESSION_TTL_MS) {
            this.sessions.delete(id);
            return undefined;
        }
        return session;
    }

    /** 取出並清掉等待中的登入；過期的視為不存在。 */
    takePendingLogin(session: Session): PendingLogin | undefined {
        const pending = session.pendingLogin;
        session.pendingLogin = undefined;
        if (!pending || Date.now() - pending.createdAt > LOGIN_TTL_MS) return undefined;
        return pending;
    }

    /** 登入成功時換一個新 id，避免 session fixation。 */
    promote(old: Session, user: SessionUser): Session {
        this.sessions.delete(old.id);
        const session = this.create();
        session.user = user;
        return session;
    }

    destroy(id: string): void {
        this.sessions.delete(id);
    }
}
