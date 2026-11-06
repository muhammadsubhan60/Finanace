"use server";

import { decideApproval } from "@delta/db";
import { act, str, type ActionState } from "@/lib/action";

export async function decide(_: ActionState, fd: FormData) {
  const decision = str(fd, "decision") === "reject" ? "reject" : "approve";
  return act(null, async (ctx) => {
    const r = await decideApproval(ctx, str(fd, "id"), decision, str(fd, "comment"));
    return r.status === "pending" ? `Recorded. Still waiting for: ${r.missingRoles.join(", ")}` : `Request ${r.status}`;
  }, ["/approvals", "/expenses", "/capital", "/partners", "/configuration", "/periods"]);
}
