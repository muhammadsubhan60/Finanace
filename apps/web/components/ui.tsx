import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------- Button ----------
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline: "border border-input bg-card hover:bg-muted",
        ghost: "hover:bg-muted",
        destructive: "bg-negative text-white hover:bg-negative/90 dark:text-background",
        positive: "bg-positive text-white hover:bg-positive/90 dark:text-background",
        link: "text-primary underline-offset-4 hover:underline px-0",
      },
      size: { default: "h-10 px-4", sm: "h-9 px-3", xs: "h-8 px-2.5 text-xs", icon: "size-10" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);
export function Button({ className, variant, size, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...p} />;
}
export function LinkButton({ href, className, variant, size, children }: { href: string; className?: string; children: React.ReactNode } & VariantProps<typeof buttonVariants>) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant, size }), className)}>
      {children}
    </Link>
  );
}

// ---------- Card ----------
export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border bg-card text-card-foreground shadow-[0_1px_2px_rgba(15,23,42,0.04)]", className)} {...p} />;
}
export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description ? <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
export function CardBody({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 sm:p-5", className)} {...p} />;
}

// ---------- Badge ----------
const badgeVariants = cva("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      neutral: "bg-muted text-muted-foreground",
      primary: "bg-primary-soft text-primary",
      positive: "bg-positive-soft text-positive",
      negative: "bg-negative-soft text-negative",
      warning: "bg-warning-soft text-warning",
    },
  },
  defaultVariants: { tone: "neutral" },
});
export function Badge({ tone, className, children }: VariantProps<typeof badgeVariants> & { className?: string; children: React.ReactNode }) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}

const STATUS_TONE: Record<string, VariantProps<typeof badgeVariants>["tone"]> = {
  delivered: "positive", posted: "positive", approved: "positive", released: "positive", paid: "positive", active: "positive", final: "positive", ok: "positive", reconciled: "positive", resolved: "positive",
  returned_to_origin: "negative", rejected: "negative", cancelled: "negative", lost_or_damaged: "negative", cn_unknown: "negative", already_settled: "negative", error: "negative", duplicate_in_file: "negative", critical: "negative",
  pending: "warning", pending_approval: "warning", requested: "warning", closing: "warning", closed: "primary", amount_differs: "warning", not_delivered: "warning", has_exceptions: "warning", return_initiated: "warning", delivery_attempted: "warning", unknown: "warning", unallocated: "warning", warning: "warning", draft: "neutral", open: "primary", info: "primary",
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>;
}

// ---------- Form controls ----------
const control = "h-10 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground/80 focus-visible:outline-2 focus-visible:outline-offset-0 disabled:opacity-60";
export function Input({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, className)} {...p} />;
}
export function Select({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(control, "pr-8", className)} {...p}>
      {children}
    </select>
  );
}
export function Textarea({ className, ...p }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "h-auto min-h-24 py-2 font-mono text-[13px]", className)} {...p} />;
}
export function Field({ label, htmlFor, hint, children, className }: { label: string; htmlFor: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ---------- Layout ----------
export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground text-pretty">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

/** A KPI tile. `href` makes the number a drill-down; `definition` renders the "how is this calculated" tooltip. */
export function Stat({ label, value, sub, href, definition, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; href?: string; definition?: string; tone?: "positive" | "negative" | "warning" }) {
  const v = <span className={cn("text-[22px] font-semibold leading-tight tabular-nums tracking-tight", tone === "positive" && "text-positive", tone === "negative" && "text-negative", tone === "warning" && "text-warning")}>{value}</span>;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        {definition ? <Definition text={definition} /> : null}
      </div>
      <div className="mt-1.5">
        {href ? (
          <Link href={href} className="rounded-sm hover:underline decoration-muted-foreground/50 underline-offset-4">
            {v}
          </Link>
        ) : (
          v
        )}
      </div>
      {sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </Card>
  );
}

export function Definition({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-label={`How is this calculated: ${text}`} className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted focus-visible:bg-muted">
        <Info className="size-3.5" aria-hidden />
      </button>
      <span role="tooltip" className="pointer-events-none invisible absolute right-0 top-7 z-30 w-64 rounded-md border bg-card p-2.5 text-xs leading-relaxed text-card-foreground opacity-0 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        {text}
      </span>
    </span>
  );
}

// ---------- Table ----------
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-max border-collapse text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className, align }: { children?: React.ReactNode; className?: string; align?: "right" }) {
  return <th className={cn("border-b bg-muted/50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5", align === "right" && "text-right", className)}>{children}</th>;
}
export function Td({ children, className, align, mono }: { children?: React.ReactNode; className?: string; align?: "right"; mono?: boolean }) {
  return <td className={cn("border-b px-3 py-2.5 align-middle first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5", align === "right" && "text-right tabular-nums", mono && "font-mono text-[13px]", className)}>{children}</td>;
}
export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground sm:px-5">
      <span className="tabular-nums">
        {total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total.toLocaleString()}
      </span>
      <div className="flex gap-2">
        {page > 1 ? <LinkButton href={hrefFor(page - 1)} variant="outline" size="xs">Previous</LinkButton> : null}
        {page < pages ? <LinkButton href={hrefFor(page + 1)} variant="outline" size="xs">Next</LinkButton> : null}
      </div>
    </div>
  );
}

export function Notice({ tone = "primary", children }: { tone?: "primary" | "warning" | "negative" | "positive"; children: React.ReactNode }) {
  const t = { primary: "bg-primary-soft text-primary", warning: "bg-warning-soft text-warning", negative: "bg-negative-soft text-negative", positive: "bg-positive-soft text-positive" }[tone];
  return <div className={cn("rounded-md px-3 py-2.5 text-sm", t)}>{children}</div>;
}

/** Waterfall / statement line. */
export function Line({ label, value, strong, indent, href, sub }: { label: React.ReactNode; value: React.ReactNode; strong?: boolean; indent?: boolean; href?: string; sub?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5 text-sm", strong && "border-t pt-2 font-semibold", sub && "text-muted-foreground")}>
      <span className={cn(indent && "pl-4")}>{href ? <Link href={href} className="hover:underline underline-offset-4">{label}</Link> : label}</span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">{value}</span>
    </div>
  );
}
