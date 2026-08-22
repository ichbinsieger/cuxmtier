import { SportySelection, SportyOutcome, resolveOutcome } from "./sportybet";
import { findPrior, blendProbability, expectedValue, type PriorEntry } from "./priors";

export interface AnalyzedSelection {
  homeTeam: string; awayTeam: string; tournament: string;
  category: string; marketDesc: string; pickDesc: string;
  odds: number; probability: number; matchStatus: string;
  riskScore: number; riskReasons: string[]; safeReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
  // MVE
  baseVol: number; tailRisk: number; corrPenalty: number;
  sigma: number; margContribution: number;
  // Kelly
  kellyFraction: number; kellyLabel: string;
  // Individual
  failProb: number;
  // EV% — primary metric
  evPercent: number;
  adjustedProbability: number;
  priorUsed: PriorEntry | null;
  // Best alternative
  bestAlternative: BestAlternative | null;
}

export interface AnalysisResult {
  selections: AnalyzedSelection[];
  originalCode: string; totalSelections: number; averageRisk: number;
  portfolioVol: number; failureProbability: number;
  correlationWarnings: string[];
  hedgeWarnings: string[];
  drawdownRisk: { loseFirstN: number; threshold: number; percent: number } | null;
}

// ═══════════════════════════════════════════════════════════════
// MULTIPLICATIVE VOLATILITY ENGINE v2
// ═══════════════════════════════════════════════════════════════

const TOURNAMENT_VOL: Record<string, number> = {
  "UEFA Champions League": 0.08, "English Premier League": 0.09,
  "La Liga": 0.09, "Serie A": 0.10, "Bundesliga": 0.10, "Ligue 1": 0.10,
  "World Cup": 0.07, "European Championship": 0.09,
  "UEFA Europa League": 0.11, "Eredivisie": 0.12, "Primeira Liga": 0.12,
  "Championship": 0.13, "Copa America": 0.13,
  "UEFA Conference League": 0.14, "FA Cup": 0.15, "League Cup": 0.16,
  "Africa Cup of Nations": 0.18, "Africa Cup of Nations, Women": 0.22,
  "Pervaya Liga": 0.20, "Kolmonen": 0.23, "Torneo DIMAYOR": 0.24,
  "Liga 1": 0.21, "Primera LPF, Reserves": 0.28, "1. deild, Women": 0.30,
  "League Cup, National": 0.19, "default": 0.18,
};

function getMarketVol(desc: string, specifier?: string): number {
  const d = desc.toLowerCase();
  if (d.includes("double chance")) return 0.04;
  if (d.includes("over/under")) {
    if (specifier?.includes("total=0.5")) return 0.02;
    if (specifier?.includes("total=1.5")) return 0.05;
    if (specifier?.includes("total=2.5")) return 0.08;
    if (specifier?.includes("total=2")) return 0.10;
    if (specifier?.includes("total=3")) return 0.14;
    return 0.12;
  }
  if (d.includes("draw no bet")) return 0.09;
  if (d.includes("win either half")) return 0.11;
  if (d.includes("away or over") || d.includes("home team or over") || d.includes("home or over")) return 0.12;
  if (d.includes("asian handicap")) {
    if (specifier?.includes("hcp=0.25") || specifier?.includes("hcp=-0.25")) return 0.13;
    if (specifier?.includes("hcp=0.5") || specifier?.includes("hcp=-0.5")) return 0.14;
    return 0.16;
  }
  if (d.includes("2nd half") || d.includes("1st half")) return 0.17;
  if (d.includes("goal bounds")) return 0.22;
  if (d.includes("both halves")) return 0.24;
  return 0.10;
}

