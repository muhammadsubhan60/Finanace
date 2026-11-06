import { getDb, ORG_ID } from "@delta/db";
import { Card, PageHeader, Pagination, Table, Td, Th } from "@/components/ui";
import { FilterBar, FInput } from "@/components/filters";
import { requireUser } from "@/lib/session";
import { dt, qs } from "@/lib/utils";

export const metadata = { title: "Audit log" };
const PAGE = 100;

export default async function Audit({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireUser("audit:view");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page ?? 1));
  const db = await getDb();
  const q: Record<string, unknown> = { orgId: ORG_ID };
  if (sp.action) q.action = { $regex: `^${sp.action.replace(/[^\w.]/g, "")}` };
  if (sp.user) q.userName = { $regex: sp.user.replace(/[^\w ]/g, ""), $options: "i" };
  const [rows, total] = await Promise.all([db.collection("audit_log").find(q).sort({ at: -1 }).skip((page - 1) * PAGE).limit(PAGE).toArray(), db.collection("audit_log").countDocuments(q)]);
  return (
    <>
      <PageHeader title="Audit log" description="Every write: who, what, before/after hash, IP and request id. Append-only." />
      <FilterBar>
        <FInput name="action" label="Action prefix" value={sp.action} placeholder="journal." />
        <FInput name="user" label="User" value={sp.user} />
      </FilterBar>
      <Card>
        <Table>
          <thead><tr><Th>When</Th><Th>User</Th><Th>Action</Th><Th>Entity</Th><Th>Hashes (before → after)</Th><Th>IP</Th><Th>Request</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r._id)}>
                <Td>{dt(r.at)}</Td><Td>{r.userName}<div className="text-xs text-muted-foreground">{r.role}</div></Td><Td mono>{r.action}</Td>
                <Td className="text-[13px]">{r.entity}<div className="max-w-40 truncate font-mono text-xs text-muted-foreground">{r.entityId}</div></Td>
                <Td mono className="text-xs">{r.beforeHash?.slice(0, 8) ?? "∅"} → {r.afterHash?.slice(0, 8) ?? "∅"}</Td>
                <Td mono className="text-xs">{r.ip}</Td><Td mono className="text-xs">{String(r.requestId).slice(0, 8)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <Pagination page={page} pageSize={PAGE} total={total} hrefFor={(p) => qs(sp, { page: String(p) })} />
      </Card>
    </>
  );
}
