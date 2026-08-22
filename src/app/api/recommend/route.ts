import { NextResponse } from "next/server";
import { getRecommendations } from "@/lib/recommend";
import { ensureSchema } from "@/lib/db";
import { getStoredData, generateAndStore } from "@/lib/tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    await ensureSchema();
    // Regenerate a fresh batch whenever the current one is stale (>4h old).
    // generateAndStore() self-throttles to GENERATE_INTERVAL_MS internally, so
    // this is a cheap no-op for most requests — it only actually scans SportyBet
    // and creates new booking codes once every 4 hours.
    await generateAndStore();
    const data = await getStoredData();

    const response = NextResponse.json(data);
    // Short edge cache: cron refreshes results every ~15 min, so don't hold
    // stale results for hours like the old 4h cache did.
    response.headers.set(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=300"
    );
    return response;
  } catch (error: any) {
    console.error("Recommend API error:", error);
    // Fallback to live generation if the DB is unreachable (e.g. no DATABASE_URL)
    try {
      const slips = await getRecommendations();
      return NextResponse.json({ slips, draw: null, results: {}, history: [] });
    } catch (fallbackError: any) {
      console.error("Recommend fallback error:", fallbackError);
      return NextResponse.json(
        { error: "Failed to generate recommendations" },
        { status: 500 }
      );
    }
  }
}
