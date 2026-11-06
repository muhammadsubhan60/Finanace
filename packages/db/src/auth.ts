import { createHmac, randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { getDb, ORG_ID } from "./client";
import type { Ctx } from "./context";

export const PERMISSIONS = [
  "dashboard:view", "profit:view", "orders:view", "shipments:view", "pii:full",
  "expense:create", "expense:approve", "import:upload", "shipments:manage",
  "objection:raise", "objection:resolve", "approval:request",
  "config:propose", "config:approve", "tranche:propose", "tranche:approve", "tranche:release",
  "withdrawal:request", "withdrawal:approve", "withdrawal:pay",
  "period:close", "journal:adjust", "report:issue", "stock:manage", "integrations:manage",
  "users:manage", "audit:view", "alerts:view",
] as const;

/** Seed role matrix (editable in Users & Roles). */
export const SEED_ROLES: { key: string; label: string; permissions: string[]; requireTotp: boolean }[] = [
  { key: "owner", label: "Owner (Investor)", permissions: [...PERMISSIONS], requireTotp: true },
  {
    key: "md",
    label: "Managing Director",
    permissions: ["dashboard:view", "profit:view", "orders:view", "shipments:view", "pii:full", "expense:create", "import:upload", "shipments:manage", "objection:raise", "approval:request", "config:propose", "config:approve", "tranche:propose", "tranche:approve", "withdrawal:request", "stock:manage", "audit:view", "alerts:view"],
    requireTotp: false,
  },
  {
    key: "finance_reviewer",
    label: "Finance Reviewer (CFO)",
    permissions: ["dashboard:view", "profit:view", "orders:view", "shipments:view", "import:upload", "shipments:manage", "period:close", "journal:adjust", "report:issue", "objection:resolve", "withdrawal:pay", "tranche:release", "stock:manage", "audit:view", "alerts:view", "config:propose"],
    requireTotp: true,
  },
  { key: "staff", label: "Staff", permissions: ["orders:view", "shipments:view"], requireTotp: false },
  { key: "accountant", label: "Independent Accountant", permissions: ["dashboard:view", "profit:view", "orders:view", "shipments:view", "audit:view", "objection:raise", "objection:resolve"], requireTotp: false },
];

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [, s, k] = stored.split("$");
  if (!s || !k) return false;
  const key = scryptSync(pw, Buffer.from(s, "base64"), 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(key, Buffer.from(k, "base64"));
}

// ---- TOTP (RFC 6238, SHA-1, 30s, 6 digits) ----
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret(): string {
  return [...randomBytes(20)].map((b) => B32[b % 32]).join("");
}
function b32decode(s: string): Buffer {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((b) => parseInt(b, 2)));
}
export function totpCode(secret: string, t = Date.now(), step = 0): string {
  const counter = Math.floor(t / 30000) + step;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}
export function verifyTotp(secret: string, code: string): boolean {
  return [-1, 0, 1].some((s) => totpCode(secret, Date.now(), s) === code.trim());
}

// ---- Sessions (server-side) ----
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function createSession(userId: string, ip: string, ua: string): Promise<{ token: string; expiresAt: Date }> {
  const db = await getDb();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.collection("sessions").insertOne({ _id: tokenHash(token) as never, userId, ip, ua, createdAt: new Date(), expiresAt });
  return { token, expiresAt };
}

export async function destroySession(token: string) {
  const db = await getDb();
  await db.collection("sessions").deleteOne({ _id: tokenHash(token) as never });
}

export interface SessionUser {
  _id: string;
  name: string;
  email: string;
  role: string;
  partnerId?: string;
  permissions: string[];
  totpEnabled: boolean;
  mustEnableTotp: boolean;
  expiresAt?: Date;
}

export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const db = await getDb();
  const s = await db.collection("sessions").findOne({ _id: tokenHash(token) as never });
  if (!s || s.expiresAt < new Date()) return null;
  const u = await db.collection("users").findOne({ _id: s.userId as never, orgId: ORG_ID, status: "active" });
  if (!u) return null;
  if (u.accessExpiresAt && u.accessExpiresAt < new Date()) return null; // time-limited accountant access
  const role = await db.collection("roles").findOne({ orgId: ORG_ID, key: u.role });
  return {
    _id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    partnerId: u.partnerId,
    permissions: [...(role?.permissions ?? []), ...(u.extraPermissions ?? [])],
    totpEnabled: !!u.totpSecret,
    mustEnableTotp: !!role?.requireTotp && !u.totpSecret,
  };
}

export function ctxFromUser(u: SessionUser, ip: string, requestId: string): Ctx {
  return { orgId: ORG_ID, userId: u._id, userName: u.name, role: u.role, ip, requestId, permissions: u.permissions };
}
