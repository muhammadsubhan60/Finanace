import { getDb, listIntegrations, ORG_ID } from "@delta/db";
import { addDays, karachiDate } from "@delta/core";
import { Badge, Card, CardBody, CardHeader, Field, Input, Notice, PageHeader, Select, Table, Td, Th } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { has, requireUser } from "@/lib/session";
import { dt } from "@/lib/utils";
import { resync, saveCreds, test, toggle } from "./actions";

export const metadata = { title: "Integrations" };

/** Credential fields per provider, from the provider docs. */
const FIELDS: Record<string, { key: string; label: string; secret?: boolean }[]> = {
  shopify: [{ key: "shopDomain", label: "Shop domain (x.myshopify.com)" }, { key: "accessToken", label: "Admin API access token", secret: true }, { key: "apiVersion", label: "API version (e.g. 2026-10)" }, { key: "webhookSecret", label: "Webhook signing secret", secret: true }],
  leopards: [{ key: "apiKey", label: "API key", secret: true }, { key: "apiPassword", label: "API password", secret: true }, { key: "baseUrl", label: "Base URL (blank = production)" }, { key: "webhookSecret", label: "Push API shared secret (x-api-key header)", secret: true }],
  tcs: [{ key: "bearerToken", label: "Bearer token (issued by TCS)", secret: true }, { key: "clientId", label: "Client ID (only if no Bearer token)" }, { key: "clientSecret", label: "Client secret (only if no Bearer token)", secret: true }, { key: "username", label: "eCom username (Authentication API)" }, { key: "password", label: "eCom password", secret: true }, { key: "customerNo", label: "TCS account no. (needed for payments + booking intake)" }, { key: "baseUrl", label: "Base URL (blank = ociconnect production)" }],
  trax: [{ key: "apiKey", label: "API key (from portal)", secret: true }],
  meta: [{ key: "accessToken", label: "System User access token", secret: true }, { key: "apiVersion", label: "Graph API version (e.g. v24.0)" }],
};

export default async function Integrations() {
  const u = await requireUser("profit:view");
  const rows = await listIntegrations(ORG_ID);
  const db = await getDb();
  const runs = await db.collection("sync_runs").find({ orgId: ORG_ID }).sort({ startedAt: -1 }).limit(20).toArray();
  const manage = has(u, "integrations:manage");
  const today = karachiDate();
  return (
    <>
      <PageHeader title="Integrations" description="Every external call goes through an adapter. Mock mode works without credentials; switch to live once credentials are saved. Credentials are encrypted at rest (AES-256-GCM) and never sent to the browser." />
      <div className="grid gap-4 lg:grid-cols-2">
        {rows.map((i) => {
          const lagH = i.lastSuccessAt ? Math.round((Date.now() - new Date(i.lastSuccessAt).getTime()) / 3_600_000) : null;
          const healthy = i.enabled && !i.lastError && lagH !== null && lagH < 24;
          return (
            <Card key={i._id}>
              <CardHeader
                title={i.label}
                description={`${i.type} · ${i.provider} · ${i.mode === "live" ? "live API" : "mock adapter"}`}
                action={<Badge tone={!i.enabled ? "neutral" : healthy ? "positive" : i.lastError ? "negative" : "warning"}>{!i.enabled ? "disabled" : healthy ? "healthy" : i.lastError ? "failing" : "stale"}</Badge>}
              />
              <CardBody className="grid gap-3">
                <dl className="grid grid-cols-3 gap-2 text-[13px]">
                  <div><dt className="text-xs text-muted-foreground">Last success</dt><dd>{dt(i.lastSuccessAt)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Lag</dt><dd>{lagH == null ? "—" : `${lagH} h`}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">Errors</dt><dd className={i.errorCount ? "text-negative" : ""}>{i.errorCount}</dd></div>
                </dl>
                {i.lastError ? <Notice tone="negative">{i.lastError}</Notice> : null}
                {i.type === "courier" ? <p className="text-xs text-muted-foreground">Webhook (push) URL: <span className="select-all font-mono">/api/webhooks/courier/{i._id}</span></p> : null}
                {i.type === "shopify" ? <p className="text-xs text-muted-foreground">Webhook URL: <span className="select-all font-mono">/api/webhooks/shopify/{i._id}</span></p> : null}
                {manage ? (
                  <>
                    <div className="flex flex-wrap gap-2">
                      <ActionForm action={test}><input type="hidden" name="id" value={i._id} /><Submit size="xs" variant="outline">Test connection</Submit></ActionForm>
                      <ActionForm action={toggle}><input type="hidden" name="id" value={i._id} /><input type="hidden" name="enabled" value={i.enabled ? "0" : "1"} /><Submit size="xs" variant="ghost">{i.enabled ? "Disable" : "Enable"}</Submit></ActionForm>
                    </div>
                    <ActionForm action={resync} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={i._id} />
                      <Field label="Resync from" htmlFor={`f-${i._id}`}><Input id={`f-${i._id}`} name="from" type="date" defaultValue={addDays(today, -7)} className="h-8 text-[13px]" /></Field>
                      <Field label="to" htmlFor={`t-${i._id}`}><Input id={`t-${i._id}`} name="to" type="date" defaultValue={today} className="h-8 text-[13px]" /></Field>
                      <Submit size="xs" variant="outline">Queue resync</Submit>
                    </ActionForm>
                    <details className="rounded-md border">
                      <summary className="px-3 py-2 text-[13px] font-medium">Credentials and mode {i.credentialsEnc ? <Badge tone="positive">saved</Badge> : <Badge>none</Badge>}</summary>
                      <ActionForm action={saveCreds} className="grid gap-2 border-t p-3">
                        <input type="hidden" name="id" value={i._id} />
                        <Field label="Mode" htmlFor={`m-${i._id}`}><Select id={`m-${i._id}`} name="mode" defaultValue={i.mode}><option value="mock">Mock (fixtures)</option><option value="live">Live API</option></Select></Field>
                        {(FIELDS[i.provider] ?? []).map((f) => (
                          <Field key={f.key} label={f.label} htmlFor={`${i._id}-${f.key}`}><Input id={`${i._id}-${f.key}`} name={`c:${f.key}`} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={i.credentialsEnc ? "•••• unchanged" : ""} /></Field>
                        ))}
                        <p className="text-xs text-muted-foreground">Leave a field blank to keep its saved value.</p>
                        <Submit size="xs">Save</Submit>
                      </ActionForm>
                    </details>
                  </>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>
      <Card className="mt-4">
        <CardHeader title="Recent sync runs" />
        <Table>
          <thead><tr><Th>Started</Th><Th>Integration</Th><Th>Status</Th><Th align="right">Duration</Th><Th>Result</Th></tr></thead>
          <tbody>{runs.map((r) => <tr key={String(r._id)}><Td>{dt(r.startedAt)}</Td><Td>{rows.find((x) => x._id === r.integrationId)?.label}</Td><Td><Badge tone={r.status === "ok" ? "positive" : r.status === "error" ? "negative" : "warning"}>{r.status}</Badge></Td><Td align="right">{r.durationMs ? `${(r.durationMs / 1000).toFixed(1)} s` : "—"}</Td><Td mono className="max-w-96 truncate text-xs">{r.error ?? JSON.stringify(r.result ?? {})}</Td></tr>)}</tbody>
        </Table>
      </Card>
    </>
  );
}
