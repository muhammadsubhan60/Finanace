"use server";

import { enqueueJob, saveCredentials, setIntegrationEnabled, testConnection } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";

export async function test(_: ActionState, fd: FormData) {
  return act("integrations:manage", async (ctx) => {
    const r = await testConnection(ctx, str(fd, "id"));
    if (!r.ok) throw new Error(`Connection failed: ${r.error}`);
    return `Connected${r.message ? `: ${r.message}` : ""}`;
  });
}

export async function toggle(_: ActionState, fd: FormData) {
  return act("integrations:manage", async (ctx) => {
    await setIntegrationEnabled(ctx, str(fd, "id"), str(fd, "enabled") === "1");
    return "Updated";
  }, ["/integrations"]);
}

export async function resync(_: ActionState, fd: FormData) {
  return act("integrations:manage", async (ctx) => {
    await enqueueJob(ctx, "sync", { integrationId: str(fd, "id"), from: str(fd, "from"), to: str(fd, "to") });
    return "Queued — the worker will run it shortly";
  }, ["/integrations"]);
}

export async function saveCreds(_: ActionState, fd: FormData) {
  const values: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith("c:")) values[k.slice(2)] = String(v);
  return act("integrations:manage", async (ctx) => {
    await saveCredentials(ctx, str(fd, "id"), values, str(fd, "mode") === "live" ? "live" : "mock");
    return "Saved (encrypted)";
  }, ["/integrations"]);
}
