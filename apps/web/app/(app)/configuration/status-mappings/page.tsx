import { getCurrentProfile, getDb, ORG_ID } from "@delta/db";
import { NORMALIZED_STATUSES } from "@delta/config-schema";
import { addMonths, karachiDate, periodIdOf } from "@delta/core";
import { Badge, Card, CardHeader, Empty, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { has, requireUser } from "@/lib/session";
import { mapStatuses } from "../actions";

export const metadata = { title: "Status mappings" };

export default async function StatusMappings() {
  const u = await requireUser("profit:view");
  const profile = await getCurrentProfile();
  const db = await getDb();
  const unmapped = await db.collection("unmapped_statuses").find({ orgId: ORG_ID, resolved: { $ne: true } }).sort({ count: -1 }).toArray();
  const can = has(u, "config:propose");
  return (
    <>
      <PageHeader title="Courier status mappings" description="Provider status text → normalized status. New strings never break anything: they appear here and the shipment keeps its last known status until mapped." />
      <Card className="mb-4">
        <CardHeader title={`Unmapped statuses seen (${unmapped.length})`} />
        {unmapped.length === 0 ? <Empty title="All statuses seen so far are mapped" /> : (
          <ActionForm action={mapStatuses}>
            <Table>
              <thead><tr><Th>Courier</Th><Th>Provider status</Th><Th align="right">Seen</Th><Th>Example CN</Th><Th>Map to</Th></tr></thead>
              <tbody>
                {unmapped.map((s) => (
                  <tr key={String(s._id)}>
                    <Td>{s.provider}</Td><Td mono>{s.status}</Td><Td align="right">{s.count}</Td><Td mono>{s.example}</Td>
                    <Td>{s.pendingVersion ? <Badge tone="warning">in draft v{s.pendingVersion}</Badge> : (
                      <Select name={`m:${s.provider}:${s.status}`} className="h-8 w-52 text-[13px]" disabled={!can} aria-label={`Map ${s.status}`}>
                        <option value="">—</option>
                        {NORMALIZED_STATUSES.map((n) => <option key={n} value={n}>{n.replace(/_/g, " ")}</option>)}
                      </Select>
                    )}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {can ? (
              <div className="flex flex-wrap items-end gap-3 p-4 sm:px-5">
                <Field label="Effective from" htmlFor="ef"><Input id="ef" name="effectiveFrom" type="date" defaultValue={`${addMonths(periodIdOf(karachiDate()), 0)}-01`} required /></Field>
                <Submit size="sm">Create draft with these mappings</Submit>
              </div>
            ) : null}
          </ActionForm>
        )}
      </Card>
      <div className="grid gap-4 lg:grid-cols-3">
        {Object.entries(profile.statusMappings).map(([provider, map]) => (
          <Card key={provider}>
            <CardHeader title={provider} description={`${Object.keys(map).length} mappings (profile v${profile.version})`} />
            <Table>
              <thead><tr><Th>Provider status</Th><Th>Normalized</Th></tr></thead>
              <tbody>{Object.entries(map).map(([k, v]) => <tr key={k}><Td mono className="text-xs">{k}</Td><Td className="text-[13px]">{v.replace(/_/g, " ")}</Td></tr>)}</tbody>
            </Table>
          </Card>
        ))}
      </div>
    </>
  );
}
