"use server";

import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { audit, BusinessError, getDb, hashPassword, verifyPassword } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";
import { SESSION_COOKIE } from "@/lib/session";

/** Change own password; every other session for this user is signed out. */
export async function changePassword(_: ActionState, fd: FormData) {
  return act(null, async (ctx) => {
    const current = String(fd.get("current") ?? "");
    const next = String(fd.get("next") ?? "");
    if (next.length < 12) throw new BusinessError("New password must be at least 12 characters");
    if (next !== String(fd.get("confirm") ?? "")) throw new BusinessError("The two new passwords do not match");
    if (next === current) throw new BusinessError("Choose a password different from the current one");
    if (/changeme/i.test(next)) throw new BusinessError("Choose a password that is not based on the seed password");
    const db = await getDb();
    const u = await db.collection("users").findOne({ _id: ctx.userId as never });
    if (!u || !verifyPassword(current, u.passwordHash)) throw new BusinessError("Current password is incorrect");
    await db.collection("users").updateOne({ _id: u._id }, { $set: { passwordHash: hashPassword(next), passwordChangedAt: new Date() } });
    const mine = (await cookies()).get(SESSION_COOKIE)?.value;
    const keep = mine ? createHash("sha256").update(mine).digest("hex") : "";
    const { deletedCount } = await db.collection("sessions").deleteMany({ userId: ctx.userId, _id: { $ne: keep as never } });
    await audit(ctx, "auth.password_changed", "user", ctx.userId, null, { otherSessionsSignedOut: deletedCount });
    return `Password changed${deletedCount ? `; ${deletedCount} other session(s) signed out` : ""}`;
  });
}
