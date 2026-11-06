import { handleCourierWebhook } from "@delta/db";

/**
 * Leopards Push API callback. LCS POSTs { data: [...] } and expects 202 with [{status:1, errors:[]}],
 * 401 when unauthorized, 400 for bad requests (per "LCS-Push_API_Documentation").
 */
export async function POST(req: Request, { params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json([{ status: 0, errors: ["Invalid JSON"] }], { status: 400 });
  }
  try {
    const headers = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    await handleCourierWebhook(integrationId, body, headers);
    return Response.json([{ status: 1, errors: [] }], { status: 202 });
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return Response.json([{ status: 0, errors: [(e as Error).message] }], { status: status === 401 || status === 404 ? status : 400 });
  }
}