function getRegionAdj(cat: string): number {
  const c = cat.toLowerCase();
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

// ── Kelly Criterion ──
// f* = (b*p - q) / b where b = decimal_odds - 1
// Positive = bet has edge, negative = skip, >0.15 = strong
function computeKelly(odds: number, probability: number): { fraction: number; label: string } {
  if (odds <= 1 || probability <= 0) return { fraction: 0, label: "skip" };
  const b = odds - 1;
  const q = 1 - probability;
  const f = (b * probability - q) / b;
  if (f > 0.15) return { fraction: f, label: "strong bet" };
  if (f > 0) return { fraction: f, label: "bet" };
  return { fraction: f, label: "skip" };
}

// ── Main scoring ──
function scorePick(resolved: ReturnType<typeof resolveOutcome>) {
  if (!resolved) return {
    sigma: 0.45, marg: 0.31, safeReasons: [], riskReasons: [],
    kellyF: 0, kellyL: "skip", failP: 0.5,
    baseVol: 0.18, tailRisk: 2.2, corrPenalty: 1.0,
    evPercent: -100, adjProb: 0, prior: null,
  };

  const safe: string[] = [], risk: string[] = [];

  // ── Historical prior + Bayesian blend ──
  const prior = findPrior(resolved.tournament, resolved.marketDesc, resolved.specifier);
  const bookmakerProb = resolved.probability || (1 / resolved.odds);
  const adjProb = prior ? blendProbability(bookmakerProb, prior) : bookmakerProb;
  const evPercent = Math.round((resolved.odds * adjProb - 1) * 100);

  if (prior) {
    safe.push(`Prior: ${Math.round(prior.historicalHitRate * 100)}% hit (${prior.sampleSize} games)`);
    if (adjProb > bookmakerProb + 0.03) safe.push(`Adjusted ↑ +${Math.round((adjProb - bookmakerProb) * 100)}% vs bookmaker`);
    else if (adjProb < bookmakerProb - 0.03) risk.push(`Adjusted ↓ ${Math.round((adjProb - bookmakerProb) * 100)}% vs bookmaker`);
  }

  const tKey = resolved.tournament;
  const tVol = TOURNAMENT_VOL[tKey] ?? TOURNAMENT_VOL["default"];
  if (tVol <= 0.10) safe.push(`Big league: ${resolved.tournament}`);
  else if (tVol > 0.19) risk.push(`Small tournament: ${resolved.tournament}`);

  const mVol = getMarketVol(resolved.marketDesc, resolved.specifier);
  if (mVol <= 0.06) safe.push(`Easy bet: ${resolved.marketDesc}`);
  else if (mVol > 0.15) risk.push(`Tricky market: ${resolved.marketDesc}`);

  const rAdj = getRegionAdj(resolved.category);
  if (rAdj <= 1.02) safe.push(`Reliable region`);
  else if (rAdj >= 1.20) risk.push(`Unstable region: ${resolved.category}`);

  const baseVol = tVol * (mVol / 0.10) * rAdj;
  const odds = resolved.odds;
  const tailRisk = getTailRisk(odds);
  if (odds <= 1.25) safe.push(`Short odds (${odds}) — likely to land`);
  else if (odds > 1.45) risk.push(`Risky odds (${odds})`);
  if (odds > 1.60) risk.push(`High odds — unlikely`);

  const corrPenalty = resolved.matchStatus !== "Not start" ? 1.15 : 1.0;
  if (corrPenalty > 1.0) risk.push("Game is live");

  if (adjProb > 0.75) safe.push(`${Math.round(adjProb * 100)}% chance`);
  else if (adjProb < 0.65) risk.push(`Only ${Math.round(adjProb * 100)}% chance`);

  const sigma = baseVol * tailRisk * corrPenalty;
  const kelly = computeKelly(odds, adjProb);
  const failP = 1 - adjProb;

  return {
    sigma, marg: sigma / (1 + sigma),
    safeReasons: safe, riskReasons: risk,
    kellyF: kelly.fraction, kellyL: kelly.label,
    baseVol, tailRisk, corrPenalty, failP,
    evPercent, adjProb, prior,
  };
}

// ═══════════════════════════════════════════════════════════════
// CORRELATION DETECTION
// ═══════════════════════════════════════════════════════════════
function detectCorrelations(selections: AnalyzedSelection[]): { selections: AnalyzedSelection[]; warnings: string[] } {
  const warnings: string[] = [];
  const eventGroups = new Map<string, AnalyzedSelection[]>();

  for (const s of selections) {
    const group = eventGroups.get(s.eventId) || [];
    group.push(s);
    eventGroups.set(s.eventId, group);
  }

  for (const [eventId, group] of Array.from(eventGroups.entries())) {
    if (group.length > 1) {
      const teams = `${group[0].homeTeam} vs ${group[0].awayTeam}`;
      warnings.push(`${group.length} picks from the same game: ${teams}`);
      // Apply correlation penalty to all picks in this group
      const penalty = 1 + (group.length - 1) * 0.25;
      for (const s of group) {
        s.corrPenalty *= penalty;
        s.sigma = s.baseVol * s.tailRisk * s.corrPenalty;
        s.margContribution = s.sigma / (1 + s.sigma);
        s.riskScore = Math.round(100 * (1 - 1 / (1 + s.sigma * 3)));
        s.riskReasons.push(`${group.length} picks from same game — if it goes wrong, all ${group.length} fail`);
      }
    }
  }

  return { selections, warnings };
}

// ═══════════════════════════════════════════════════════════════
// HEDGE / ARBITRAGE DETECTION
// ═══════════════════════════════════════════════════════════════

/** Pairs of outcomes that are contradictory (can't both win) */
const CONTRADICTIONS: Array<{ a: RegExp; b: RegExp; label: string }> = [
  // 1X2 opposites
  { a: /\bhome\b/i, b: /\baway\b/i, label: "Home Win + Away Win on same game — one will always lose" },
  { a: /\bhome\b/i, b: /\bdraw\b/i, label: "Home Win + Draw on same game — can't both hit" },
  { a: /\baway\b/i, b: /\bdraw\b/i, label: "Away Win + Draw on same game — can't both hit" },
  // Over/Under opposites
  { a: /\bover\b/i, b: /\bunder\b/i, label: "Over + Under on same market — contradictory picks" },
  // Home Win vs Double Chance (Away or Draw)
  { a: /\bhome\b/i, b: /\baway or draw\b/i, label: "Home Win + Away/Draw covers all outcomes — waste of a pick" },
  { a: /\baway\b/i, b: /\bhome or draw\b/i, label: "Away Win + Home/Draw covers all outcomes — waste of a pick" },
  // Both Teams to Score vs No
  { a: /\byes\b/i, b: /\bno\b/i, label: "BTTS Yes + No on same game — can't both hit" },
];

function detectHedges(selections: AnalyzedSelection[]): string[] {
  const warnings: string[] = [];
  const eventGroups = new Map<string, AnalyzedSelection[]>();

  for (const s of selections) {
    const group = eventGroups.get(s.eventId) || [];
    group.push(s);
    eventGroups.set(s.eventId, group);
  }

  for (const [, group] of Array.from(eventGroups.entries())) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        // Must be different markets or different outcomes
        if (a.marketId === b.marketId && a.outcomeId === b.outcomeId) continue;
        for (const rule of CONTRADICTIONS) {
          const aMatch = rule.a.test(a.pickDesc) || rule.a.test(a.marketDesc);
          const bMatch = rule.b.test(b.pickDesc) || rule.b.test(b.marketDesc);
          if (aMatch && bMatch) {
            const teams = `${a.homeTeam} vs ${a.awayTeam}`;
            warnings.push(`⚠️ ${teams}: ${rule.label}`);
            break;
          }
        }
      }
    }
  }

  return warnings;
}

