/**
 * 簡單的固定視窗計數器，放在記憶體裡（每個實例各算各的）。
 * 只用在登入與 MFA；要跨實例共用就得換成放在資料庫或反向代理上做。
 */
export interface RateDecision {
  allowed: boolean;
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(max: number, windowSec: number, now: () => number) {
    this.max = max;
    this.windowMs = windowSec * 1000;
    this.now = now;
  }

  /** 記一次。超過上限時 allowed=false。 */
  hit(key: string): RateDecision {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= 50_000) this.prune(now);
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return this.decide(bucket, now);
  }

  /** 只看不記：已經達到上限就是 allowed=false。 */
  peek(key: string): RateDecision {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return { allowed: true, retryAfterSec: 0 };
    return bucket.count >= this.max
      ? { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) }
      : { allowed: true, retryAfterSec: 0 };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private decide(bucket: { count: number; resetAt: number }, now: number): RateDecision {
    return bucket.count > this.max
      ? { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) }
      : { allowed: true, retryAfterSec: 0 };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
    // 清完還是滿的（有人在灌不同的 key）：整個清掉，寧可放寬也不要吃光記憶體。
    if (this.buckets.size >= 50_000) this.buckets.clear();
  }
}
