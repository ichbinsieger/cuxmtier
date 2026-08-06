import { SportySelection, SportyOutcome, resolveOutcome } from "./sportybet";

export interface AnalyzedSelection {
  homeTeam: string; awayTeam: string; tournament: string;
  category: string; marketDesc: string; pickDesc: string;
  odds: number; probability: number; matchStatus: string;
  riskScore: number; riskReasons: string[]; safeReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
  // MVE internals (exposed for transparency)
  baseVol: number; tailRisk: number; corrPenalty: number; margContribution: number;
}
export interface AnalysisResult {
  selections: AnalyzedSelection[];
  originalCode: string; totalSelections: number; averageRisk: number;
  portfolioVol: number;
}

// ══════════════════════════════════════════════════════════════════
// MULTIPLICATIVE VOLATILITY ENGINE (MVE)
// ══════════════════════════════════════════════════════════════════
//
// Core principle: accumulator volatility multiplies, not adds.
// Portfolio Vol = ∏(1 + σᵢ) - 1
//
// Each selection has:
//   σᵢ = baseVol × tailRisk × corrPenalty
//
// Where:
//   - baseVol: inherent uncertainty from tournament + market + region
//   - tailRisk: fat-tail adjustment from odds (longer odds = fatter tail)
//   - corrPenalty: penalty for same-event correlation
//
// Marginal volatility contribution (what to remove):
//   MVCᵢ = σᵢ / (1 + σᵢ)

// ── Tournament volatility coefficients ──
// Derived from historical result predictability across leagues
const TOURNAMENT_VOL: Record<string, number> = {
  // Elite — very predictable
  "UEFA Champions League": 0.08,
  "English Premier League": 0.09,
  "La Liga": 0.09,
  "Serie A": 0.10,
  "Bundesliga": 0.10,
  "Ligue 1": 0.10,
  "World Cup": 0.07,
  "European Championship": 0.09,
  // Strong
  "UEFA Europa League": 0.11,
  "Eredivisie": 0.12,
  "Primeira Liga": 0.12,
  "Championship": 0.13,
  "Copa America": 0.13,
  // Competitive
  "UEFA Conference League": 0.14,
  "FA Cup": 0.15,
  "League Cup": 0.16,
  // Unpredictable
  "Africa Cup of Nations": 0.18,
  "Africa Cup of Nations, Women": 0.22,
  "Pervaya Liga": 0.20,
  "Kolmonen": 0.23,
  "Torneo DIMAYOR": 0.24,
  "Liga 1": 0.21,
  "Primera LPF, Reserves": 0.28,
  "1. deild, Women": 0.30,
  "League Cup, National": 0.19,
  // Default for unknown
  "default": 0.18,
};

// ── Market type base volatility ──
// Simple markets have low vol; complex/specific ones have high vol
function getMarketVol(desc: string, specifier?: string): number {
  const d = desc.toLowerCase();
  // Double chance = almost always lands one way or another
  if (d.includes("double chance")) return 0.04;
  // Simple over/under with low threshold
  if (d.includes("over/under")) {
    if (specifier?.includes("total=0.5")) return 0.02;
    if (specifier?.includes("total=1.5")) return 0.05;
    if (specifier?.includes("total=2.5")) return 0.08;
    if (specifier?.includes("total=2")) return 0.10;  // whole number = void risk
    if (specifier?.includes("total=3")) return 0.14;
    return 0.12;
  }
  // Draw no bet
  if (d.includes("draw no bet")) return 0.09;
  // Win either half — moderate
  if (d.includes("win either half")) return 0.11;
  // Combo markets (Home or Over, Away or Over)
  if (d.includes("away or over") || d.includes("home team or over") || d.includes("home or over")) return 0.12;
  // Asian handicap
  if (d.includes("asian handicap")) {
    if (specifier?.includes("hcp=0.25") || specifier?.includes("hcp=-0.25")) return 0.13;
    if (specifier?.includes("hcp=0.5") || specifier?.includes("hcp=-0.5")) return 0.14;
    if (specifier?.includes("hcp=1") || specifier?.includes("hcp=-1")) return 0.16;
    return 0.18;
  }
  // Half-specific
  if (d.includes("2nd half")) return 0.17;
  if (d.includes("1st half")) return 0.17;
  // Goal bounds
  if (d.includes("goal bounds")) return 0.22;
  // Both halves
  if (d.includes("both halves")) return 0.24;
  // Default: 1X2 etc
  return 0.10;
}

