import { LinkButton } from "@/components/ui";

export default async function Forbidden({ searchParams }: { searchParams: Promise<{ need?: string }> }) {
  const { need } = await searchParams;
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 text-center">
      <div>
        <h1 className="text-lg font-semibold">You don&apos;t have access to this page</h1>
        <p className="mt-1 text-sm text-muted-foreground">Missing permission{need ? `: ${need}` : ""}. Ask the owner to update your role.</p>
        <LinkButton href="/orders" variant="outline" className="mt-4">Go to orders</LinkButton>
      </div>
    </div>
  );
}
