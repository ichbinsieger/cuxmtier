import { NextRequest, NextResponse } from "next/server";
import { fetchBookCode, createBookCode } from "@/lib/sportybet";
import { analyzeSelections, getShrinkSelections, selectionsToSportyFormat } from "@/lib/analyzer";
import { getSafeBets, safeBetToSelection } from "@/lib/safeBets";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { code, action, count } = body as {
      code: string;
      action: "analyze" | "shrink" | "add";
      count?: number;
    };

    if (!code) {
      return NextResponse.json({ error: "Book code is required" }, { status: 400 });
    }

    const ticket = await fetchBookCode(code);
    const analysis = analyzeSelections(ticket.outcomes, ticket.ticket.selections, code);

    // ── SHRINK ──
    if (action === "shrink" && count && count > 0) {
      const { removed, kept } = getShrinkSelections(analysis.selections, count);
      if (kept.length === 0) {
        return NextResponse.json({ error: "Cannot remove all selections" }, { status: 400 });
      }

      const keptSporty = selectionsToSportyFormat(kept);
      const newCode = await createBookCode(keptSporty);

      return NextResponse.json({
        originalCode: code, newCode,
        removed: removed.map(s => ({ homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament, pickDesc: s.pickDesc, odds: s.odds, riskScore: s.riskScore, riskReasons: s.riskReasons, eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId })),
        kept: kept.map(s => ({ homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament, pickDesc: s.pickDesc, odds: s.odds, riskScore: s.riskScore, eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId, specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId })),
        totalOriginal: analysis.totalSelections, totalNew: kept.length, removedCount: removed.length,
      });
    }

    // ── ADD ──
    if (action === "add" && count && count > 0) {
      const existingEventIds = analysis.selections.map(s => s.eventId);
      const safeBets = getSafeBets(count, existingEventIds);

      if (safeBets.length === 0) {
        return NextResponse.json({ error: "No safe bets available to add" }, { status: 400 });
      }

      const newSelections = safeBets.map(safeBetToSelection);
      const allSelections = [...ticket.ticket.selections, ...newSelections];
      const newCode = await createBookCode(allSelections);

      return NextResponse.json({
        originalCode: code, newCode,
        added: safeBets.map(b => ({ label: b.label, odds: b.odds, tournament: b.tournament })),
        addedCount: safeBets.length,
      });
    }

    // ── ANALYZE ──
    return NextResponse.json({
      originalCode: code,
      totalSelections: analysis.totalSelections,
      averageRisk: analysis.averageRisk,
      portfolioVol: Math.round(analysis.portfolioVol * 100),
      selections: analysis.selections.map(s => ({
        homeTeam: s.homeTeam, awayTeam: s.awayTeam, tournament: s.tournament,
        marketDesc: s.marketDesc, pickDesc: s.pickDesc, odds: s.odds,
        probability: s.probability, matchStatus: s.matchStatus,
        riskScore: s.riskScore, riskReasons: s.riskReasons, safeReasons: s.safeReasons,
        eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
        specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId,
      })),
    });
  } catch (error: any) {
    console.error("Analysis error:", error);
    return NextResponse.json({ error: error.message || "Failed to process" }, { status: 500 });
  }
}
