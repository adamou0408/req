// 挑戰值的產生與一次性消耗。
//
// 「產生挑戰值」是一個可替換的函式（ChallengeGenerator）：探針預設用亂數，
// 之後換成呼叫資料庫（api.challenge_issue／api.passkey_register_begin），
// 由資料庫產生並綁定單號、版本、內容雜湊。
import { randomBytes, randomUUID } from 'node:crypto';

export type ChallengePurpose = 'register' | 'confirm';

export interface ChallengeContext {
    purpose: ChallengePurpose;
    /** 發給誰：iss|sub。 */
    userKey: string;
    /** 呼叫端想綁定的內容（例如單號與決定種類）。預設產生器只原樣記錄，不做任何判斷。 */
    binding?: Record<string, unknown>;
}

export interface IssuedChallenge {
    /** 送回驗證時用來找回「預期的挑戰值」。 */
    challengeId: string;
    challenge: Buffer;
    expiresAt: number;
    binding: Record<string, unknown>;
}

export type ChallengeGenerator = (context: ChallengeContext) => Promise<IssuedChallenge>;

const CHALLENGE_BYTES = 32;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const randomChallenge: ChallengeGenerator = async (context) => ({
    challengeId: randomUUID(),
    challenge: randomBytes(CHALLENGE_BYTES),
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    binding: { purpose: context.purpose, ...context.binding },
});

export class ChallengeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

interface Pending {
    issued: IssuedChallenge;
    context: ChallengeContext;
}

/** 記住發出去的挑戰值；驗證時取出即作廢（不論驗證成敗），所以同一個挑戰值只能試一次。 */
export class ChallengeRegistry {
    private readonly pending = new Map<string, Pending>();
    private readonly generate: ChallengeGenerator;

    constructor(generate: ChallengeGenerator = randomChallenge) {
        this.generate = generate;
    }

    async issue(context: ChallengeContext): Promise<IssuedChallenge> {
        const issued = await this.generate(context);
        this.pending.set(issued.challengeId, { issued, context });
        return issued;
    }

    take(challengeId: string, purpose: ChallengePurpose, userKey: string): IssuedChallenge {
        const found = this.pending.get(challengeId);
        this.pending.delete(challengeId);
        if (!found) throw new ChallengeError('CHALLENGE_UNKNOWN', '挑戰值不存在或已經用過');
        if (found.context.purpose !== purpose) throw new ChallengeError('CHALLENGE_PURPOSE', '挑戰值的用途不符');
        if (found.context.userKey !== userKey) throw new ChallengeError('CHALLENGE_OWNER', '挑戰值不是發給這位使用者的');
        if (Date.now() > found.issued.expiresAt) throw new ChallengeError('CHALLENGE_EXPIRED', '挑戰值已過期');
        return found.issued;
    }
}
