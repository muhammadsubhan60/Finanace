import { notFound } from "next/navigation";
import { getSnapshot, ORG_ID } from "@delta/db";
import { Statement } from "@/components/statement";
import { PrintButton } from "./print-button";
import { requireUser } from "@/lib/session";
import { dt } from "@/lib/utils";

export default async function PrintStatement({ params }: { params: Promise<{ periodId: string }> }) {
  await requireUser("profit:view");
  const { periodId } = await params;
  const s = await getSnapshot(ORG_ID, periodId);
  if (!s?.snapshot) notFound();
  const snap = s.snapshot;
  return (
    <div className="mx-auto max-w-4xl bg-card p-6 print:p-0">
      <div className="no-print mb-4 flex justify-end"><PrintButton /></div>
      <header className="mb-6 border-b pb-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Delta Labs · Local ecommerce division</div>
        <h1 className="mt-1 text-2xl font-semibold">Period statement {periodId}</h1>
        <p className="text-sm text-muted-foreground">Status: {s.period.status} · issued {dt(s.period.closedAt)}</p>
      </header>
      <Statement r={snap.result} />
      <footer className="mt-8 border-t pt-3 font-mono text-[11px] text-muted-foreground">
        Profile v{snap.profileVersion} · engine {snap.engineVersion} · generated {dt(new Date())} · inputs hash {snap.inputsHash} · outputs hash {snap.result.outputsHash}
      </footer>
    </div>
  );
}
