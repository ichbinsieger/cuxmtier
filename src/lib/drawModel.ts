// ─────────────────────────────────────────────────────────────────────
// DRAW MODEL — predicts which matches are most likely to end in a draw.
//
// Data source: API-Football (API-Sports), free plan (100 req/day).
//
// Free-plan limits that shape this file (verified empirically):
//   • `last` parameter is BLOCKED → we fetch the full season and slice.
//   • current seasons (2025/2026) are BLOCKED → "team character" data
//     (form + goals) comes from the most recent allowed season (2024),
//     which is static and therefore cached ~forever.
//   • H2H (headtohead) is NOT season-limited → recent, live-relevant.
//   • Rate limit = 10 req/min → we throttle to stay under it.
//
// Signals combined in scoreDraw():
//   1. Bookmaker implied draw probability   (SportyBet — always fresh)
//   2. League draw-rate baseline            (hardcoded historical stats)
//   3. H2H draw history                     (API-Football — recent)
//   4. Team character — draw tendency       (API-Football 2024 season)
//   5. Team character — goals scored/conceded (API-Football 2024 season)
//   6. Parity — |P(home) − P(away)|          (from SportyBet 1X2)
//
// Everything API-Football is cached in Postgres so the 4-hourly tracker
// stays well under the 100 req/day budget after the first warm-up run.
// ─────────────────────────────────────────────────────────────────────

import { query } from "./db";

const API_BASE = "https://v3.football.api-sports.io";
const API_KEY = process.env.FOOTBALL_API_KEY;
// Most recent season the free plan exposes (2024-25 European season).
const DEFAULT_SEASON = 2024;

// How many fixtures to consider when computing "team character".
const FORM_SAMPLE = 15;
// How many H2H fixtures to consider when computing head-to-head draw rate.
const H2H_SAMPLE = 10;

// ── League draw-rate baselines ──────────────────────────────────────
// Historical share of matches ending level, used to anchor the model
// when team-level data is thin.
const LEAGUE_DRAW_RATES: Array<{ pattern: string; rate: number }> = [
  { pattern: "ligue 1", rate: 0.30 },
  { pattern: "serie a", rate: 0.28 },
  { pattern: "championship", rate: 0.27 },
  { pattern: "eredivisie", rate: 0.27 },
  { pattern: "primeira liga", rate: 0.27 },
  { pattern: "la liga", rate: 0.25 },
  { pattern: "laliga", rate: 0.25 },
  { pattern: "bundesliga", rate: 0.24 },
  { pattern: "premier league", rate: 0.24 },
  { pattern: "mls", rate: 0.25 },
  { pattern: "liga mx", rate: 0.26 },
  { pattern: "brasileir", rate: 0.26 },
  { pattern: "", rate: 0.26 },
];

export function leagueDrawRate(tournament: string): number {
  const n = tournament.toLowerCase();
  for (const l of LEAGUE_DRAW_RATES) {
    if (l.pattern && n.includes(l.pattern)) return l.rate;
  }
  return 0.26;
}

// ── API-Football client ─────────────────────────────────────────────

// Token-bucket throttle: max 10 requests per rolling 60s window.
const API_RATE_LIMIT = 10;
const API_RATE_WINDOW = 60_000;
const apiCallTimes: number[] = [];

async function throttle(): Promise<void> {
  const now = Date.now();
  while (apiCallTimes.length && now - apiCallTimes[0] > API_RATE_WINDOW) {
    apiCallTimes.shift();
  }
  if (apiCallTimes.length >= API_RATE_LIMIT) {
    const wait = apiCallTimes[0] + API_RATE_WINDOW - now + 250;
    await new Promise((r) => setTimeout(r, wait));
    return throttle();
  }
  apiCallTimes.push(Date.now());
}

async function apiGet<T>(path: string, timeoutMs = 10_000): Promise<T | null> {
  if (!API_KEY) return null;
  await throttle();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/${path}`, {
      headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { errors?: unknown; response?: T };
    // API-Sports returns errors as a non-empty object on failures.
    if (json.errors && typeof json.errors === "object" && Object.keys(json.errors).length > 0) {
      return null;
    }
    return (json.response as T) ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ── Persistent cache (Postgres) ─────────────────────────────────────
// Serverless is ephemeral, so the cache lives in Neon. Degrades to
// "no cache" if the DB is unreachable (e.g. local dev without a URL).

async function cacheGet<T>(key: string, ttlMs: number): Promise<T | null> {
  try {
    const q = await query<{ value: any; updated_at: string }>(
      `SELECT value, updated_at FROM football_cache WHERE cache_key = $1`,
      [key]
    );
    if (q.rows.length === 0) return null;
    const row = q.rows[0];
    if (Date.now() - new Date(row.updated_at).getTime() > ttlMs) return null;
    return row.value as T;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: any): Promise<void> {
  try {
    await query(
      `INSERT INTO football_cache (cache_key, value) VALUES ($1, $2)
       ON CONFLICT (cache_key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  } catch {
    // best-effort
  }
}

