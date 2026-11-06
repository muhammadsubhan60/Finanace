import { getDb, ORG_ID } from "@delta/db";
import { Badge, Card, CardHeader, Empty, Input, PageHeader, StatusBadge } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { requireUser } from "@/lib/session";
import { dt, pkr } from "@/lib/utils";
import { decide } from "./actions";

export const metadata = { title: "Approvals" };

export default async function Approvals({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const u = await requireUser();
  const { show } = await searchParams;
  const db = await getDb();
  const rows = await db.collection("approvals").find({ orgId: ORG_ID, ...(show === "all" ? {} : { status: "pending" }) }).sort({ createdAt: -1 }).limit(100).toArray();
  return (
    <>
      <PageHeader title="Approvals" description="Every approval records user, time, IP and comment. Requesters cannot approve their own requests where separation is required." actions={<a href={show === "all" ? "/approvals" : "/approvals?show=all"} className="text-sm text-primary hover:underline">{show === "all" ? "Pending only" : "Show history"}</a>} />
      {rows.length === 0 ? <Card><Empty title="Nothing waiting for approval" /></Card> : null}
      <div className="grid gap-3">
        {rows.map((a) => {
          const mine = a.decision.approverRoles.includes(u.role) && !a.decisions.some((d: { userId: string }) => d.userId === u._id) && a.status === "pending";
          const selfBlocked = a.decision.rule?.requires === "requester_and_separate_approver" && a.requesterId === u._id;
          return (
            <Card key={String(a._id)}>
              <CardHeader
                title={a.title}
                description={`${a.kind.replace(/_/g, " ")} · requested by ${a.requesterName} · ${dt(a.createdAt)}${a.amountMinor ? ` · ${pkr(a.amountMinor)}` : ""}`}
                action={<StatusBadge status={a.status} />}
              />
              <div className="grid gap-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="text-muted-foreground">Needs {a.decision.mode === "all" ? "all of" : "any of"}:</span>
                  {a.decision.approverRoles.map((r: string) => {
                    const d = a.decisions.find((x: { role: string }) => x.role === r);
                    return <Badge key={r} tone={d ? (d.decision === "approve" ? "positive" : "negative") : "neutral"}>{r}{d ? ` · ${d.userName}` : ""}</Badge>;
                  })}
                  <span className="text-xs text-muted-foreground">({a.decision.reason})</span>
                </div>
                {a.decisions.length ? (
                  <ul className="grid gap-1 text-[13px]">
                    {a.decisions.map((d: { userName: string; decision: string; comment: string; at: Date; ip: string }, i: number) => (
                      <li key={i}><span className="font-medium">{d.userName}</span> {d.decision}d · {dt(d.at)} · IP {d.ip}{d.comment ? ` — “${d.comment}”` : ""}</li>
                    ))}
                  </ul>
                ) : null}
                {mine && !selfBlocked ? (
                  <ActionForm action={decide} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={String(a._id)} />
                    <Input name="comment" placeholder="Comment (required to reject)" className="h-9 max-w-md" aria-label="Comment" />
                    <Submit size="sm" variant="positive">Approve</Submit>
                    <button name="decision" value="reject" className="h-9 rounded-md border border-input px-3 text-sm font-medium text-negative hover:bg-negative-soft">Reject</button>
                  </ActionForm>
                ) : selfBlocked && a.status === "pending" ? <p className="text-xs text-muted-foreground">You requested this; a separate approver must decide.</p> : null}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
