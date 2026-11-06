/** fetch with timeout, retries + exponential backoff, and rate-limit awareness (429 / Retry-After). */
export async function httpJson<T>(url: string, init: RequestInit & { timeoutMs?: number; retries?: number } = {}): Promise<T> {
  const retries = init.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text.slice(0, 500));
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError) throw e;
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
export class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(`HTTP ${status}: ${body}`);
  }
}
const backoff = (n: number) => Math.min(30_000, 500 * 2 ** n + Math.floor(Math.random() * 250));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Simple per-integration circuit breaker: opens after N consecutive failures for a cool-down. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  constructor(private threshold = 5, private coolDownMs = 5 * 60_000) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (Date.now() < this.openUntil) throw new Error("Circuit open: integration paused after repeated failures");
    try {
      const r = await fn();
      this.failures = 0;
      return r;
    } catch (e) {
      if (++this.failures >= this.threshold) this.openUntil = Date.now() + this.coolDownMs;
      throw e;
    }
  }
}

export const rupeesToMinor = (v: unknown): number => {
  const n = String(v ?? "0").replace(/[,\s]/g, "");
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?/.exec(n);
  if (!m) return 0;
  const minor = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || 0);
  return m[1] ? -minor : minor;
};
