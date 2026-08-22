import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { generateAndStore, checkStoredResults } from "@/lib/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron hits this endpoint on a schedule. When CRON_SECRET is set,
// Vercel sends it as an Authorization Bearer header.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / unset — allow
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";

  try {
    await ensureSchema();
    const generated = await generateAndStore(force);
    const checked = await checkStoredResults();
    return NextResponse.json({ ok: true, generated, checked, at: new Date().toISOString() });
  } catch (error: any) {
    console.error("[cron] error:", error);
    return NextResponse.json({ error: error?.message || "cron failed" }, { status: 500 });
  }
}