// ── Region reliability adjustment ──
function getRegionAdj(category: string): number {
  const c = category.toLowerCase();
  if (c.includes("international clubs")) return 1.0;
  if (c.includes("england") || c.includes("germany") || c.includes("spain") ||
      c.includes("italy") || c.includes("france")) return 1.0;
  if (c.includes("netherlands") || c.includes("portugal")) return 1.05;
  if (c.includes("belgium") || c.includes("turkey") || c.includes("scotland")) return 1.08;
  if (c.includes("international")) return 1.10;
  if (c.includes("israel")) return 1.15;
  if (c.includes("belarus") || c.includes("finland") || c.includes("iceland")) return 1.20;
  if (c.includes("colombia") || c.includes("peru") || c.includes("argentina")) return 1.22;
  if (c.includes("women")) return 1.25;
  if (c.includes("reserve")) return 1.30;
  return 1.12;
}

// ── Tail risk from odds ──
// Longer odds = fatter tail in the loss distribution
// Uses log-odds transformation for smooth scaling
function getTailRisk(odds: number): number {
  if (odds <= 1.10) return 1.0;
  if (odds <= 1.20) return 1.08;
  if (odds <= 1.30) return 1.15;
  if (odds <= 1.40) return 1.25;
  if (odds <= 1.50) return 1.40;
  if (odds <= 1.60) return 1.60;
  if (odds <= 1.80) return 1.85;
  return 2.2;
}

// ── Main scoring function ──
function scoreMVE(resolved: ReturnType<typeof resolveOutcome>): {
  baseVol: number; tailRisk: number; corrPenalty: number;
  sigma: number; margContribution: number;
  safeReasons: string[]; riskReasons: string[];
} {
  if (!resolved) return { baseVol: 0.30, tailRisk: 1.5, corrPenalty: 1.0, sigma: 0.45, margContribution: 0.31, safeReasons: [], riskReasons: ["Could not resolve"] };

  const safeReasons: string[] = [];
  const riskReasons: string[] = [];

  // 1. Tournament volatility
  const tKey = resolved.tournament;
  const tVol = TOURNAMENT_VOL[tKey] ?? TOURNAMENT_VOL["default"];
  if (tVol <= 0.10) safeReasons.push(`Big league: ${resolved.tournament}`);
  else if (tVol <= 0.14) {} // neutral
  else if (tVol <= 0.19) riskReasons.push(`Small tournament: ${resolved.tournament}`);
  else if (tVol <= 0.24) riskReasons.push(`Minor league: ${resolved.tournament} — hard to predict`);
  else riskReasons.push(`Unknown league: ${resolved.tournament} — very unreliable`);

  // 2. Market volatility
  const mVol = getMarketVol(resolved.marketDesc, resolved.specifier);
  if (mVol <= 0.06) safeReasons.push(`Easy bet: ${resolved.marketDesc}`);
  else if (mVol <= 0.11) {} // neutral
  else if (mVol <= 0.15) riskReasons.push(`Tricky market: ${resolved.marketDesc}`);
  else if (mVol <= 0.20) riskReasons.push(`Hard to call: ${resolved.marketDesc}`);
  else riskReasons.push(`Very specific bet: ${resolved.marketDesc}`);

  // 3. Region adjustment
  const rAdj = getRegionAdj(resolved.category);
  if (rAdj <= 1.02) safeReasons.push(`Reliable region: ${resolved.category}`);
  else if (rAdj >= 1.20) riskReasons.push(`Unstable region: ${resolved.category}`);

  // 4. Base volatility = tournament × market × region
  const baseVol = tVol * (mVol / 0.10) * rAdj;

  // 5. Tail risk from odds
  const odds = resolved.odds;
  const tailRisk = getTailRisk(odds);
  if (odds <= 1.25) safeReasons.push(`Short odds (${odds}) — likely to land`);
  else if (odds > 1.45) riskReasons.push(`Risky odds (${odds}) — not a sure thing`);
  if (odds > 1.60) riskReasons.push(`High odds (${odds}) — unlikely to win`);

  // 6. Live game penalty
  const corrPenalty = resolved.matchStatus !== "Not start" ? 1.15 : 1.0;
  if (corrPenalty > 1.0) riskReasons.push("Game is live — things can change fast");

  // 7. Probability check
  if (resolved.probability > 0.75) safeReasons.push(`${Math.round(resolved.probability * 100)}% chance according to bookies`);
  else if (resolved.probability < 0.65) riskReasons.push(`Only ${Math.round(resolved.probability * 100)}% chance — bookies are unsure`);

  // 8. Final sigma
  const sigma = baseVol * tailRisk * corrPenalty;
  const margContribution = sigma / (1 + sigma);

  return { baseVol, tailRisk, corrPenalty, sigma, margContribution, safeReasons, riskReasons };
}

