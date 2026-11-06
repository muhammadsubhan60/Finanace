import "server-only";
import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { can, ctxFromUser, resolveSession, type Ctx, type SessionUser } from "@delta/db";

/**
 * `__Host-` in production: browser only accepts it from this exact host over HTTPS, with no Domain attribute,
 * so the parent site (deltalabs.tech) or a sibling subdomain can't set or overwrite the session cookie.
 */
export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-df_session" : "df_session";

export const getUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
});

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/** Server-side gate for pages. Deny by default: missing permission → 403 page. */
export async function requireUser(perm?: string): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect("/login");
  if (u.mustEnableTotp) redirect("/login/totp-setup");
  if (perm && !u.permissions.includes(perm)) redirect(`/forbidden?need=${encodeURIComponent(perm)}`);
  return u;
}

export async function getCtx(perm?: string): Promise<Ctx> {
  const u = await requireUser(perm);
  const h = await headers();
  return ctxFromUser(u, await clientIp(), h.get("x-request-id") ?? randomUUID());
}

export function has(u: SessionUser, perm: string) {
  return u.permissions.includes("*") || u.permissions.includes(perm);
}
export { can };
