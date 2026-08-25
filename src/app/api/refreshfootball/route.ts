import { NextResponse } from "next/server";
import { ensureSchema } from "@/lib/db";
import { refreshFootballData } from "@/lib/footballData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron hits this on a schedule (daily). CRON_SECRET protects it.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev / unset — allow
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureSchema();
    const result = await refreshFootballData();
    return NextResponse.json({ ok: true, ...result, at: new Date().toISOString() });
  } catch (error: any) {
    console.error("[refreshfootball] error:", error);
    return NextResponse.json({ error: error?.message || "refresh failed" }, { status: 500 });
  }
}
