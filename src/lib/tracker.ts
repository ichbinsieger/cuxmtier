// Server-side recommendation tracker — generates recommended slips and
// resolves their win/loss results against a Postgres store, so results stay
// current 24/7 even when nobody has the site open.
//
// Used by:
//   - /api/cron      (Vercel Cron: generate on an interval + check results)
//   - /api/recommend (serves the persisted slips/results to the client)

import { getRecommendations, getDrawRecommendation, getRiskyRecommendation, RecommendedSlip } from "./recommend";
import { fetchBookCode } from "./sportybet";
import { query } from "./db";

// Regenerate a fresh batch of recommendations at most this often.
const GENERATE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface StoredRow {
  code: string;
  batch_id: string;
  target_odds: string;
  actual_odds: string;
  kind: string;
  picks: any[];
  created_at: string;
  checked_at: string | null;
  result: { won: number; lost: number; pending: number; picks: Array<{ result: string }> } | null;
}

// Resolve the current win/loss/pending state of a slip by hitting SportyBet's
// share API. Mirrors the client-side check in page.tsx.
async function computeResult(
  code: string,
  picks: Array<{ eventId: string; marketId: string; specifier?: string; outcomeId: string }>
) {
  const ticket = await fetchBookCode(code);
  let won = 0;
  let lost = 0;
  let pending = 0;
  const pickResults: Array<{ result: "won" | "lost" | "pending" }> = [];

  for (const pick of picks) {
    const event = ticket.outcomes.find((o) => o.eventId === pick.eventId);
    const market = event?.markets.find(
      (m) => m.id === pick.marketId && (m.specifier || undefined) === (pick.specifier || undefined)
    );

    if (!event || !market) {
      pending++;
      pickResults.push({ result: "pending" });
      continue;
    }

    const status = event.matchStatus;
    if (status !== "Ended" && status !== "Closed" && status !== "Settled") {
      pending++;
      pickResults.push({ result: "pending" });
      continue;
    }

    const winnerPick = market.outcomes.find((o) => o.id === pick.outcomeId);
    if (winnerPick?.isWinning === true || winnerPick?.isWinning === 1) {
      won++;
      pickResults.push({ result: "won" });
    } else {
      lost++;
      pickResults.push({ result: "lost" });
    }
  }

  return { won, lost, pending, picks: pickResults };
}

// Generate a new batch of recommendations (if stale) and store it.
export async function generateAndStore(force = false): Promise<number> {
  if (!force) {
    const latest = await query<{ created_at: string }>(
      `SELECT created_at FROM recommendations ORDER BY created_at DESC LIMIT 1`
    );
    if (latest.rows.length > 0) {
      const last = new Date(latest.rows[0].created_at).getTime();
      if (Date.now() - last < GENERATE_INTERVAL_MS) return 0;
    }
  }

  const slips = await getRecommendations();
  const drawSlip = await getDrawRecommendation();
  const riskySlip = await getRiskyRecommendation();

  if (slips.length === 0 && !drawSlip && !riskySlip) return 0;

  const batchId = new Date().toISOString();
  for (const slip of slips) {
    await query(
      `INSERT INTO recommendations (code, batch_id, target_odds, actual_odds, kind, picks)
       VALUES ($1, $2, $3, $4, 'safe', $5)
       ON CONFLICT (code) DO NOTHING`,
      [slip.code, batchId, slip.targetOdds, slip.actualOdds, JSON.stringify(slip.picks)]
    );
  }

  if (drawSlip) {
    await query(
      `INSERT INTO recommendations (code, batch_id, target_odds, actual_odds, kind, picks)
       VALUES ($1, $2, $3, $4, 'draw', $5)
       ON CONFLICT (code) DO NOTHING`,
      [drawSlip.code, batchId, drawSlip.targetOdds, drawSlip.actualOdds, JSON.stringify(drawSlip.picks)]
    );
  }

  if (riskySlip) {
    await query(
      `INSERT INTO recommendations (code, batch_id, target_odds, actual_odds, kind, picks)
       VALUES ($1, $2, $3, $4, 'risky', $5)
       ON CONFLICT (code) DO NOTHING`,
      [riskySlip.code, batchId, riskySlip.targetOdds, riskySlip.actualOdds, JSON.stringify(riskySlip.picks)]
    );
  }

  return slips.length + (drawSlip ? 1 : 0) + (riskySlip ? 1 : 0);
}

