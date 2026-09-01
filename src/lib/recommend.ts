// Recommendation engine — scans SportyBet's live API, finds safe bets,
// and builds accumulator slips targeting ~5 and ~10 total odds.
//
// Flow:
//   1. Fetch importantEvents from multiple sports (Football, Basketball, Tennis)
//   2. Extract all qualifying outcomes (high prob, short odds, good leagues, upcoming)
//   3. Score each pick by safety
//   4. Greedy-build accumulators targeting ~5.0 and ~10.0 odds
//   5. Create SportyBet booking codes via the share API

import { SportySelection, createBookCode } from "./sportybet";
import { scoreDraw, findTeam, getTeamForm, getH2HDrawRate } from "./drawModel";
import type { ApiTeam, TeamForm } from "./drawModel";
import { getCsvTeamStats, leagueCodeFor, type CsvTeamStats } from "./footballData";

// ── Types ────────────────────────────────────────────────────────

interface SportyEventRaw {
  eventId: string;
  gameId: string;
  matchStatus: string;
  estimateStartTime: number;
  homeTeamName: string;
  awayTeamName: string;
  totalMarketSize: number;
  sport: {
    id: string;
    name: string;
    category: { id: string; name: string; tournament: { id: string; name: string } };
  };
  markets: Array<{
    id: string;
    specifier?: string;
    product: number;
    desc: string;
    group: string;
    outcomes: Array<{
      id: string;
      odds: string;
      probability: string;
      desc: string;
    }>;
  }>;
}

interface TournamentGroup {
  id: string;
  name: string;
  events: SportyEventRaw[];
}

export interface SafePick {
  eventId: string; marketId: string; outcomeId: string;
  specifier?: string; productId: number; sportId: string;
  homeTeam: string; awayTeam: string; tournament: string;
  marketDesc: string; pickDesc: string; odds: number;
  probability: number; safetyScore: number;
}

export interface RecommendedSlip {
  targetOdds: number;
  actualOdds: number;
  code: string;
  picks: SafePick[];
}

// ── Constants ────────────────────────────────────────────────────

const SPORTYBET_FACTS = "https://www.sportybet.com/api/ng/factsCenter";

// Markets to request per event: 1X2, Over/Under, Double Chance, GG/NG,
// Draw No Bet, Handicap, Odd/Even, Combo, 1X2-2UP. Same set the SportyBet
// web client requests — covers every "safe" market the engine scores.
const UPCOMING_MARKETS = "1,18,10,29,11,26,36,14,60100";

// How many tournament pages to pull per sport. `importantEvents` returned a
// tiny curated subset (often missing Premier League / Champions League /
// LaLiga entirely); `pcUpcomingEvents` returns the full catalogue, paginated.
// Elite leagues all live on page 1; 4 pages comfortably covers top + tier-2.
const MAX_PAGES_PER_SPORT = 4;

const SPORTS_TO_SCAN = [
  { id: "sr:sport:1", name: "Football" },
  { id: "sr:sport:2", name: "Basketball" },
  { id: "sr:sport:5", name: "Tennis" },
  { id: "sr:sport:202120001", name: "vFootball" },
  { id: "sr:sport:21", name: "Cricket" },
];

// Odds range for "safe" picks
const MIN_ODDS = 1.05;
const MAX_ODDS = 1.70;

// Accumulator targets
const TARGETS = [5, 10, 15];

// ── Same-day filter ────────────────────────────────────────────────
// Only consider matches that kick off today (Africa/Lagos time). Betting
// same-day means we bet at near-closing odds — future games are excluded
// because their opening odds will drift before kickoff, which produces a
// false "edge" that isn't real.
const lagosDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Lagos",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function isSameDay(estimateStartTimeMs: number): boolean {
  if (!estimateStartTimeMs || estimateStartTimeMs <= 0) return false;
  return lagosDayFmt.format(new Date(estimateStartTimeMs)) === lagosDayFmt.format(new Date());
}

// ── League Weighting ────────────────────────────────────────────

