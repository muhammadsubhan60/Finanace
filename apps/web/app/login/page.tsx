import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh bg-card lg:grid-cols-[1fr_480px]">
      <section className="relative hidden overflow-hidden border-r bg-gradient-to-br from-primary-soft via-background to-card p-12 text-muted-foreground lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-primary/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 left-10 size-80 rounded-full bg-positive/10 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-md bg-primary font-bold text-primary-foreground">Δ</div>
          <span className="text-sm font-bold text-foreground">Delta Finance</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-foreground text-balance">One book of record for the local ecommerce division.</h1>
          <p className="mt-4 text-[15px] leading-relaxed">Courier-first COD tracking, a profit engine driven by the signed Agreement Profile, and an append-only ledger no partner can silently change.</p>
        </div>
        <dl className="relative grid grid-cols-3 gap-4 text-sm">
          {[["Ledger", "Append-only, hash-chained"], ["Rules", "From the profile, never code"], ["Changes", "Dual approval"]].map(([k, v]) => (
            <div key={k} className="rounded-lg border bg-card/70 p-4 shadow-sm backdrop-blur">
              <dt className="font-semibold text-foreground">{k}</dt>
              <dd className="mt-1 text-xs text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="grid size-9 place-items-center rounded-md bg-primary font-bold text-primary-foreground">Δ</div>
            <span className="text-sm font-semibold">Delta Finance</span>
          </div>
          <h2 className="text-2xl font-bold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-muted-foreground">Use your Delta Labs account.</p>
          <LoginForm />
        </div>
      </section>
    </div>
  );
}
