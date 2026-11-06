import type { AgreementProfile, ApprovalRule } from "@delta/config-schema";
import type { Minor } from "./money";

export interface PolicyDecision {
  requiresApproval: boolean;
  rule: ApprovalRule | null;
  approverRoles: string[];
  mode: "any" | "all";
  reason: string;
}

/** Silence is not approval: an action with no rule, or a rule with no limit, always needs approval. */
export function evaluatePolicy(profile: AgreementProfile, action: string, amountMinor?: Minor, scope?: string): PolicyDecision {
  const rule = profile.approvalPolicy.find((r) => r.action === action && (!r.scope || !scope || r.scope === scope)) ?? null;
  if (!rule) return { requiresApproval: true, rule: null, approverRoles: ["owner"], mode: "any", reason: `No policy configured for "${action}" — approval required` };
  const limit = rule.limitMinor;
  if (limit == null) return { requiresApproval: true, rule, approverRoles: rule.approvers, mode: rule.mode, reason: "No limit configured — approval required" };
  if (amountMinor != null && amountMinor <= limit && limit > 0)
    return { requiresApproval: false, rule, approverRoles: rule.approvers, mode: rule.mode, reason: `Within limit` };
  return { requiresApproval: true, rule, approverRoles: rule.approvers, mode: rule.mode, reason: `Above limit` };
}

/** Has the set of approvals satisfied the rule? Requester never counts as approver when separation is required. */
export function approvalsSatisfied(decision: PolicyDecision, approvals: { userId: string; role: string; decision: "approve" | "reject" }[], requesterId: string): { satisfied: boolean; rejected: boolean; missingRoles: string[] } {
  if (approvals.some((a) => a.decision === "reject")) return { satisfied: false, rejected: true, missingRoles: [] };
  const sep = decision.rule?.requires === "requester_and_separate_approver";
  const valid = approvals.filter((a) => a.decision === "approve" && (!sep || a.userId !== requesterId));
  const rolesHave = new Set(valid.map((a) => a.role));
  const missing = decision.approverRoles.filter((r) => !rolesHave.has(r));
  const satisfied = decision.mode === "all" ? missing.length === 0 : missing.length < decision.approverRoles.length;
  return { satisfied, rejected: false, missingRoles: decision.mode === "all" ? missing : satisfied ? [] : decision.approverRoles };
}

export function assertCategoryAllowed(profile: AgreementProfile, categoryKey: string, labelHint = ""): void {
  if (profile.rejectPersonalIncomeTax && /personal.?income.?tax/i.test(categoryKey + " " + labelHint))
    throw new Error("A partner's personal income tax is not a venture expense and cannot be posted.");
  const c = profile.expenseCategories.find((x) => x.key === categoryKey);
  if (!c) throw new Error(`Unknown expense category "${categoryKey}"`);
  if (!c.enabled) throw new Error(`Category "${c.label}" is disabled`);
  if (c.type === "system") throw new Error(`Category "${c.label}" is managed by the engine`);
  if (c.paused) throw new Error(`Spending in "${c.label}" is paused`);
}

/** Diff two JSON values into a flat list of changed paths (for the profile diff view). */
export function diffObjects(a: unknown, b: unknown, path = ""): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (x: unknown) => x !== null && typeof x === "object";
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return [{ path: path || "(root)", before: a, after: b }];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  return [...keys].flatMap((k) => diffObjects((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}
