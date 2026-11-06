"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button, buttonVariants } from "./ui";
import { cn } from "@/lib/utils";
import type { VariantProps } from "class-variance-authority";

type State = { ok: boolean; message?: string; error?: string; at?: number } | null;

/** Form bound to a server action; shows inline success/error near the submit button (aria-live). */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  confirm,
}: {
  action: (prev: State, fd: FormData) => Promise<State>;
  children: React.ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <p aria-live="polite" className={cn("text-sm empty:hidden", state?.ok ? "text-positive" : "text-negative")}>
        {state ? (state.ok ? state.message : state.error) : ""}
      </p>
    </form>
  );
}

export function Submit({ children, variant, size, className }: { children: React.ReactNode; className?: string } & VariantProps<typeof buttonVariants>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending} className={className} aria-busy={pending}>
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Button>
  );
}
