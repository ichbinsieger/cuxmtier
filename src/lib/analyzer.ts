import { SportySelection, SportyOutcome, resolveOutcome } from "./sportybet";

export interface AnalyzedSelection {
  // Display
  homeTeam: string;
  awayTeam: string;
  tournament: string;
  category: string;
  marketDesc: string;
  pickDesc: string;
  odds: number;
  probability: number;
  matchStatus: string;
  // Risk
  riskScore: number;      // 0-100, higher = riskier
  riskReasons: string[];  // why it's risky
  // Original ref
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifierRaw?: string;
  productId: number;
  sportId: string;
}

export interface AnalysisResult {
  selections: AnalyzedSelection[];
  originalCode: string;
  totalSelections: number;
  averageRisk: number;
}

// ============================================================
// RISK SCORING ENGINE
// ============================================================

// Tournament tier — lower = safer
const TOURNAMENT_TIERS: Record<string, number> = {
  "UEFA Champions League": 10,
  "UEFA Europa League": 12,
  "UEFA Conference League": 15,
  "English Premier League": 10,
  "La Liga": 10,
  "Serie A": 10,
  "Bundesliga": 10,
  "Ligue 1": 10,
  "Eredivisie": 12,
  "Primeira Liga": 12,
  "Championship": 15,
  // International
  "World Cup": 8,
  "European Championship": 10,
  "Africa Cup of Nations": 20,
  "Africa Cup of Nations, Women": 25,
  "Copa America": 15,
  // Domestic cups
  "League Cup": 18,
  "FA Cup": 16,
  // Lower tiers
  "Pervaya Liga": 22,
  "Kolmonen": 25,
  "Torneo DIMAYOR": 25,
  "Liga 1": 22,
  "Primera LPF, Reserves": 28,
  "1. deild, Women": 28,
  "League Cup, National": 20,
};

// Market type risk — lower = safer
function getMarketRisk(marketDesc: string, marketGroup: string, specifier?: string): number {
  const desc = marketDesc.toLowerCase();
  
  // Simple markets = safest
  if (desc.includes("double chance")) return 5;
  if (desc.includes("over/under") && !specifier?.includes("total=3")) return 8;
  if (desc.includes("draw no bet")) return 10;
  
  // Medium risk
  if (desc.includes("over/under") && specifier?.includes("total=3")) return 15;
  if (desc.includes("win either half")) return 12;
  if (desc.includes("away or over") || desc.includes("home or over") || desc.includes("home team or over")) return 13;
  
  // Handicaps
  if (desc.includes("asian handicap")) {
    if (specifier?.includes("hcp=1") || specifier?.includes("hcp=-1")) return 16;
    return 20;
  }
  
  // Complex/niche
  if (desc.includes("goal bounds")) return 22;
  if (desc.includes("both halves")) return 25;
  if (desc.includes("2nd half")) return 18;
  
  return 15; // default
}

function getTournamentRisk(tournament: string): number {
  // Exact match
  if (TOURNAMENT_TIERS[tournament]) return TOURNAMENT_TIERS[tournament];
  
  // Partial match
  const lower = tournament.toLowerCase();
  if (lower.includes("women")) return 25;
  if (lower.includes("reserve")) return 28;
  if (lower.includes("youth") || lower.includes("u19") || lower.includes("u21")) return 26;
  if (lower.includes("friendly")) return 22;
  
  return 18; // unknown
}

function getCategoryRisk(category: string): number {
  const lower = category.toLowerCase();
  if (lower.includes("international clubs")) return 12;
  if (lower.includes("international")) return 15;
  if (lower.includes("england") || lower.includes("spain") || lower.includes("italy") || 
      lower.includes("germany") || lower.includes("france")) return 10;
  if (lower.includes("belarus") || lower.includes("finland") || lower.includes("iceland")) return 20;
  if (lower.includes("colombia") || lower.includes("peru") || lower.includes("argentina")) return 22;
  if (lower.includes("israel")) return 20;
  return 16;
}