// ═══════════════════════════════════════════════════════════════
// DRAWDOWN RISK
// ═══════════════════════════════════════════════════════════════

/** Probability you lose the first N picks (all fail before any win).
 *  More useful than portfolio vol — tells you how bad a start could be. */
function computeDrawdown(selections: AnalyzedSelection[]): { loseFirstN: number; threshold: number; percent: number } | null {
  if (selections.length === 0) return null;

  // Find N where chance of losing first N drops below 50% (the breakeven threshold)
  let threshold = 1;
  for (let n = 1; n <= selections.length; n++) {
    let probAllLose = 1;
    for (let i = 0; i < n; i++) {
      probAllLose *= (1 - selections[i].adjustedProbability);
    }
    if (probAllLose < 0.5) {
      threshold = n;
      break;
    }
  }

  // Chance of losing first 3 (or all if less than 3)
  const checkN = Math.min(3, selections.length);
  let probLoseFirstN = 1;
  for (let i = 0; i < checkN; i++) {
    probLoseFirstN *= (1 - selections[i].adjustedProbability);
  }

  return {
    loseFirstN: checkN,
    threshold,
    percent: Math.round(probLoseFirstN * 100),
  };
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/** Best alternative pick — lowest sigma across all markets for an event */
export interface BestAlternative {
  marketDesc: string; pickDesc: string; odds: number;
  sigma: number; riskScore: number; riskReasons: string[]; safeReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
}

/** Scan all markets on an event and return the lowest-sigma pick */
export function findBestPickForEvent(
  eventOutcome: SportyOutcome,
  currentOutcomeId: string
): BestAlternative | null {
  let best: { resolved: NonNullable<ReturnType<typeof resolveOutcome>>; mve: ReturnType<typeof scorePick> } | null = null;
  let bestScore = Infinity;

  for (const market of eventOutcome.markets) {
    for (const outcome of market.outcomes) {
      // Skip the currently selected pick
      if (outcome.id === currentOutcomeId) continue;

      const sel: SportySelection = {
        eventId: eventOutcome.eventId,
        marketId: market.id,
        specifier: market.specifier,
        outcomeId: outcome.id,
        productId: market.product,
        sportId: eventOutcome.sport.id,
      };

      const resolved = resolveOutcome([eventOutcome], sel);
      if (!resolved) continue;
      const mve = scorePick(resolved);
      if (mve.sigma < bestScore) {
        bestScore = mve.sigma;
        best = { resolved, mve };
      }
    }
  }

  if (!best) return null;

  return {
    marketDesc: best.resolved.marketDesc,
    pickDesc: best.resolved.pickDesc,
    odds: best.resolved.odds,
    sigma: best.mve.sigma,
    riskScore: Math.round(100 * (1 - 1 / (1 + best.mve.sigma * 3))),
    riskReasons: best.mve.riskReasons,
    safeReasons: best.mve.safeReasons,
    eventId: best.resolved.eventId,
    marketId: best.resolved.marketId,
    outcomeId: best.resolved.outcomeId,
    specifierRaw: best.resolved.specifierRaw,
    productId: best.resolved.productId,
    sportId: best.resolved.sportId,
  };
}

export function analyzeSelections(
  outcomes: SportyOutcome[],
  ticketSelections: SportySelection[],
  code: string
): AnalysisResult {
  let selections: AnalyzedSelection[] = ticketSelections.map(sel => {
    const resolved = resolveOutcome(outcomes, sel);
    const mve = scorePick(resolved);
    // Find best alternative for this event
    const eventOutcome = outcomes.find(o => o.eventId === sel.eventId);
    const bestAlt = eventOutcome ? findBestPickForEvent(eventOutcome, sel.outcomeId) : null;
    return {
      homeTeam: resolved?.homeTeam || "?", awayTeam: resolved?.awayTeam || "?",
      tournament: resolved?.tournament || "?", category: resolved?.category || "?",
      marketDesc: resolved?.marketDesc || "?", pickDesc: resolved?.pickDesc || "?",
      odds: resolved?.odds || 0, probability: resolved?.probability || 0,
      matchStatus: resolved?.matchStatus || "?",
      riskScore: Math.round(100 * (1 - 1 / (1 + mve.sigma * 3))),
      riskReasons: mve.riskReasons, safeReasons: mve.safeReasons,
      eventId: sel.eventId, marketId: sel.marketId, outcomeId: sel.outcomeId,
      specifierRaw: sel.specifier, productId: sel.productId, sportId: sel.sportId,
      baseVol: mve.baseVol, tailRisk: mve.tailRisk, corrPenalty: mve.corrPenalty,
      sigma: mve.sigma, margContribution: mve.marg,
      kellyFraction: mve.kellyF, kellyLabel: mve.kellyL,
      failProb: mve.failP,
      evPercent: mve.evPercent,
      adjustedProbability: mve.adjProb,
      priorUsed: mve.prior,
      bestAlternative: bestAlt,
    };
  });

  // Apply correlation penalties
  const corrResult = detectCorrelations(selections);
  selections = corrResult.selections;

  // Sort by marginal contribution
  selections.sort((a, b) => b.margContribution - a.margContribution);

  const portfolioVol = selections.reduce((p, s) => p * (1 + s.sigma), 1) - 1;
  const failureProbability = 1 - selections.reduce((p, s) => p * (1 - s.failProb), 1);
  const avgRisk = Math.round(selections.reduce((s, x) => s + x.riskScore, 0) / selections.length);
  const hedgeWarnings = detectHedges(selections);
  const drawdownRisk = computeDrawdown(selections);

  return {
    selections, originalCode: code, totalSelections: selections.length,
    averageRisk: avgRisk, portfolioVol, failureProbability,
    correlationWarnings: corrResult.warnings,
    hedgeWarnings,
    drawdownRisk,
  };
}

export function getShrinkSelections(selections: AnalyzedSelection[], count: number) {
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

export function recomputePortfolio(selections: AnalyzedSelection[]): { portfolioVol: number; failureProbability: number } {
  const vol = selections.reduce((p, s) => p * (1 + s.sigma), 1) - 1;
  const fail = 1 - selections.reduce((p, s) => p * (1 - s.failProb), 1);
  return { portfolioVol: vol, failureProbability: fail };
}
