import { redirect } from "next/navigation";
import { Card, CardBody } from "@/components/ui";
import { getUser } from "@/lib/session";
import { startTotp } from "../actions";
import { TotpConfirm } from "./totp-confirm";

export const metadata = { title: "Set up two-factor authentication" };

export default async function TotpSetup() {
  const u = await getUser();
  if (!u) redirect("/login");
  if (u.totpEnabled) redirect("/account");
  const { secret, uri } = await startTotp();
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardBody className="grid gap-4">
          <div>
            <h1 className="text-lg font-semibold">Set up two-factor authentication</h1>
            <p className="mt-1 text-sm text-muted-foreground">Your role ({u.role.replace("_", " ")}) requires an authenticator app. Add this key in Google Authenticator, 1Password or similar, then enter the 6-digit code.</p>
          </div>
          <div className="rounded-md bg-muted p-3">
            <div className="text-xs text-muted-foreground">Setup key</div>
            <div className="mt-1 break-all font-mono text-sm tracking-wider select-all">{secret.match(/.{1,4}/g)?.join(" ")}</div>
            <a href={uri} className="mt-2 inline-block text-xs text-primary underline-offset-4 hover:underline">Open in authenticator app</a>
          </div>
          <TotpConfirm />
        </CardBody>
      </Card>
    </div>
  );
}