function scoreSelection(
  resolved: ReturnType<typeof resolveOutcome>
): { riskScore: number; riskReasons: string[] } {
  if (!resolved) return { riskScore: 50, riskReasons: ["Could not resolve selection"] };

  const reasons: string[] = [];
  let score = 0;

  // Tournament risk (weight: 35%)
  const tournamentRisk = getTournamentRisk(resolved.tournament);
  score += tournamentRisk * 0.35;
  if (tournamentRisk > 20) reasons.push(`Obscure tournament: ${resolved.tournament}`);
  if (tournamentRisk > 25) reasons.push("Very low-tier competition");

  // Market risk (weight: 30%)
  const marketRisk = getMarketRisk(resolved.marketDesc, resolved.marketGroup, resolved.specifier);
  score += marketRisk * 0.30;
  if (marketRisk > 18) reasons.push(`Complex market: ${resolved.marketDesc}`);
  if (resolved.marketDesc.toLowerCase().includes("handicap")) reasons.push("Handicap bet — margin matters");

  // Category risk (weight: 15%)
  const categoryRisk = getCategoryRisk(resolved.category);
  score += categoryRisk * 0.15;

  // Odds risk (weight: 20%) — higher odds = more uncertainty
  const odds = resolved.odds;
  if (odds > 1.6) {
    score += 25 * 0.20;
    reasons.push(`High odds (${odds}) — market sees this as unlikely`);
  } else if (odds > 1.45) {
    score += 18 * 0.20;
    reasons.push(`Elevated odds (${odds})`);
  } else if (odds > 1.35) {
    score += 12 * 0.20;
  } else if (odds > 1.25) {
    score += 8 * 0.20;
  } else {
    score += 4 * 0.20;
  }

  // Live game risk
  if (resolved.matchStatus !== "Not start") {
    score += 5;
    reasons.push("Live/in-play game — momentum can shift");
  }

  // Probability adjustment
  if (resolved.probability < 0.65) {
    score += 5;
    reasons.push(`Low implied probability (${Math.round(resolved.probability * 100)}%)`);
  }

  return {
    riskScore: Math.round(Math.min(100, score)),
    riskReasons: reasons,
  };
}

// ============================================================
// PUBLIC API
// ============================================================

export function analyzeSelections(
  outcomes: SportyOutcome[],
  ticketSelections: SportySelection[],
  code: string
): AnalysisResult {
  const selections: AnalyzedSelection[] = ticketSelections.map(sel => {
    const resolved = resolveOutcome(outcomes, sel);
    const { riskScore, riskReasons } = scoreSelection(resolved);
    
    return {
      homeTeam: resolved?.homeTeam || "Unknown",
      awayTeam: resolved?.awayTeam || "Unknown",
      tournament: resolved?.tournament || "Unknown",
      category: resolved?.category || "Unknown",
      marketDesc: resolved?.marketDesc || "Unknown",
      pickDesc: resolved?.pickDesc || "Unknown",
      odds: resolved?.odds || 0,
      probability: resolved?.probability || 0,
      matchStatus: resolved?.matchStatus || "Unknown",
      riskScore,
      riskReasons,
      eventId: sel.eventId,
      marketId: sel.marketId,
      outcomeId: sel.outcomeId,
      specifierRaw: sel.specifier,
      productId: sel.productId,
      sportId: sel.sportId,
    };
  });

  const averageRisk = selections.reduce((sum, s) => sum + s.riskScore, 0) / selections.length;

  return {
    selections: selections.sort((a, b) => b.riskScore - a.riskScore), // riskiest first
    originalCode: code,
    totalSelections: selections.length,
    averageRisk: Math.round(averageRisk),
  };
}

export function getShrinkSelections(
  selections: AnalyzedSelection[],
  count: number
): { removed: AnalyzedSelection[]; kept: AnalyzedSelection[] } {
  const sorted = [...selections].sort((a, b) => b.riskScore - a.riskScore);
  const removed = sorted.slice(0, Math.min(count, sorted.length - 1)); // always keep at least 1
  const removedIds = new Set(removed.map(s => s.eventId + s.marketId + s.outcomeId));
  const kept = selections.filter(s => !removedIds.has(s.eventId + s.marketId + s.outcomeId));
  return { removed, kept };
}

export function selectionsToSportyFormat(selections: AnalyzedSelection[]): SportySelection[] {
  return selections.map(s => ({
    eventId: s.eventId,
    marketId: s.marketId,
    specifier: s.specifierRaw,
    outcomeId: s.outcomeId,
    productId: s.productId,
    sportId: s.sportId,
  }));
}
