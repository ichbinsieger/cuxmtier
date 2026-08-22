// ═══════════════════════════════════════════════════════════════
// HISTORICAL PRIORS — Bayesian blending for more accurate EV%
// ═══════════════════════════════════════════════════════════════

/** Known historical hit rates for specific league + market combos.
 *  These blend with bookmaker implied probability using Bayes.
 *  Null = no prior available for this combo — use raw bookmaker prob.
 *
 *  Sources: football-data.co.uk, betting market research.
 *  These are directional estimates — not precise, but better than raw.
 */

export interface PriorEntry {
  leaguePattern: string;   // substring match on tournament name
  marketPattern: string;   // substring match on market desc
  specifierPattern?: string; // optional, for over/under
  historicalHitRate: number; // 0–1, actual measured hit rate
  sampleSize: string;       // e.g. "~2400 games" for transparency
}

const PRIORS: PriorEntry[] = [
  // ── Over/Under markets ──
  { leaguePattern: "Bundesliga", marketPattern: "Over/Under", specifierPattern: "2.5", historicalHitRate: 0.58, sampleSize: "~2400" },
  { leaguePattern: "Bundesliga", marketPattern: "Over/Under", specifierPattern: "3.5", historicalHitRate: 0.38, sampleSize: "~2400" },
  { leaguePattern: "English Premier League", marketPattern: "Over/Under", specifierPattern: "2.5", historicalHitRate: 0.54, sampleSize: "~2500" },
  { leaguePattern: "Serie A", marketPattern: "Over/Under", specifierPattern: "2.5", historicalHitRate: 0.52, sampleSize: "~2500" },
  { leaguePattern: "La Liga", marketPattern: "Over/Under", specifierPattern: "2.5", historicalHitRate: 0.51, sampleSize: "~2400" },
  { leaguePattern: "Ligue 1", marketPattern: "Over/Under", specifierPattern: "2.5", historicalHitRate: 0.50, sampleSize: "~2300" },
  { leaguePattern: "Eredivisie", marketPattern: "Over/Under", specifierPattern: "2.5", historicalHitRate: 0.60, sampleSize: "~1800" },
  { leaguePattern: "Championship", marketPattern: "Over/Under", specifierPattern: "2.5", historicalHitRate: 0.49, sampleSize: "~3000" },

  // ── Home win markets ──
  { leaguePattern: "English Premier League", marketPattern: "1X2", historicalHitRate: 0.44, sampleSize: "~2500" },
  { leaguePattern: "Bundesliga", marketPattern: "1X2", historicalHitRate: 0.45, sampleSize: "~2400" },
  { leaguePattern: "Serie A", marketPattern: "1X2", historicalHitRate: 0.41, sampleSize: "~2500" },
  { leaguePattern: "La Liga", marketPattern: "1X2", historicalHitRate: 0.46, sampleSize: "~2400" },
  { leaguePattern: "Championship", marketPattern: "1X2", historicalHitRate: 0.42, sampleSize: "~3000" },

  // ── Double Chance ──
  { leaguePattern: "Bundesliga", marketPattern: "Double Chance", historicalHitRate: 0.76, sampleSize: "~2400" },
  { leaguePattern: "English Premier League", marketPattern: "Double Chance", historicalHitRate: 0.74, sampleSize: "~2500" },
  { leaguePattern: "Serie A", marketPattern: "Double Chance", historicalHitRate: 0.72, sampleSize: "~2500" },

  // ── Both Teams to Score ──
  { leaguePattern: "Bundesliga", marketPattern: "Both Teams to Score", historicalHitRate: 0.56, sampleSize: "~2400" },
  { leaguePattern: "English Premier League", marketPattern: "Both Teams to Score", historicalHitRate: 0.52, sampleSize: "~2500" },
  { leaguePattern: "Eredivisie", marketPattern: "Both Teams to Score", historicalHitRate: 0.58, sampleSize: "~1800" },
];

/**
 * Find matching prior for a tournament + market + specifier combo.
 */
export function findPrior(
  tournament: string,
  marketDesc: string,
  specifier?: string
): PriorEntry | null {
  for (const p of PRIORS) {
    if (!tournament.toLowerCase().includes(p.leaguePattern.toLowerCase())) continue;
    if (!marketDesc.toLowerCase().includes(p.marketPattern.toLowerCase())) continue;
    if (p.specifierPattern && specifier && !specifier.includes(p.specifierPattern)) continue;
    return p;
  }
  return null;
}

/**
 * Bayesian blending: blend bookmaker implied probability with historical prior.
 *
 * bookmakerProb: the probability implied by odds (1/odds after margin adjustment)
 * prior: historical hit rate for this league+market combo
 * bookmakerWeight: 0.7 default — how much we trust the bookmaker vs history
 *
 * Returns the adjusted probability.
 */
export function blendProbability(
  bookmakerProb: number,
  prior: PriorEntry,
  bookmakerWeight: number = 0.7
): number {
  const priorWeight = 1 - bookmakerWeight;
  const adjusted = bookmakerWeight * bookmakerProb + priorWeight * prior.historicalHitRate;

  // Floor adjustment: if prior strongly disagrees with bookmaker, don't go
  // more than 15% away from the bookmaker (avoid overcorrection)
  const maxDeviation = 0.15;
  const clamped = Math.max(
    bookmakerProb - maxDeviation,
    Math.min(bookmakerProb + maxDeviation, adjusted)
  );

  return clamped;
}

/**
 * EV% — expected value as a percentage.
 * Positive = edge over bookmaker, negative = bookmaker has the edge.
 */
export function expectedValue(odds: number, probability: number): number {
  if (odds <= 1 || probability <= 0) return -100;
  return Math.round((odds * probability - 1) * 100);
}

export interface EVResult {
  evPercent: number;
  adjustedProbability: number;
  priorUsed: PriorEntry | null;
}
