"use server";

import { audit, BusinessError, getDb, hashPassword, newId, ORG_ID, PERMISSIONS, requirePerm } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";

export async function addUser(_: ActionState, fd: FormData) {
  return act("users:manage", async (ctx) => {
    const email = str(fd, "email").toLowerCase();
    const pw = str(fd, "password");
    if (pw.length < 12) throw new BusinessError("Password must be at least 12 characters");
    const db = await getDb();
    if (await db.collection("users").findOne({ orgId: ORG_ID, email })) throw new BusinessError("A user with that email exists");
    const doc = { _id: newId(), orgId: ORG_ID, name: str(fd, "name"), email, role: str(fd, "role"), status: "active", passwordHash: hashPassword(pw), totpSecret: null, accessExpiresAt: str(fd, "accessExpiresAt") ? new Date(str(fd, "accessExpiresAt") + "T23:59:59+05:00") : null, createdAt: new Date(), createdBy: ctx.userId };
    await db.collection("users").insertOne(doc as never);
    await audit(ctx, "user.create", "user", doc._id, null, { email, role: doc.role });
    return "User added";
  }, ["/users"]);
}

export async function updateUser(_: ActionState, fd: FormData) {
  return act("users:manage", async (ctx) => {
    const db = await getDb();
    const id = str(fd, "id");
    const before = await db.collection("users").findOne({ _id: id as never });
    if (!before) throw new BusinessError("User not found");
    if (String(before._id) === ctx.userId && str(fd, "role") !== "owner" && before.role === "owner") throw new BusinessError("You cannot remove your own owner role");
    const set = { role: str(fd, "role"), status: str(fd, "status"), extraPermissions: fd.get("pii") === "on" ? ["pii:full"] : [], accessExpiresAt: str(fd, "accessExpiresAt") ? new Date(str(fd, "accessExpiresAt") + "T23:59:59+05:00") : null, updatedAt: new Date() };
    await db.collection("users").updateOne({ _id: id as never }, { $set: set });
    if (set.status !== "active") await db.collection("sessions").deleteMany({ userId: id });
    await audit(ctx, "user.update", "user", id, { role: before.role, status: before.status }, set);
    return "Saved";
  }, ["/users"]);
}

export async function saveRoles(_: ActionState, fd: FormData) {
  return act("users:manage", async (ctx) => {
    requirePerm(ctx, "users:manage");
    const db = await getDb();
    const roles = await db.collection("roles").find({ orgId: ORG_ID }).toArray();
    for (const r of roles) {
      const permissions = r.key === "owner" ? [...PERMISSIONS] : PERMISSIONS.filter((p) => fd.get(`${r.key}|${p}`) === "on");
      const requireTotp = fd.get(`${r.key}|__totp`) === "on";
      if (JSON.stringify(permissions) === JSON.stringify(r.permissions) && requireTotp === r.requireTotp) continue;
      await db.collection("roles").updateOne({ _id: r._id }, { $set: { permissions, requireTotp, updatedAt: new Date() } });
      await audit(ctx, "role.update", "role", r.key, { permissions: r.permissions }, { permissions, requireTotp });
    }
    return "Role matrix saved";
  }, ["/users"]);
}
