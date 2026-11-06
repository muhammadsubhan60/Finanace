import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { destroySession } from "@delta/db";
import { SESSION_COOKIE } from "@/lib/session";

export async function POST(req: Request) {
  const jar = await cookies();
  const t = jar.get(SESSION_COOKIE)?.value;
  if (t) await destroySession(t);
  jar.delete(SESSION_COOKIE);
  return NextResponse.redirect(new URL("/login", req.url), 303);
}