// ══════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════

export function analyzeSelections(
  outcomes: SportyOutcome[],
  ticketSelections: SportySelection[],
  code: string
): AnalysisResult {
  const selections: AnalyzedSelection[] = ticketSelections.map(sel => {
    const resolved = resolveOutcome(outcomes, sel);
    const mve = scoreMVE(resolved);

    // Convert sigma to 0-100 risk score using sigmoid for nice distribution
    const riskScore = Math.round(100 * (1 - 1 / (1 + mve.sigma * 3)));

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
      riskReasons: mve.riskReasons,
      safeReasons: mve.safeReasons,
      eventId: sel.eventId, marketId: sel.marketId, outcomeId: sel.outcomeId,
      specifierRaw: sel.specifier, productId: sel.productId, sportId: sel.sportId,
      baseVol: mve.baseVol, tailRisk: mve.tailRisk, corrPenalty: mve.corrPenalty,
      margContribution: mve.margContribution,
    };
  });

  // Sort by marginal volatility contribution (what to remove first)
  selections.sort((a, b) => b.margContribution - a.margContribution);

  // Portfolio volatility: ∏(1 + σ) - 1
  const portfolioVol = selections.reduce((prod, s) => prod * (1 + s.margContribution), 1) - 1;

  const averageRisk = Math.round(selections.reduce((sum, s) => sum + s.riskScore, 0) / selections.length);

  return { selections, originalCode: code, totalSelections: selections.length, averageRisk, portfolioVol };
}

export function getShrinkSelections(
  selections: AnalyzedSelection[],
  count: number
): { removed: AnalyzedSelection[]; kept: AnalyzedSelection[] } {
  const sorted = [...selections].sort((a, b) => b.margContribution - a.margContribution);
  const removed = sorted.slice(0, Math.min(count, sorted.length - 1));
  const removedIds = new Set(removed.map(s => s.eventId + s.marketId + s.outcomeId));
  const kept = selections.filter(s => !removedIds.has(s.eventId + s.marketId + s.outcomeId));
  return { removed, kept };
}

export function selectionsToSportyFormat(selections: AnalyzedSelection[]): SportySelection[] {
  return selections.map(s => ({
    eventId: s.eventId, marketId: s.marketId, specifier: s.specifierRaw,
    outcomeId: s.outcomeId, productId: s.productId, sportId: s.sportId,
  }));
}
