import "server-only";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { BusinessError, PermissionError, type Ctx } from "@delta/db";
import { LedgerError } from "@delta/core";
import { getCtx } from "./session";

export type ActionState = { ok: boolean; message?: string; error?: string; at?: number } | null;

/**
 * Every mutation goes through here: authenticate → permission check (server-side) → run → friendly errors.
 * Next.js server actions also verify Origin against Host (CSRF protection on mutations).
 */
export async function act(perm: string | null, fn: (ctx: Ctx) => Promise<string | void>, revalidate: string[] = []): Promise<ActionState> {
  try {
    const ctx = await getCtx(perm ?? undefined);
    const message = (await fn(ctx)) ?? "Saved";
    for (const p of revalidate) revalidatePath(p);
    return { ok: true, message, at: Date.now() };
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e && String((e as { digest: string }).digest).startsWith("NEXT_REDIRECT")) throw e;
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), at: Date.now() };
    if (e instanceof BusinessError || e instanceof PermissionError || e instanceof LedgerError) return { ok: false, error: e.message, at: Date.now() };
    if (e instanceof Error && /must be|Invalid PKR|Unknown expense|disabled|paused|personal income tax|engine/.test(e.message)) return { ok: false, error: e.message, at: Date.now() };
    console.error("[action]", e);
    return { ok: false, error: "Something went wrong. The error was logged.", at: Date.now() };
  }
}

export const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