function leagueWeight(tournament: string, country?: string): number {
  const n = tournament.toLowerCase();
  const c = (country || "").toLowerCase();

  // Elite — weight 1.0
  if (n.includes("champions league") && !n.includes("women")) return 1.0;
  if (n.includes("world cup")) return 1.0;
  // English Premier League ONLY — SportyBet also labels the Russian and
  // Ukrainian top flights "Premier League", so the country must match.
  if (n.includes("premier league") && c === "england" && !n.includes("women") && !n.includes("reserve") && !n.includes("youth")) return 1.0;

  // Top 5 leagues — first division only, country-scoped to avoid matching
  // second divisions ("2. Bundesliga", "LALIGA HYPERMOTION", "Brasileiro Serie A").
  if (c === "germany" && n === "bundesliga") return 0.95;
  if ((n.includes("la liga") || n.includes("laliga") || n.includes("primera division")) && !n.includes("hypermotion")) return 0.95;
  if (c === "italy" && n.includes("serie a") && !n.includes("women")) return 0.92;
  if (n.includes("ligue 1")) return 0.90;

  // Tier 2
  if (n.includes("europa league")) return 0.90;
  if (n.includes("eredivisie")) return 0.85;
  if (n.includes("primeira liga")) return 0.85;
  if (n.includes("mls")) return 0.82;
  if (n.includes("championship")) return 0.80;
  if (n.includes("brasileir") || n.includes("super lig")) return 0.78;
  if (n.includes("conference league")) return 0.78;
  if (n.startsWith("2.") && n.includes("bundesliga")) return 0.75; // 2. Bundesliga

  // Tier 3
  if (n.includes("liga mx") || n.includes("jupiler") || n.includes("pro league")) return 0.70;
  if (n.includes("scottish premiership") || n.includes("austrian bundesliga")) return 0.68;
  // Russian / Ukrainian top flights — SportyBet calls both "Premier League"
  if (n.includes("premier league") && (c === "russia" || c === "ukraine")) return 0.66;
  if (n.includes("allsvenskan") || n.includes("eliteserien")) return 0.65;
  if (n.includes("superliga")) return 0.65;

  // Domestic cups / lower divisions → still decent
  if (n.includes("fa cup") || n.includes("carabao") || n.includes("dfb pokal") || n.includes("copa del rey")) return 0.62;

  // Penalize — obscure, youth, reserve, women's, friendlies
  if (n.includes("reserve") || n.includes("reserves")) return 0.35;
  if (n.includes("women")) return 0.40;
  if (n.includes("youth") || n.includes("u19") || n.includes("u21") || n.includes("u23")) return 0.30;
  if (n.includes("friend")) return 0.42;
  if (n.includes("npl") && (n.includes("reserve") || n.includes("women"))) return 0.35;
  if (n.includes("npl") || n.includes("state")) return 0.45;

  // Simulated reality = skip entirely
  if (n.includes("srl") || n.includes("simulated")) return 0;

  return 0.60; // default — unknown league (higher baseline to ensure enough picks)
}

// ── Market Favorability ─────────────────────────────────────────

function marketFavorability(marketDesc: string, specifier?: string): number {
  const d = marketDesc.toLowerCase();
  if (d.includes("double chance")) return 1.08;
  if (d.includes("draw no bet")) return 1.05;
  if (d === "1x2") return 1.0;
  if (d.includes("over/under")) {
    if (specifier?.includes("total=0.5")) return 1.10;
    if (specifier?.includes("total=1.5")) return 1.05;
    if (specifier?.includes("total=2.5")) return 0.92;
    return 0.85;
  }
  if (d.includes("gg/ng")) return 0.85;
  if (d.includes("win either half")) return 0.82;
  if (d.includes("1st half") || d.includes("2nd half")) return 0.75;
  if (d.includes("goal bounds")) return 0.70;
  return 0.88;
}

// ── Safety Scoring ──────────────────────────────────────────────

function scorePick(raw: SportyEventRaw, market: SportyEventRaw["markets"][0], outcome: SportyEventRaw["markets"][0]["outcomes"][0]): number {
  const odds = parseFloat(outcome.odds);
  const prob = parseFloat(outcome.probability || "0");
  const league = raw.sport.category.tournament.name;
  const country = raw.sport.category.name;

  let score = prob; // base — higher probability = safer

  // League quality
  score *= leagueWeight(league, country);

  // Market type favorability
  score *= marketFavorability(market.desc, market.specifier);

  // Odds penalty: very safe below 1.25, penalty above 1.45
  if (odds <= 1.10) score *= 1.08;
  else if (odds <= 1.20) score *= 1.04;
  else if (odds <= 1.30) score *= 1.0;
  else if (odds <= 1.45) score *= 0.93;
  else score *= 0.85;

  return score;
}

// ── API Fetch ────────────────────────────────────────────────────

