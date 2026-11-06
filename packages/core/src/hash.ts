import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function stableHash(value: unknown): string {
  return sha256(stableStringify(value));
}
