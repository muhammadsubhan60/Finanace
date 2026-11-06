"use client";

import { useActionState } from "react";
import { Field, Input } from "@/components/ui";
import { Submit } from "@/components/action-form";
import { confirmTotp } from "../actions";

export function TotpConfirm() {
  const [state, action] = useActionState(confirmTotp, null);
  return (
    <form action={action} className="grid gap-3">
      <Field label="Code" htmlFor="code">
        <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required />
      </Field>
      <p aria-live="polite" className="text-sm text-negative empty:hidden">{state?.error ?? ""}</p>
      <Submit>Enable and continue</Submit>
    </form>
  );
}