async function fetchSportEvents(sportId: string): Promise<TournamentGroup[]> {
  const all: TournamentGroup[] = [];

  for (let page = 1; page <= MAX_PAGES_PER_SPORT; page++) {
    const params = new URLSearchParams({
      sportId,
      marketId: UPCOMING_MARKETS,
      pageSize: "100",
      pageNum: String(page),
      option: "1",
    });
    const url = `${SPORTYBET_FACTS}/pcUpcomingEvents?${params.toString()}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });
    if (!res.ok) break;
    const json = await res.json();
    if (json.bizCode !== 10000) break;

    const tournaments: TournamentGroup[] = json.data?.tournaments || [];
    if (tournaments.length === 0) break;
    all.push(...tournaments);
  }

  return all;
}

// ── Extract Safe Picks ─────────────────────────────────────────

export async function collectSafePicks(): Promise<SafePick[]> {
  const allPicks: SafePick[] = [];

  const results = await Promise.all(SPORTS_TO_SCAN.map(s => fetchSportEvents(s.id)));

  for (const tournaments of results) {
    for (const tournament of tournaments) {
      for (const event of tournament.events) {
        // Skip live/in-play matches
        if (event.matchStatus !== "Not start") continue;

        // Same-day only — future games' opening odds will drift
        if (!isSameDay(event.estimateStartTime)) continue;

        // Skip leagues with zero weight (simulated)
        if (leagueWeight(event.sport.category.tournament.name, event.sport.category.name) === 0) continue;

        for (const market of event.markets) {
          for (const outcome of market.outcomes) {
            const odds = parseFloat(outcome.odds);
            if (odds < MIN_ODDS || odds > MAX_ODDS) continue;

            const safety = scorePick(event, market, outcome);
            if (safety < 0.08) continue; // too risky

            allPicks.push({
              eventId: event.eventId,
              marketId: market.id,
              outcomeId: outcome.id,
              specifier: market.specifier || undefined,
              productId: market.product,
              sportId: event.sport.id,
              homeTeam: event.homeTeamName,
              awayTeam: event.awayTeamName,
              tournament: event.sport.category.tournament.name,
              marketDesc: market.desc,
              pickDesc: outcome.desc,
              odds,
              probability: parseFloat(outcome.probability || "0"),
              safetyScore: safety,
            });
          }
        }
      }
    }
  }

  // Sort by safety score descending
  allPicks.sort((a, b) => b.safetyScore - a.safetyScore);

  return allPicks;
}

// ── Accumulator Builder ─────────────────────────────────────────
//
// Uses a best-fit approach: from the top-N safest picks across unique events,
// greedily pick the one whose odds contribution best approaches the target
// per remaining slot.

function buildSlip(
  picks: SafePick[],
  targetOdds: number,
  minGames: number,
  maxGames: number
): SafePick[] | null {
  // Deduplicate by event — keep highest safety score per event
  const bestPerEvent = new Map<string, SafePick>();
  for (const p of picks) {
    const existing = bestPerEvent.get(p.eventId);
    if (!existing || p.safetyScore > existing.safetyScore) {
      bestPerEvent.set(p.eventId, p);
    }
  }

  const unique = Array.from(bestPerEvent.values());
  unique.sort((a, b) => b.safetyScore - a.safetyScore);

  if (unique.length < minGames) return null;

  const targetLog = Math.log(targetOdds);
  const slip: SafePick[] = [];
  const used = new Set<string>();
  let currentLog = 0;

  for (let round = 0; round < maxGames && slip.length < maxGames; round++) {
    const remaining = maxGames - slip.length;
    const needLog = targetLog - currentLog;
    const idealPerPick = remaining > 0 ? needLog / remaining : 0;

    // Find best candidate: closest odds to ideal, from top candidates
    let best: SafePick | null = null;
    let bestScore = Infinity;
    const poolSize = Math.min(unique.length, slip.length + 50); // search top 50

    for (let i = 0; i < poolSize; i++) {
      const p = unique[i];
      if (used.has(p.eventId)) continue;

      const pickLog = Math.log(p.odds);
      const newLog = currentLog + pickLog;

      // Don't massively overshoot on the last few picks
      if (slip.length >= minGames && remaining <= 2 && newLog > targetLog * 1.15) continue;
      // Skip very low odds if we're far from target with few slots left
      if (slip.length >= minGames && pickLog < 0.12 && needLog > 0.3 && remaining <= 3) continue;

      // Score: how close is this pick's log to ideal? Weighted by safety
      const logDiff = Math.abs(pickLog - idealPerPick);
      const weightedScore = logDiff * (1.5 - p.safetyScore); // lower = better

      if (weightedScore < bestScore) {
        bestScore = weightedScore;
        best = p;
      }
    }

    if (!best) {
      // Fallback: just pick the safest remaining
      for (let i = 0; i < unique.length; i++) {
        const p = unique[i];
        if (!used.has(p.eventId)) {
          best = p;
          break;
        }
      }
    }

    if (!best) break;

    slip.push(best);
    currentLog += Math.log(best.odds);
    used.add(best.eventId);

    // Stop early if we've hit the target range
    if (slip.length >= minGames && currentLog >= targetLog * 0.90 && currentLog <= targetLog * 1.10) {
      break;
    }
  }

  if (slip.length < minGames) return null;

  const actualOdds = Math.round(Math.exp(currentLog) * 100) / 100;
  if (actualOdds < targetOdds * 0.6) return null;

  return slip;
}

// ── Sporty Selection Converter ─────────────────────────────────

function toSportySelection(p: SafePick): SportySelection {
  return {
    eventId: p.eventId,
    marketId: p.marketId,
    specifier: p.specifier,
    outcomeId: p.outcomeId,
    productId: p.productId,
    sportId: p.sportId,
  };
}

// ── Public API ──────────────────────────────────────────────────

const TARGET_CONFIG: Record<number, { minGames: number; maxGames: number }> = {
  5: { minGames: 5, maxGames: 7 },
  10: { minGames: 5, maxGames: 7 },
  15: { minGames: 5, maxGames: 7 },
};
const TARGET_FILTERS: Record<number, { minOdds: number; maxOdds: number }> = {
  5: { minOdds: 1.25, maxOdds: 1.65 },
  10: { minOdds: 1.35, maxOdds: 1.90 },
  15: { minOdds: 1.45, maxOdds: 2.15 },
};

function filterForTarget(picks: SafePick[], target: number): SafePick[] {
  const f = TARGET_FILTERS[target];
  if (!f) return picks;
  return picks.filter(p =>
    p.odds >= f.minOdds &&
    p.odds <= f.maxOdds &&
    !p.sportId.startsWith("sr:sport:202") && // exclude vFootball virtual
    !p.tournament.toLowerCase().includes("srl") && // exclude simulated reality
    !p.tournament.toLowerCase().includes("simulated")
  );
}

export async function getRecommendations(): Promise<RecommendedSlip[]> {
  const allPicks = await collectSafePicks();

  if (allPicks.length < 5) {
    console.warn(`Only ${allPicks.length} safe picks available — need at least 5`);
    return [];
  }

  const results: RecommendedSlip[] = [];

  for (const target of TARGETS) {
    const filtered = filterForTarget(allPicks, target);
    const cfg = TARGET_CONFIG[target];
    if (filtered.length < cfg.minGames) continue;

    const slip = buildSlip(filtered, target, cfg.minGames, cfg.maxGames);
    if (!slip) continue;

    try {
      const code = await createBookCode(slip.map(toSportySelection));
      const actualOdds = Math.round(slip.reduce((p, s) => p * s.odds, 1) * 100) / 100;

      results.push({
        targetOdds: target,
        actualOdds,
        code,
        picks: slip,
      });
    } catch (e) {
      console.error(`Failed to create code for ${target} odds slip:`, e);
    }
  }

  return results;
}

// ── Risky Draw Accumulator (target ~1000x) ────────────────────────
//
// Builds a single high-risk, high-reward slip made entirely of 1X2 "Draw"
// outcomes. Each draw is typically ~3.0–4.0 odds, so 5–7 draws compound to
// ~1000x. Draws are ranked by a multi-factor model (see drawModel.ts) rather
// than raw bookmaker probability.

const DRAW_TARGET = 1000;
const DRAW_MIN_ODDS = 2.8;
const DRAW_MAX_ODDS = 4.5;
// How many candidate matches to enrich with H2H + team-character data.
// API-Football free plan = 10 req/min + 100/day. 8 matches ≈ 40 calls ≈
// 3.5 min first-run warm-up (persistent cache makes later runs near-free).
const DRAW_ENRICH_LIMIT = 8;

interface DrawCandidate {
  pick: SafePick;
  country: string;
  homeProb: number; // P(home win) from 1X2
  awayProb: number; // P(away win) from 1X2
  drawProb: number; // P(draw) from 1X2
}

async function collectDrawPicks(): Promise<DrawCandidate[]> {
  // Draws only exist on football 1X2 markets, so scan football alone.
  const groups = await fetchSportEvents("sr:sport:1");
  const draws: DrawCandidate[] = [];

  for (const tournament of groups) {
    for (const event of tournament.events) {
      if (event.matchStatus !== "Not start") continue;

      // Same-day only — future games' opening odds will drift
      if (!isSameDay(event.estimateStartTime)) continue;

      const league = event.sport.category.tournament.name;
      const country = event.sport.category.name;
      if (leagueWeight(league, country) === 0) continue; // skip simulated

      for (const market of event.markets) {
        if (market.desc.toLowerCase() !== "1x2") continue;

        // Extract the three 1X2 probabilities (home / draw / away)
        let homeProb = 0, awayProb = 0, drawProb = 0, drawOutcome = null;
        for (const outcome of market.outcomes) {
          const p = parseFloat(outcome.probability || "0");
          const d = outcome.desc.toLowerCase();
          if (d === "home" || d === "1") homeProb = p;
          else if (d === "away" || d === "2") awayProb = p;
          else if (d === "draw" || d === "x") { drawProb = p; drawOutcome = outcome; }
        }

        if (!drawOutcome) continue;
        const odds = parseFloat(drawOutcome.odds);
        if (odds < DRAW_MIN_ODDS || odds > DRAW_MAX_ODDS) continue;

        const safety = drawProb * leagueWeight(league, country);

        draws.push({
          homeProb,
          awayProb,
          drawProb,
          country,
          pick: {
            eventId: event.eventId,
            marketId: market.id,
            outcomeId: drawOutcome.id,
            specifier: market.specifier || undefined,
            productId: market.product,
            sportId: event.sport.id,
            homeTeam: event.homeTeamName,
            awayTeam: event.awayTeamName,
            tournament: league,
            marketDesc: market.desc,
            pickDesc: drawOutcome.desc,
            odds,
            probability: drawProb,
            safetyScore: safety,
          },
        });
      }
    }
  }

  // Sort by raw draw probability first (cheap pre-filter)
  draws.sort((a, b) => b.drawProb - a.drawProb);
  return draws;
}

function buildDrawSlip(draws: SafePick[]): SafePick[] | null {
  // Deduplicate by event, keep highest-safety draw per match
  const bestPerEvent = new Map<string, SafePick>();
  for (const d of draws) {
    const existing = bestPerEvent.get(d.eventId);
    if (!existing || d.safetyScore > existing.safetyScore) bestPerEvent.set(d.eventId, d);
  }
  const unique = Array.from(bestPerEvent.values());

  // Target ~1000x combined odds. Draws are ~2.8–4.5 each, so 6 draws lands
  // in the ~700–1500x sweet spot. Accumulate until combined odds reach the
  // target band (or we hit 7 games), without overshooting past ~1500x.
  const slip: SafePick[] = [];
  let combined = 1;

  for (const d of unique) {
    if (slip.length >= 7) break;
    const next = combined * d.odds;
    // Once we have a playable slip, skip draws that would overshoot the band
    if (slip.length >= 5 && next > 1500) continue;

    slip.push(d);
    combined = next;

    if (slip.length >= 5 && combined >= 700) break;
  }

  if (slip.length < 5) return null;
  if (combined < 400) return null; // too far from 1000x
  return slip;
}

export async function getDrawRecommendation(): Promise<RecommendedSlip | null> {
  const candidates = await collectDrawPicks();
  if (candidates.length < 5) return null;

  // Enrich the top candidates with H2H + team-character data.
  // Team character (form/goals/home-away split/drift) prefers the current-
  // season Football-Data.co.uk CSV when the league is in our catalogue, and
  // falls back to API-Football otherwise. H2H always uses API-Football.
  const teamCache = new Map<string, { team: ApiTeam | null }>();
  const formCache = new Map<number, TeamForm | null>();
  const h2hCache = new Map<string, number | null>();
  const csvCache = new Map<string, CsvTeamStats | null>();

  const enriched: SafePick[] = [];

  for (const c of candidates.slice(0, DRAW_ENRICH_LIMIT)) {
    const { pick } = c;
    try {
      // Always resolve API-Football ids — needed for H2H regardless of source.
      const homeTeam = await findTeamCached(pick.homeTeam, c.country, teamCache);
      const awayTeam = await findTeamCached(pick.awayTeam, c.country, teamCache);

      // Form/goals/drift: prefer current-season CSV, fall back to API-Football.
      const leagueCode = leagueCodeFor(pick.tournament, c.country);
      const homeCsv = await csvCached(pick.homeTeam, leagueCode, csvCache);
      const awayCsv = await csvCached(pick.awayTeam, leagueCode, csvCache);

      const homeForm = homeCsv
        ? formFromCsv(homeCsv)
        : homeTeam ? await formCached(homeTeam.id, formCache) : null;
      const awayForm = awayCsv
        ? formFromCsv(awayCsv)
        : awayTeam ? await formCached(awayTeam.id, formCache) : null;

      const h2h = homeTeam && awayTeam
        ? await h2hCached(homeTeam.id, awayTeam.id, h2hCache)
        : null;

      // Parity from bookmaker 1X2 probabilities: |P(home) − P(away)|
      const gap = Math.abs(c.homeProb - c.awayProb);

      const score = scoreDraw(
        pick.probability,
        pick.tournament,
        homeForm,
        awayForm,
        { rank: Math.round(gap * 20) }, // approximate rank gap for parity weighting
        null,
        h2h
      );

      // Store the model score on the pick for transparency
      pick.safetyScore = score.adjustedProbability;
      pick.probability = score.adjustedProbability;
      enriched.push(pick);
    } catch (e) {
      console.error("Draw enrich failed for", pick.homeTeam, "vs", pick.awayTeam, e);
      enriched.push(pick); // fall back to bookmaker-only pick
    }
  }

  // If enrichment failed entirely, fall back to raw candidates
  const ranked = enriched.length > 0 ? enriched : candidates.map(c => c.pick);

  // Sort by model-adjusted draw probability
  ranked.sort((a, b) => b.safetyScore - a.safetyScore);

  const slip = buildDrawSlip(ranked);
  if (!slip) return null;

  try {
    const code = await createBookCode(slip.map(toSportySelection));
    const actualOdds = Math.round(slip.reduce((p, s) => p * s.odds, 1) * 100) / 100;
    return { targetOdds: DRAW_TARGET, actualOdds, code, picks: slip };
  } catch (e) {
    console.error("Failed to create draw code:", e);
    return null;
  }
}

// ── Team lookup helpers (cached) ───────────────────────────────────

async function findTeamCached(
  name: string,
  countryHint: string,
  cache: Map<string, { team: ApiTeam | null }>
): Promise<ApiTeam | null> {
  const key = `${name}||${countryHint}`;
  if (cache.has(key)) return cache.get(key)!.team;
  const team = await findTeam(name, countryHint);
  cache.set(key, { team });
  return team;
}

async function formCached(
  teamId: number,
  cache: Map<number, TeamForm | null>
): Promise<TeamForm | null> {
  if (cache.has(teamId)) return cache.get(teamId)!;
  const form = await getTeamForm(teamId);
  cache.set(teamId, form);
  return form;
}

async function h2hCached(
  homeId: number,
  awayId: number,
  cache: Map<string, number | null>
): Promise<number | null> {
  const key = `${homeId}:${awayId}`;
  if (cache.has(key)) return cache.get(key)!;
  const rate = await getH2HDrawRate(homeId, awayId);
  cache.set(key, rate);
  return rate;
}

// Convert CSV team stats into the TeamForm shape the draw model expects.
function formFromCsv(s: CsvTeamStats): TeamForm {
  return {
    drawRate: s.drawRate,
    goalsFor: s.gfAvg,
    goalsAgainst: s.gaAvg,
    homeDrawRate: s.homeDrawRate,
    awayDrawRate: s.awayDrawRate,
    avgDrift: s.avgDrift,
    sampleSize: s.matches,
  };
}

// CSV stats lookup with an in-run cache (one DB query per unique team).
async function csvCached(
  teamName: string,
  leagueCode: string | null,
  cache: Map<string, CsvTeamStats | null>
): Promise<CsvTeamStats | null> {
  if (!leagueCode) return null;
  const key = `${leagueCode}||${teamName}`;
  if (cache.has(key)) return cache.get(key)!;
  const stats = await getCsvTeamStats(teamName, leagueCode);
  cache.set(key, stats);
  return stats;
}
