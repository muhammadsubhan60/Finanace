import { getDb, SEED_ROLES } from "@delta/db";
import { Badge, Card, CardBody, CardHeader, Field, Input, LinkButton, Notice, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { requireUser } from "@/lib/session";
import { dt } from "@/lib/utils";
import { changePassword } from "./actions";

export const metadata = { title: "My account" };

export default async function Account() {
  const u = await requireUser();
  const db = await getDb();
  const doc = await db.collection("users").findOne({ _id: u._id as never });
  const sessions = await db.collection("sessions").find({ userId: u._id }).sort({ createdAt: -1 }).toArray();
  return (
    <>
      <PageHeader title="My account" description={`${u.name} · ${u.email} · ${SEED_ROLES.find((r) => r.key === u.role)?.label ?? u.role}`} />
      {!doc?.passwordChangedAt ? <div className="mb-4"><Notice tone="warning">You are still using the initial password. Change it now.</Notice></div> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Change password" description="At least 12 characters. Other devices are signed out." />
          <CardBody>
            <ActionForm action={changePassword} className="grid gap-3" resetOnSuccess>
              <Field label="Current password" htmlFor="cur"><Input id="cur" name="current" type="password" autoComplete="current-password" required /></Field>
              <Field label="New password" htmlFor="new"><Input id="new" name="next" type="password" autoComplete="new-password" minLength={12} required /></Field>
              <Field label="Confirm new password" htmlFor="conf"><Input id="conf" name="confirm" type="password" autoComplete="new-password" minLength={12} required /></Field>
              <Submit>Change password</Submit>
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Security" />
          <CardBody className="grid gap-3 text-sm">
            <div className="flex items-center justify-between">Two-factor authentication {u.totpEnabled ? <Badge tone="positive">on</Badge> : <LinkButton href="/login/totp-setup" size="xs" variant="outline">Turn on</LinkButton>}</div>
            <div className="text-muted-foreground">Password last changed: {doc?.passwordChangedAt ? dt(doc.passwordChangedAt) : "never"}</div>
            <div>
              <div className="mb-1 font-medium">Active sessions ({sessions.length})</div>
              <ul className="grid gap-1 text-[13px] text-muted-foreground">{sessions.map((s) => <li key={String(s._id)}>{dt(s.createdAt)} · {s.ip} · {String(s.ua).slice(0, 60)}</li>)}</ul>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
