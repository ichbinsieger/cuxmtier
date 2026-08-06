import { NextRequest, NextResponse } from "next/server";
import { fetchBookCode, createBookCode } from "@/lib/sportybet";
import { analyzeSelections, getShrinkSelections, selectionsToSportyFormat, AnalyzedSelection } from "@/lib/analyzer";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { code, action, count } = body as {
      code: string;
      action: "analyze" | "shrink";
      count?: number;
    };

    if (!code) {
      return NextResponse.json({ error: "Book code is required" }, { status: 400 });
    }

    // Fetch the ticket
    const ticket = await fetchBookCode(code);

    // Analyze
    const analysis = analyzeSelections(ticket.outcomes, ticket.ticket.selections, code);

    if (action === "shrink" && count && count > 0) {
      const { removed, kept } = getShrinkSelections(analysis.selections, count);
      
      if (kept.length === 0) {
        return NextResponse.json({ error: "Cannot remove all selections" }, { status: 400 });
      }

      // Create new code with kept selections
      const keptSporty = selectionsToSportyFormat(kept);
      const newCode = await createBookCode(keptSporty);

      return NextResponse.json({
        originalCode: code,
        newCode,
        removed: removed.map(s => ({
          homeTeam: s.homeTeam,
          awayTeam: s.awayTeam,
          tournament: s.tournament,
          pickDesc: s.pickDesc,
          odds: s.odds,
          riskScore: s.riskScore,
          riskReasons: s.riskReasons,
        })),
        kept: kept.map(s => ({
          homeTeam: s.homeTeam,
          awayTeam: s.awayTeam,
          tournament: s.tournament,
          pickDesc: s.pickDesc,
          odds: s.odds,
          riskScore: s.riskScore,
        })),
        totalOriginal: analysis.totalSelections,
        totalNew: kept.length,
        removedCount: removed.length,
      });
    }

    // Just analyze
    return NextResponse.json({
      originalCode: code,
      totalSelections: analysis.totalSelections,
      averageRisk: analysis.averageRisk,
      selections: analysis.selections.map(s => ({
        homeTeam: s.homeTeam,
        awayTeam: s.awayTeam,
        tournament: s.tournament,
        marketDesc: s.marketDesc,
        pickDesc: s.pickDesc,
        odds: s.odds,
        probability: s.probability,
        matchStatus: s.matchStatus,
        riskScore: s.riskScore,
        riskReasons: s.riskReasons,
        eventId: s.eventId,
        marketId: s.marketId,
        outcomeId: s.outcomeId,
        specifierRaw: s.specifierRaw,
        productId: s.productId,
        sportId: s.sportId,
      })),
    });
  } catch (error: any) {
    console.error("Analysis error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to process" },
      { status: 500 }
    );
  }
}