// Check every not-fully-resolved slip and update its result in the DB.
export async function checkStoredResults(): Promise<number> {
  const q = await query<StoredRow>(
    `SELECT code, picks FROM recommendations
     WHERE (result IS NULL OR result->>'pending' != '0')
       AND created_at < now() - interval '5 minutes'
     ORDER BY created_at DESC
     LIMIT 40`
  );

  let checked = 0;
  for (const row of q.rows) {
    try {
      const result = await computeResult(row.code, row.picks);
      const fullyResolved = result.pending === 0;
      await query(
        `UPDATE recommendations SET result = $2, checked_at = $3 WHERE code = $1`,
        [row.code, JSON.stringify(result), fullyResolved ? new Date() : null]
      );
      checked++;
    } catch (e) {
      console.error(`[tracker] check failed for ${row.code}:`, e);
    }
  }
  return checked;
}

// Load persisted recommendations + results for the client.
export async function getStoredData() {
  const q = await query<StoredRow>(`SELECT * FROM recommendations ORDER BY created_at DESC`);
  const rows = q.rows;

  const slips: RecommendedSlip[] = [];
  const results: Record<string, { won: number; lost: number; pending: number; picks: Array<{ result: string }> }> = {};

  // A slip is only a *current* recommendation while its matches are still
  // today (Lagos). The same-day filter guarantees picks kick off on the day
  // the batch was generated, so anything generated on a previous Lagos day
  // references matches that have already kicked off — surface nothing rather
  // than showing "already played" games as if they were live picks.
  const lagosDayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const isTodayLagos = (iso: string) =>
    lagosDayFmt.format(new Date(iso)) === lagosDayFmt.format(new Date());

  if (rows.length > 0) {
    // Safe slips: latest batch only, sorted by target odds, and only if that
    // batch was generated today.
    const safeRows = rows.filter((r) => r.kind !== "draw");

    if (safeRows.length > 0) {
      const latestBatch = safeRows[0].batch_id;
      if (isTodayLagos(safeRows[0].created_at)) {
        const latestRows = safeRows.filter((r) => r.batch_id === latestBatch);
        latestRows.sort((a, b) => Number(a.target_odds) - Number(b.target_odds));
        for (const r of latestRows) {
          slips.push({
            targetOdds: Number(r.target_odds),
            actualOdds: Number(r.actual_odds),
            code: r.code,
            picks: r.picks,
          });
          if (r.result) results[r.code] = r.result;
        }
      }
    }
  }

  // Resolve the latest draw slip separately (kept fresh regardless of batch),
  // but apply the same staleness guard so yesterday's draws don't linger.
  let drawSlip: RecommendedSlip | null = null;
  const latestDraw = rows.find((r) => r.kind === "draw");
  if (latestDraw && isTodayLagos(latestDraw.created_at)) {
    drawSlip = {
      targetOdds: Number(latestDraw.target_odds),
      actualOdds: Number(latestDraw.actual_odds),
      code: latestDraw.code,
      picks: latestDraw.picks,
    };
    if (latestDraw.result) results[latestDraw.code] = latestDraw.result;
  }

  // Risky fallback slip — served when the safe tiers come up empty.
  let riskySlip: RecommendedSlip | null = null;
  const latestRisky = rows.find((r) => r.kind === "risky");
  if (latestRisky && isTodayLagos(latestRisky.created_at)) {
    riskySlip = {
      targetOdds: Number(latestRisky.target_odds),
      actualOdds: Number(latestRisky.actual_odds),
      code: latestRisky.code,
      picks: latestRisky.picks,
    };
    if (latestRisky.result) results[latestRisky.code] = latestRisky.result;
  }

  const history = rows.map((r) => ({
    code: r.code,
    kind: r.kind,
    timestamp: new Date(r.created_at).getTime(),
    selections: (r.picks || []).length,
    targetOdds: Number(r.target_odds),
    actualOdds: Number(r.actual_odds),
    avgEv: 0,
    avgRisk: 0,
    type: r.kind === "draw" ? "draw" : "generated",
    picks: (r.picks || []).map((p: any, i: number) => ({
      ...p,
      result: (r.result?.picks?.[i]?.result as any) || "pending",
    })),
    checkedAt: r.checked_at ? new Date(r.checked_at).getTime() : undefined,
  }));

  return { slips, draw: drawSlip, risky: riskySlip, results, history };
}
