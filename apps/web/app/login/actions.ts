"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit, createSession, getDb, newTotpSecret, ORG_ID, verifyPassword, verifyTotp, newId } from "@delta/db";
import { clientIp, getUser, SESSION_COOKIE } from "@/lib/session";

type State = { ok: boolean; error?: string; needTotp?: boolean } | null;
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

/** Rate limit on auth: max 5 failed attempts per email+IP per 15 minutes. */
async function limited(key: string) {
  const db = await getDb();
  const n = await db.collection("login_attempts").countDocuments({ key, at: { $gt: new Date(Date.now() - WINDOW_MS) } });
  return n >= MAX_ATTEMPTS;
}

export async function login(_: State, fd: FormData): Promise<State> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const code = String(fd.get("code") ?? "").trim();
  const ip = await clientIp();
  const key = `${email}|${ip}`;
  const db = await getDb();
  if (await limited(key)) return { ok: false, error: "Too many attempts. Try again in 15 minutes." };
  const u = await db.collection("users").findOne({ orgId: ORG_ID, email, status: "active" });
  const fail = async (error: string, needTotp = false) => {
    await db.collection("login_attempts").insertOne({ _id: newId() as never, key, at: new Date() });
    return { ok: false, error, needTotp };
  };
  if (!u || !verifyPassword(password, u.passwordHash)) return fail("Email or password is incorrect.");
  if (u.accessExpiresAt && u.accessExpiresAt < new Date()) return fail("Your access period has ended.");
  if (u.totpSecret) {
    if (!code) return { ok: false, needTotp: true };
    if (!verifyTotp(u.totpSecret, code)) return fail("That code is not valid.", true);
  }
  const ua = (await headers()).get("user-agent") ?? "";
  const s = await createSession(String(u._id), ip, ua);
  (await cookies()).set(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", expires: s.expiresAt, path: "/" });
  await audit({ orgId: ORG_ID, userId: String(u._id), userName: u.name, role: u.role, ip, requestId: newId(), permissions: [] }, "auth.login", "user", String(u._id), null, { ua });
  redirect("/dashboard");
}

export async function startTotp(): Promise<{ secret: string; uri: string }> {
  const u = await getUser();
  if (!u) redirect("/login");
  const secret = newTotpSecret();
  const db = await getDb();
  await db.collection("users").updateOne({ _id: u._id as never }, { $set: { pendingTotpSecret: secret } });
  return { secret, uri: `otpauth://totp/Delta%20Finance:${encodeURIComponent(u.email)}?secret=${secret}&issuer=Delta%20Finance` };
}

export async function confirmTotp(_: State, fd: FormData): Promise<State> {
  const u = await getUser();
  if (!u) redirect("/login");
  const db = await getDb();
  const doc = await db.collection("users").findOne({ _id: u._id as never });
  const code = String(fd.get("code") ?? "");
  if (!doc?.pendingTotpSecret || !verifyTotp(doc.pendingTotpSecret, code)) return { ok: false, error: "That code is not valid. Check your device time and try again." };
  await db.collection("users").updateOne({ _id: u._id as never }, { $set: { totpSecret: doc.pendingTotpSecret }, $unset: { pendingTotpSecret: "" } });
  await audit({ orgId: ORG_ID, userId: u._id, userName: u.name, role: u.role, ip: await clientIp(), requestId: newId(), permissions: [] }, "auth.totp_enabled", "user", u._id, null, { enabled: true });
  redirect("/dashboard");
}