// ── Team identity ───────────────────────────────────────────────────

export interface ApiTeam {
  id: number;
  name: string;
  country: string;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function similarity(a: string, b: string): number {
  const na = norm(a), nb = norm(b);
  if (!na.length || !nb.length) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  return 0;
}

/**
 * Resolve a SportyBet team name to an API-Football team id.
 * Country hint is used to disambiguate (e.g. "Arsenal" England vs
 * "Arsenal Sarandi" Argentina), which fixes the TheSportsDB bug where
 * "Deportivo La Coruna" matched their B team.
 */
export async function findTeam(name: string, countryHint?: string): Promise<ApiTeam | null> {
  const key = `team:${norm(name)}:${norm(countryHint || "")}`;
  const cached = await cacheGet<ApiTeam>(key, 30 * 24 * 60 * 60 * 1000); // 30 days
  if (cached) return cached;

  const data = await apiGet<Array<{ team: ApiTeam }>>(`teams?search=${encodeURIComponent(name)}`);
  const teams = (data || []).map((e) => e.team);
  if (teams.length === 0) return null;

  let best = teams[0];
  let bestScore = -1;
  for (const t of teams.slice(0, 15)) {
    let s = similarity(t.name, name);
    // strong bonus for exact country match
    if (countryHint && norm(t.country) === norm(countryHint)) s += 0.5;
    // avoid B/reserve/youth teams unless the query itself asks for them
    if (/\b(u\d\d|reserve|res|ii|b|w)\b/i.test(t.name) && !/\b(u\d\d|reserve|res|ii|b|w)\b/i.test(name)) s -= 0.4;
    if (s > bestScore) { bestScore = s; best = t; }
  }
  if (bestScore < 0.4) return null;

  await cacheSet(key, best);
  return best;
}

// ── Team character (form + goals) ───────────────────────────────────

interface ApiFixture {
  fixture: { date: string; status: { short: string } };
  teams: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals: { home: number | null; away: number | null };
}

export interface TeamForm {
  drawRate: number;      // 0–1 share of sampled matches ending in draws
  goalsFor: number;      // avg goals scored per game
  goalsAgainst: number;  // avg goals conceded per game
  homeDrawRate: number | null; // draw rate in home matches (null if unknown)
  awayDrawRate: number | null; // draw rate in away matches (null if unknown)
  avgDrift: number | null;     // avg (closing − opening) draw odds; negative = sharp money on draw
  sampleSize: number;
}

export async function getTeamForm(teamId: number): Promise<TeamForm | null> {
  const key = `form:${teamId}:${DEFAULT_SEASON}`;
  // 2024 season is static → cache 60 days.
  const cached = await cacheGet<TeamForm>(key, 60 * 24 * 60 * 60 * 1000);
  if (cached) return cached;

  const data = await apiGet<ApiFixture[]>(`fixtures?team=${teamId}&season=${DEFAULT_SEASON}`);
  if (!data || data.length === 0) return null;

  const finished = data
    .filter((f) => f.fixture.status.short === "FT" && f.goals.home != null && f.goals.away != null)
    .sort((a, b) => b.fixture.date.localeCompare(a.fixture.date))
    .slice(0, FORM_SAMPLE);

  if (finished.length === 0) return null;

  let draws = 0, gf = 0, ga = 0;
  let homeMatches = 0, homeDraws = 0, awayMatches = 0, awayDraws = 0;
  for (const f of finished) {
    const hg = f.goals.home as number, ag = f.goals.away as number;
    const isHome = f.teams.home.id === teamId;
    if (isHome) { gf += hg; ga += ag; homeMatches++; if (hg === ag) homeDraws++; }
    else { gf += ag; ga += hg; awayMatches++; if (hg === ag) awayDraws++; }
    if (hg === ag) draws++;
  }

  const form: TeamForm = {
    drawRate: draws / finished.length,
    goalsFor: gf / finished.length,
    goalsAgainst: ga / finished.length,
    homeDrawRate: homeMatches ? homeDraws / homeMatches : null,
    awayDrawRate: awayMatches ? awayDraws / awayMatches : null,
    avgDrift: null, // API-Football has no opening/closing odds on free plan
    sampleSize: finished.length,
  };
  await cacheSet(key, form);
  return form;
}

// ── Head-to-head ────────────────────────────────────────────────────

/**
 * Historical draw rate between two specific teams. H2H is the single
 * strongest draw predictor and is NOT season-limited on the free plan,
 * so this reflects recent meetings.
 */
export async function getH2HDrawRate(homeId: number, awayId: number): Promise<number | null> {
  const key = `h2h:${homeId}:${awayId}`;
  // H2H only changes when the two teams meet again → cache 7 days.
  const cached = await cacheGet<number>(key, 7 * 24 * 60 * 60 * 1000);
  if (cached !== null) return cached;

  const data = await apiGet<ApiFixture[]>(`fixtures/headtohead?h2h=${homeId}-${awayId}`);
  if (!data || data.length === 0) return null;

  const finished = data
    .filter((f) => f.fixture.status.short === "FT" && f.goals.home != null && f.goals.away != null)
    .sort((a, b) => b.fixture.date.localeCompare(a.fixture.date))
    .slice(0, H2H_SAMPLE);

  if (finished.length === 0) return null;

  const draws = finished.filter((f) => f.goals.home === f.goals.away).length;
  const rate = draws / finished.length;
  await cacheSet(key, rate);
  return rate;
}

// ── Draw scoring ────────────────────────────────────────────────────

export interface DrawScore {
  adjustedProbability: number;  // 0–1, our model's draw probability
  bookmakerProbability: number; // 0–1
  edge: number;                 // adjusted − bookmaker (positive = underpriced)
  factors: {
    bookmaker: number;
    league: number;
    form: number;
    goals: number;
    parity: number;
    h2h: number | null;
    drift: number | null;
  };
  usedTeamData: boolean;
}

/**
 * Combine all signals into an adjusted draw probability.
 *
 * Weights (no H2H):  bookmaker 0.43, league 0.14, form 0.25, goals 0.10,
 *                    parity 0.05, drift 0.03
 * Weights (with H2H): bookmaker 0.38, league 0.09, form 0.15, goals 0.08,
 *                     parity 0.06, h2h 0.20, drift 0.04
 *
 * The "form" signal is venue-aware: the home team's *home* draw rate and the
 * away team's *away* draw rate are used when available (CSV home/away split),
 * falling back to each team's overall draw rate.
 */
export function scoreDraw(
  bookmakerProb: number,
  tournament: string,
  homeForm: TeamForm | null,
  awayForm: TeamForm | null,
  homeTable: { rank: number } | null,
  awayTable: { rank: number } | null,
  h2hDrawRate: number | null
): DrawScore {
  const league = leagueDrawRate(tournament);

  // Form signal: venue-aware average of both teams' draw rates, defaulting
  // to league rate. Prefers home team's home rate + away team's away rate.
  let formSignal = league;
  if (homeForm || awayForm) {
    const rates: number[] = [];
    if (homeForm) rates.push(homeForm.homeDrawRate ?? homeForm.drawRate);
    if (awayForm) rates.push(awayForm.awayDrawRate ?? awayForm.drawRate);
    if (rates.length) formSignal = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  // Goals signal: low-scoring matches draw more.
  let goalsSignal = league;
  if (homeForm && awayForm) {
    const combined = (homeForm.goalsFor + homeForm.goalsAgainst) / 2 + (awayForm.goalsFor + awayForm.goalsAgainst) / 2;
    goalsSignal = Math.max(0.18, Math.min(0.34, 0.42 - 0.055 * combined));
  }

  // Parity signal: teams close in the table draw more.
  let paritySignal = league;
  if (homeTable && awayTable) {
    const gap = Math.abs(homeTable.rank - awayTable.rank);
    paritySignal = Math.max(0.20, 0.30 - gap * 0.006);
  }

  // Drift signal (#8): a draw price that shortens from open→close (negative
  // drift) suggests sharp money on the draw. Map to a draw-probability nudge
  // around the league baseline. Lightly weighted — draws are priced
  // efficiently, so this is a marginal adjustment.
  let driftSignal: number | null = null;
  const drifts: number[] = [];
  if (homeForm?.avgDrift != null) drifts.push(homeForm.avgDrift);
  if (awayForm?.avgDrift != null) drifts.push(awayForm.avgDrift);
  if (drifts.length > 0) {
    const d = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    driftSignal = Math.max(0.15, Math.min(0.40, league + -d * 0.20));
  }

  const usedH2h = h2hDrawRate !== null && h2hDrawRate >= 0;
  const usedDrift = driftSignal !== null;

  let adjusted: number;
  if (usedH2h) {
    adjusted =
      0.38 * bookmakerProb +
      0.09 * league +
      0.15 * formSignal +
      0.08 * goalsSignal +
      0.06 * paritySignal +
      0.20 * h2hDrawRate! +
      (usedDrift ? 0.04 * driftSignal! : 0.04 * league);
  } else {
    adjusted =
      0.43 * bookmakerProb +
      0.14 * league +
      0.25 * formSignal +
      0.10 * goalsSignal +
      0.05 * paritySignal +
      (usedDrift ? 0.03 * driftSignal! : 0.03 * league);
  }

  // Don't let the model drift wildly from the market — clamp to ±0.12.
  const clamped = Math.max(
    bookmakerProb - 0.12,
    Math.min(bookmakerProb + 0.12, adjusted)
  );

  return {
    adjustedProbability: clamped,
    bookmakerProbability: bookmakerProb,
    edge: clamped - bookmakerProb,
    factors: {
      bookmaker: bookmakerProb,
      league,
      form: formSignal,
      goals: goalsSignal,
      parity: paritySignal,
      h2h: usedH2h ? h2hDrawRate : null,
      drift: usedDrift ? driftSignal : null,
    },
    usedTeamData: !!(homeForm || awayForm || usedH2h),
  };
}
