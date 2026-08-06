import { NextRequest, NextResponse } from "next/server";
import { fetchBookCode, createBookCode } from "@/lib/sportybet";
import { analyzeSelections, getShrinkSelections, selectionsToSportyFormat, recomputePortfolio } from "@/lib/analyzer";
import { getSafeBets, safeBetToSelection } from "@/lib/safeBets";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { code, action, count, removeIds } = body as {
      code: string;
      action: "analyze" | "shrink" | "add" | "custom";
      count?: number;
      removeIds?: string[];
    };

    if (!code && action !== "add") {
      return NextResponse.json({ error: "Book code is required" }, { status: 400 });
    }

    // ── ANALYZE ──
    if (action === "analyze") {
      const ticket = await fetchBookCode(code!);
      const analysis = analyzeSelections(ticket.outcomes, ticket.ticket.selections, code!);
      return NextResponse.json({
        originalCode: code,
        totalSelections: analysis.totalSelections,
        averageRisk: analysis.averageRisk,
        portfolioVol: Math.round(analysis.portfolioVol * 100),
        failureProbability: Math.round(analysis.failureProbability * 100),
        correlationWarnings: analysis.correlationWarnings,
        selections: analysis.selections.map(s => ({
          homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament,
          marketDesc: s.marketDesc, pickDesc: s.pickDesc, odds: s.odds,
          probability: s.probability, matchStatus: s.matchStatus,
          riskScore: s.riskScore, riskReasons: s.riskReasons, safeReasons: s.safeReasons,
          eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
          specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId,
          sigma: s.sigma, failProb: s.failProb,
          kellyFraction: s.kellyFraction, kellyLabel: s.kellyLabel,
        })),
      });
    }

    // ── SHRINK (auto) ──
    if (action === "shrink") {
      const ticket = await fetchBookCode(code!);
      const analysis = analyzeSelections(ticket.outcomes, ticket.ticket.selections, code!);
      const { removed, kept } = getShrinkSelections(analysis.selections, count || 4);
      if (kept.length === 0) return NextResponse.json({ error: "Cannot remove all" }, { status: 400 });

      const newCode = await createBookCode(selectionsToSportyFormat(kept));
      const metrics = recomputePortfolio(kept);
      return NextResponse.json({
        originalCode: code, newCode,
        totalOriginal: analysis.totalSelections, totalNew: kept.length, removedCount: removed.length,
        portfolioVolBefore: Math.round(analysis.portfolioVol * 100),
        portfolioVolAfter: Math.round(metrics.portfolioVol * 100),
        failureProbBefore: Math.round(analysis.failureProbability * 100),
        failureProbAfter: Math.round(metrics.failureProbability * 100),
        removed: removed.map(s => ({ homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament, pickDesc: s.pickDesc, odds: s.odds, riskScore: s.riskScore, eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId })),
        kept: kept.map(s => ({ homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament, pickDesc: s.pickDesc, odds: s.odds, riskScore: s.riskScore, eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId })),
      });
    }

    // ── CUSTOM (remove specific picks) ──
    if (action === "custom" && removeIds && removeIds.length > 0) {
      const ticket = await fetchBookCode(code!);
      const analysis = analyzeSelections(ticket.outcomes, ticket.ticket.selections, code!);
      const removeSet = new Set(removeIds);
      const kept = analysis.selections.filter(s => !removeSet.has(`${s.eventId}|${s.marketId}|${s.outcomeId}`));
      const removed = analysis.selections.filter(s => removeSet.has(`${s.eventId}|${s.marketId}|${s.outcomeId}`));
      if (kept.length === 0) return NextResponse.json({ error: "Keep at least one" }, { status: 400 });

      const newCode = await createBookCode(selectionsToSportyFormat(kept));
      const metrics = recomputePortfolio(kept);
      return NextResponse.json({
        originalCode: code, newCode,
        totalOriginal: analysis.totalSelections, totalNew: kept.length, removedCount: removed.length,
        portfolioVolBefore: Math.round(analysis.portfolioVol * 100),
        portfolioVolAfter: Math.round(metrics.portfolioVol * 100),
        failureProbBefore: Math.round(analysis.failureProbability * 100),
        failureProbAfter: Math.round(metrics.failureProbability * 100),
        removed: removed.map(s => ({ homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament, pickDesc: s.pickDesc, odds: s.odds, riskScore: s.riskScore, eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId })),
        kept: kept.map(s => ({ homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament, pickDesc: s.pickDesc, odds: s.odds, riskScore: s.riskScore, eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId })),
      });
    }

    // ── ADD ──
    if (action === "add") {
      const ticket = await fetchBookCode(code!);
      const analysis = analyzeSelections(ticket.outcomes, ticket.ticket.selections, code!);
      const existingEventIds = analysis.selections.map(s => s.eventId);
      const safeBets = getSafeBets(count || 3, existingEventIds);
      if (safeBets.length === 0) return NextResponse.json({ error: "No safe bets available" }, { status: 400 });

      const newSelections = safeBets.map(safeBetToSelection);
      const all = [...ticket.ticket.selections, ...newSelections];
      const newCode = await createBookCode(all);
      return NextResponse.json({
        originalCode: code, newCode,
        added: safeBets.map(b => ({ label: b.label, odds: b.odds, tournament: b.tournament })),
        addedCount: safeBets.length,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error: any) {
    console.error("Error:", error);
    return NextResponse.json({ error: error.message || "Failed" }, { status: 500 });
  }
}
