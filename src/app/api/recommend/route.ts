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
    const data = await getStoredData();

    // Only generate synchronously when the DB is genuinely empty (fresh
    // deploy). Otherwise the 4-hourly cron keeps things fresh — page loads
    // must stay fast, and a full SportyBet scan here was causing multi-minute
    // hangs. Stale data (a few hours old) is served as-is rather than blocking.
    const isEmpty =
      data.slips.length === 0 &&
      !data.draw &&
      !data.risky &&
      data.day.length === 0 &&
      data.history.length === 0;

    if (isEmpty) {
      await generateAndStore(true);
      const fresh = await getStoredData();
      return NextResponse.json(fresh, {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300",
        },
      });
    }

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
      return NextResponse.json({ slips, draw: null, risky: null, day: [], results: {}, history: [] });
    } catch (fallbackError: any) {
      console.error("Recommend fallback error:", fallbackError);
      return NextResponse.json(
        { error: "Failed to generate recommendations" },
        { status: 500 }
      );
    }
  }
}
