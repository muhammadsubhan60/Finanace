import Link from "next/link";
import { acknowledgeAlert, evaluateAlerts, getDb, ORG_ID } from "@delta/db";
import { Badge, Card, CardHeader, Empty, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { requireUser } from "@/lib/session";
import { act, str, type ActionState } from "@/lib/action";
import { dt } from "@/lib/utils";

export const metadata = { title: "Alerts" };

async function ack(_: ActionState, fd: FormData) {
  "use server";
  return act("alerts:view", async (ctx) => {
    await acknowledgeAlert(ctx, str(fd, "id"));
    return "Acknowledged";
  }, ["/alerts", "/dashboard"]);
}
async function evaluate(_: ActionState) {
  "use server";
  return act("alerts:view", async () => `${await evaluateAlerts()} rules fired`, ["/alerts"]);
}

export default async function Alerts({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  await requireUser("alerts:view");
  const { all } = await searchParams;
  const db = await getDb();
  const [rows, rules] = await Promise.all([
    db.collection("alerts").find({ orgId: ORG_ID, ...(all ? {} : { acknowledgedAt: null }) }).sort({ createdAt: -1 }).limit(200).toArray(),
    db.collection("alert_rules").find({ orgId: ORG_ID }).toArray(),
  ]);
  return (
    <>
      <PageHeader title="Alerts" description="In-app only. Rules and thresholds are data (alert_rules); the worker evaluates them on a schedule." actions={<><ActionForm action={evaluate}><Submit variant="outline" size="sm">Evaluate now</Submit></ActionForm><Link className="self-center text-sm text-primary hover:underline" href={all ? "/alerts" : "/alerts?all=1"}>{all ? "Open only" : "Include acknowledged"}</Link></>} />
      <Card className="mb-4">
        <Table>
          <thead><tr><Th>Severity</Th><Th>Alert</Th><Th>Raised</Th><Th /></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={String(a._id)}>
                <Td><Badge tone={a.severity === "critical" ? "negative" : a.severity === "warning" ? "warning" : "primary"}>{a.severity}</Badge></Td>
                <Td><Link href={a.href ?? "#"} className="font-medium hover:underline">{a.title}</Link><div className="text-xs text-muted-foreground">{a.detail}</div></Td>
                <Td>{dt(a.createdAt)}</Td>
                <Td>{a.acknowledgedAt ? <span className="text-xs text-muted-foreground">Ack by {a.acknowledgedBy}</span> : <ActionForm action={ack}><input type="hidden" name="id" value={String(a._id)} /><Submit size="xs" variant="outline">Acknowledge</Submit></ActionForm>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {rows.length === 0 ? <Empty title="No alerts" /> : null}
      </Card>
      <Card>
        <CardHeader title="Rules" description="Edit thresholds in the alert_rules collection (admin UI: Configuration)." />
        <Table>
          <thead><tr><Th>Rule</Th><Th>Severity</Th><Th>Parameters</Th><Th>Enabled</Th></tr></thead>
          <tbody>{rules.map((r) => <tr key={String(r._id)}><Td>{r.label}</Td><Td>{r.severity}</Td><Td mono>{JSON.stringify(r.params)}</Td><Td>{r.enabled ? "Yes" : "No"}</Td></tr>)}</tbody>
        </Table>
      </Card>
    </>
  );
}
