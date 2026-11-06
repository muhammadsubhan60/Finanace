import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import { stableHash } from "@delta/core";
import { getDb, ORG_ID } from "./client";

/** Who is acting. Every service call carries one; it feeds the audit log. */
export interface Ctx {
  orgId: string;
  userId: string;
  userName: string;
  role: string;
  ip: string;
  requestId: string;
  permissions: string[];
}

export const systemCtx = (label = "system"): Ctx => ({
  orgId: ORG_ID,
  userId: label,
  userName: label,
  role: "system",
  ip: "internal",
  requestId: randomUUID(),
  permissions: ["*"],
});

export class PermissionError extends Error {
  constructor(perm: string) {
    super(`You do not have permission: ${perm}`);
  }
}
export class BusinessError extends Error {}

export function can(ctx: Ctx, perm: string): boolean {
  return ctx.permissions.includes("*") || ctx.permissions.includes(perm);
}
export function requirePerm(ctx: Ctx, perm: string): void {
  if (!can(ctx, perm)) throw new PermissionError(perm);
}

/** Append-only audit row for every write. Stores hashes of before/after plus a compact diff payload. */
export async function audit(ctx: Ctx, action: string, entity: string, entityId: string, before: unknown, after: unknown, session?: ClientSession) {
  const db = await getDb();
  await db.collection("audit_log").insertOne(
    {
      orgId: ctx.orgId,
      at: new Date(),
      userId: ctx.userId,
      userName: ctx.userName,
      role: ctx.role,
      ip: ctx.ip,
      requestId: ctx.requestId,
      action,
      entity,
      entityId,
      beforeHash: before == null ? null : stableHash(before),
      afterHash: after == null ? null : stableHash(after),
      after: after == null ? null : scrub(after),
    },
    { session },
  );
}

const SECRET_KEYS = /pass(word)?|token|secret|api_?key|credentials|totp/i;
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.slice(0, 50).map(scrub);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? "[redacted]" : scrub(x)]));
  }
  return v;
}

export const newId = () => randomUUID();
