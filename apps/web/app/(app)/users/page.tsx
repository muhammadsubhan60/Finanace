import { getDb, ORG_ID, PERMISSIONS } from "@delta/db";
import { Badge, Card, CardBody, CardHeader, Field, Input, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { requireUser } from "@/lib/session";
import { day } from "@/lib/utils";
import { addUser, saveRoles, updateUser } from "./actions";

export const metadata = { title: "Users & Roles" };

export default async function Users() {
  await requireUser("users:manage");
  const db = await getDb();
  const [users, roles] = await Promise.all([db.collection("users").find({ orgId: ORG_ID }).sort({ role: 1 }).toArray(), db.collection("roles").find({ orgId: ORG_ID }).toArray()]);
  const roleOpts = roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>);
  return (
    <>
      <PageHeader title="Users & Roles" description="Permissions are a configurable matrix, enforced on the server for every page and action. Deny by default." />
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card>
          <CardHeader title="Users" />
          <Table>
            <thead><tr><Th>User</Th><Th>Role</Th><Th>2FA</Th><Th>Access until</Th><Th>Update</Th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={String(u._id)}>
                  <Td>{u.name}<div className="text-xs text-muted-foreground">{u.email}</div></Td>
                  <Td>{roles.find((r) => r.key === u.role)?.label ?? u.role}{u.status !== "active" ? <Badge tone="negative">{u.status}</Badge> : null}</Td>
                  <Td>{u.totpSecret ? <Badge tone="positive">on</Badge> : <Badge>off</Badge>}</Td>
                  <Td>{u.accessExpiresAt ? day(u.accessExpiresAt) : "—"}</Td>
                  <Td>
                    <ActionForm action={updateUser} className="flex flex-wrap gap-1.5">
                      <input type="hidden" name="id" value={String(u._id)} />
                      <Select name="role" defaultValue={u.role} className="h-8 w-40 text-[13px]" aria-label="Role">{roleOpts}</Select>
                      <Select name="status" defaultValue={u.status} className="h-8 w-28 text-[13px]" aria-label="Status"><option value="active">active</option><option value="archived">archived</option></Select>
                      <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="pii" defaultChecked={(u.extraPermissions ?? []).includes("pii:full")} className="size-4" /> full phone</label>
                      <Input name="accessExpiresAt" type="date" defaultValue={u.accessExpiresAt ? new Date(u.accessExpiresAt).toISOString().slice(0, 10) : ""} className="h-8 w-36 text-[13px]" aria-label="Access until" />
                      <Submit size="xs" variant="outline">Save</Submit>
                    </ActionForm>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card className="self-start">
          <CardHeader title="Add user" description="Users are archived, never deleted." />
          <CardBody>
            <ActionForm action={addUser} className="grid gap-3" resetOnSuccess>
              <Field label="Name" htmlFor="n"><Input id="n" name="name" required /></Field>
              <Field label="Email" htmlFor="e"><Input id="e" name="email" type="email" required /></Field>
              <Field label="Role" htmlFor="r"><Select id="r" name="role">{roleOpts}</Select></Field>
              <Field label="Temporary password" htmlFor="p" hint="At least 12 characters"><Input id="p" name="password" type="password" minLength={12} required autoComplete="new-password" /></Field>
              <Field label="Access until (accountant)" htmlFor="x"><Input id="x" name="accessExpiresAt" type="date" /></Field>
              <Submit>Add user</Submit>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="Role matrix" description="Owner keeps all permissions. Changes are audited." />
        <ActionForm action={saveRoles}>
          <Table>
            <thead><tr><Th>Permission</Th>{roles.map((r) => <Th key={r.key}>{r.label}</Th>)}</tr></thead>
            <tbody>
              {PERMISSIONS.map((p) => (
                <tr key={p}>
                  <Td mono className="text-xs">{p}</Td>
                  {roles.map((r) => <Td key={r.key}><input type="checkbox" name={`${r.key}|${p}`} defaultChecked={r.permissions.includes(p)} disabled={r.key === "owner"} aria-label={`${r.label}: ${p}`} className="size-4" /></Td>)}
                </tr>
              ))}
              <tr><Td>Require 2FA</Td>{roles.map((r) => <Td key={r.key}><input type="checkbox" name={`${r.key}|__totp`} defaultChecked={r.requireTotp} aria-label={`${r.label} requires 2FA`} className="size-4" /></Td>)}</tr>
            </tbody>
          </Table>
          <div className="p-4 sm:px-5"><Submit size="sm">Save role matrix</Submit></div>
        </ActionForm>
      </Card>
    </>
  );
}
