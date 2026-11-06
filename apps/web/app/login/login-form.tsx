"use client";

import { useActionState } from "react";
import { Field, Input } from "@/components/ui";
import { Submit } from "@/components/action-form";
import { login } from "./actions";

export function LoginForm() {
  const [state, action] = useActionState(login, null);
  return (
    <form action={action} className="mt-6 grid gap-4">
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </Field>
      {state?.needTotp ? (
        <Field label="Authenticator code" htmlFor="code" hint="6-digit code from your authenticator app">
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
        </Field>
      ) : null}
      <p aria-live="polite" className="text-sm text-negative empty:hidden">{state?.error ?? ""}</p>
      <Submit className="w-full">{state?.needTotp ? "Verify and sign in" : "Sign in"}</Submit>
    </form>
  );
}
