/**
 * Money is always an integer number of paisa (1 PKR = 100 paisa).
 * Values stay well inside Number.MAX_SAFE_INTEGER (≈ 90 trillion PKR); every op asserts integers.
 */
export type Minor = number;

export function assertMinor(n: number, label = "amount"): asserts n is Minor {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be an integer number of paisa, got ${n}`);
}

/** Parse "1,500.5" / "1500" / "-20.25" PKR text into paisa without floating point. */
export function parsePKR(input: string | number): Minor {
  const s = String(input).replace(/[,\s]|PKR|Rs\.?/gi, "");
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid PKR amount: "${input}"`);
  const minor = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || 0);
  assertMinor(minor);
  return m[1] ? -minor : minor;
}

export function toPKRString(minor: Minor): string {
  assertMinor(minor);
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100);
  const paisa = abs % 100;
  return `${neg ? "-" : ""}${rupees}${paisa ? "." + String(paisa).padStart(2, "0") : ""}`;
}

const fmt = new Intl.NumberFormat("en-PK", { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Display only. Rounds to whole rupees unless `exact`. */
export function formatPKR(minor: Minor, opts: { exact?: boolean; sign?: boolean } = {}): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const body = opts.exact ? fmt2.format(Math.floor(abs / 100)).replace(/\.00$/, "") + "." + String(abs % 100).padStart(2, "0") : fmt.format(Math.round(abs / 100));
  return `${neg ? "−" : opts.sign ? "+" : ""}Rs ${body}`;
}

export function sum(values: readonly Minor[]): Minor {
  let t = 0;
  for (const v of values) {
    assertMinor(v);
    t += v;
  }
  assertMinor(t, "sum");
  return t;
}

/** Integer division rounded half away from zero. */
export function roundDiv(numerator: number, denominator: number): number {
  assertMinor(numerator, "numerator");
  assertMinor(denominator, "denominator");
  if (denominator === 0) throw new Error("Division by zero");
  const big = (BigInt(numerator) * 2n + BigInt(denominator) * (numerator < 0 !== denominator < 0 ? -1n : 1n)) / (BigInt(denominator) * 2n);
  return Number(big);
}

/** Percentage (e.g. 30 or 33.34) expressed as integer basis points (1% = 100 bps). */
export function pctToBps(pct: number): number {
  const bps = Math.round(pct * 100);
  if (Math.abs(bps - pct * 100) > 1e-6) throw new Error(`Percentage ${pct} has more than 2 decimals`);
  return bps;
}

/** round(amount × pct%) with integer math. */
export function applyPct(amount: Minor, pct: number): Minor {
  return roundDiv(amount * pctToBps(pct), 10_000);
}

/**
 * Split `total` by integer weights using the largest-remainder method.
 * Sum of parts always equals total; ties break by input order (deterministic).
 */
export function allocateLargestRemainder(total: Minor, weights: readonly number[]): Minor[] {
  assertMinor(total, "total");
  if (weights.length === 0) throw new Error("No weights");
  weights.forEach((w) => {
    if (!Number.isSafeInteger(w) || w < 0) throw new Error("Weights must be non-negative integers");
  });
  const wSum = weights.reduce((a, b) => a + b, 0);
  if (wSum === 0) throw new Error("Weights sum to zero");
  const sign = total < 0 ? -1n : 1n;
  const T = BigInt(Math.abs(total));
  const W = BigInt(wSum);
  const base = weights.map((w) => (T * BigInt(w)) / W);
  const rema = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % W }));
  let left = T - base.reduce((a, b) => a + b, 0n);
  rema.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rema) {
    if (left <= 0n) break;
    base[i] = base[i]! + 1n;
    left -= 1n;
  }
  return base.map((b) => Number(b * sign));
}

/** Split by percentage shares (e.g. [33.34, 33.33, 33.33]). */
export function allocateByPct(total: Minor, pcts: readonly number[]): Minor[] {
  return allocateLargestRemainder(total, pcts.map(pctToBps));
}
