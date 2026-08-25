// ─────────────────────────────────────────────────────────────────────
// FOOTBALL-DATA.CO.UK — recent-season CSV ingestion + team statistics.
//
// The draw model's form/goals signals were previously frozen on the
// API-Football free plan's most recent allowed season (2024), which is two
// seasons stale. Football-Data.co.uk publishes full-season CSVs with results
// AND bookmaker odds (opening + closing) for every completed match — no API
// key, no rate limit. This module:
//
//   1. Downloads + parses the CSVs for the last two available seasons.
//   2. Stores raw completed matches in the `football_matches` table.
//   3. Computes per-team statistics (draw rate, goals, home/away split,
//      draw-odds drift) over a rolling recent-match window at lookup time.
//
// Storing raw matches (rather than per-season aggregates) means the "form"
// signal is correct even at season start: early in a new season the window
// naturally blends last season's completed matches with the handful already
// played this season, instead of collapsing to a 1–2 match sample.
//
// Note on "odds drift" (#8): the CSV only contains *completed* matches, so we
// cannot read the drift of a live upcoming match. What we CAN derive is a
// per-team draw-odds drift tendency (does this team's draw price tend to
// shorten or lengthen between opening and closing odds). That is the
// `avgDrift` in the returned stats — a real but deliberately lightly-weighted
// signal.
// ─────────────────────────────────────────────────────────────────────

import { query } from "./db";

// Seasons to try, newest first. We load the newest two that exist so the
// rolling form window stays full across a season boundary.
const SEASON_CANDIDATES = ["2627", "2526", "2425"];
const MAX_SEASONS = 2;
const BASE_URL = "https://www.football-data.co.uk/mmz4281";

// ── League catalogue ────────────────────────────────────────────────
// code: football-data.co.uk folder/file code.
// country: SportyBet category name (lowercased) used to disambiguate.
// tournament: substring(s) matched against SportyBet tournament name.
interface LeagueDef {
  code: string;
  country: string;
  tournament: string[];
}

export const FOOTBALL_LEAGUES: LeagueDef[] = [
  { code: "E0", country: "england", tournament: ["premier league"] },
  { code: "E1", country: "england", tournament: ["championship"] },
  { code: "E2", country: "england", tournament: ["league one"] },
  { code: "E3", country: "england", tournament: ["league two"] },
  { code: "SC0", country: "scotland", tournament: ["premiership"] },
  { code: "D1", country: "germany", tournament: ["bundesliga"] },
  { code: "D2", country: "germany", tournament: ["bundesliga"] },
  { code: "I1", country: "italy", tournament: ["serie a"] },
  { code: "I2", country: "italy", tournament: ["serie b"] },
  { code: "SP1", country: "spain", tournament: ["la liga", "laliga", "primera division"] },
  { code: "SP2", country: "spain", tournament: ["segunda", "hypermotion"] },
  { code: "F1", country: "france", tournament: ["ligue 1"] },
  { code: "F2", country: "france", tournament: ["ligue 2"] },
  { code: "N1", country: "netherlands", tournament: ["eredivisie"] },
  { code: "P1", country: "portugal", tournament: ["primeira liga"] },
  { code: "B1", country: "belgium", tournament: ["pro league", "jupiler"] },
  { code: "T1", country: "turkey", tournament: ["super lig"] },
  { code: "G1", country: "greece", tournament: ["super league"] },
];

function leagueCodeFor(tournament: string, country: string): string | null {
  const n = tournament.toLowerCase();
  const c = (country || "").toLowerCase();
  for (const l of FOOTBALL_LEAGUES) {
    if (l.country !== c) continue;
    for (const t of l.tournament) {
      if (n.includes(t)) {
        // Disambiguate top flight vs second tier / women / reserves.
        if (l.code === "D1" && (n.startsWith("2.") || n.includes("2. bundesliga"))) continue;
        if (l.code === "D2" && !(n.startsWith("2.") || n.includes("2. bundesliga"))) continue;
        if (l.code === "SP1" && (n.includes("hypermotion") || n.includes("segunda"))) continue;
        if (l.code === "SP2" && !(n.includes("hypermotion") || n.includes("segunda"))) continue;
        if (l.code === "I2" && !n.includes("serie b")) continue;
        if (l.code === "I1" && n.includes("serie b")) continue;
        if (l.code === "F2" && !n.includes("ligue 2")) continue;
        if (l.code === "F1" && n.includes("ligue 2")) continue;
        if (l.code === "E0" && (n.includes("women") || n.includes("reserve") || n.includes("youth"))) continue;
        if (l.code === "I1" && n.includes("women")) continue;
        return l.code;
      }
    }
  }
  return null;
}

// ── Name normalisation + matching ───────────────────────────────────

const STOPWORDS = new Set([
  "fc", "cf", "afc", "ac", "as", "cd", "sc", "sp", "sv", "sk", "fk", "rc", "if", "ff", "de", "la", "el", "di", "da", "do", "von", "van", "club", "the", "and",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function norm(s: string): string {
  return tokens(s).join("");
}

// Curated alias map: SportyBet full name → CSV short name (normalized key).
// Only the genuinely ambiguous cases need entries; the fuzzy matcher covers
// the rest (e.g. "Tottenham Hotspur" → "Tottenham" via first-token match).
const ALIASES: Record<string, string> = {
  manchesterunited: "manunited",
  manutd: "manunited",
  mancity: "mancity",
  manchestercity: "mancity",
  wolverhampton: "wolves",
  wolverhamptonwanderers: "wolves",
  nottinghamforest: "nottmforest",
  nottsforest: "nottmforest",
  brightonhovealbion: "brighton",
  sheffieldwednesday: "sheffwed",
  sheffwednesday: "sheffwed",
  sheffieldunited: "sheffutd",
  sheffunited: "sheffutd",
  queensparkrangers: "qpr",
  newcastleunited: "newcastle",
  leicestercity: "leicester",
  leedscity: "leeds",
  norwichcity: "norwich",
  intermilan: "inter",
  acmilan: "milan",
  asroma: "roma",
  bayern: "bayernmunich",
  bayerleverkusen: "leverkusen",
  psvEindhoven: "psv",
  sportingcp: "sporting",
  sportinglisbon: "sporting",
  fcporto: "porto",
  asmonaco: "monaco",
  olympiquelyonnais: "lyon",
  olympiquedemarseille: "marseille",
  parissaintgermain: "psg",
  atletico: "atleticomadrid",
  realbetis: "betis",
};

function resolveAlias(normName: string): string | null {
  return ALIASES[normName] ?? null;
}

/**
 * Match a SportyBet team name against a small set of candidate team names
 * (one league's teams). Returns the best candidate name, or null if no
 * confident match.
 */
export function matchTeamName(name: string, candidates: string[]): string | null {
  const n = norm(name);
  if (!n) return null;
  const alias = resolveAlias(n);

  let best: string | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    const cn = norm(c);
    if (!cn) continue;
    let score = 0;

    if (cn === n || (alias && cn === norm(alias))) score = 1.0;
    else if (cn === alias) score = 1.0;
    else {
      // token overlap (Jaccard-ish) weighted toward the more distinctive tokens
      const a = tokens(name);
      const b = tokens(c);
      let inter = 0;
      for (const t of a) if (b.includes(t)) inter++;
      const union = a.concat(b).filter((t, i, arr) => arr.indexOf(t) === i).length;
      const jaccard = union ? inter / union : 0;

      // first-token match is a strong signal (SportyBet "Tottenham Hotspur"
      // vs CSV "Tottenham")
      const firstMatch = a.length && b.length && a[0] === b[0] ? 0.5 : 0;

      // substring either direction
      const sub = cn.includes(n) || n.includes(cn) ? 0.4 : 0;

      score = Math.max(jaccard * 0.9, firstMatch + jaccard * 0.4, sub);
    }

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  if (!best || bestScore < 0.55) return null;
  return best;
}

// ── CSV parsing ─────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): Array<Record<string, string>> {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j] ?? "";
    rows.push(row);
  }
  return rows;
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === null || s === "") return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function driftForRow(row: Record<string, string>): { open: number | null; close: number | null } {
  // Prefer the market-average (AvgD/AvgCD), then Pinnacle, then Bet365.
  const open = num(row["AvgD"]) ?? num(row["PSD"]) ?? num(row["B365D"]);
  const close = num(row["AvgCD"]) ?? num(row["PSCD"]) ?? num(row["B365CD"]);
  return { open, close };
}

async function fetchCsv(code: string, season: string): Promise<Array<Record<string, string>> | null> {
  const url = `${BASE_URL}/${season}/${code}.csv`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (CuxmTier data refresh)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    // A redirect to the 300 "Multiple Choices" page comes back as HTML.
    if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) return null;
    return parseCsv(text);
  } catch {
    return null;
  }
}

// ── Loader ──────────────────────────────────────────────────────────

export interface RefreshResult {
  seasons: string[];
  leagues: Array<{ code: string; matches: number }>;
  totalMatches: number;
}

function parseDate(s: string): string | null {
  // football-data.co.uk dates are DD/MM/YYYY.
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

interface MatchTuple {
  date: string;
  home: string;
  away: string;
  fthg: number;
  ftag: number;
  ftr: string;
  open: number | null;
  close: number | null;
}

// Batch-insert a league's matches in chunks to avoid one round-trip per row.
async function insertMatches(league: string, season: string, rows: MatchTuple[]): Promise<number> {
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: (string | number | null)[] = [];
    let p = 1;
    for (const r of chunk) {
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(league, season, r.date, r.home, r.away, r.fthg, r.ftag, r.ftr, r.open, r.close);
    }
    await query(
      `INSERT INTO football_matches
         (league, season, match_date, home, away, fthg, ftag, ftr, open_draw, close_draw)
       VALUES ${values.join(",")}
       ON CONFLICT (league, season, home, away, match_date) DO NOTHING`,
      params
    );
  }
  return rows.length;
}

/** Download + store raw matches for the newest available seasons. */
export async function refreshFootballData(): Promise<RefreshResult> {
  // Determine which seasons exist (probe E0, which always exists).
  const available: string[] = [];
  for (const s of SEASON_CANDIDATES) {
    const probe = await fetchCsv("E0", s);
    if (probe && probe.length > 0) available.push(s);
    if (available.length >= MAX_SEASONS) break;
  }
  if (available.length === 0) return { seasons: [], leagues: [], totalMatches: 0 };

  // Fetch every league × season in parallel (network-bound), parse to tuples.
  const fetched: Array<{ league: string; season: string; rows: MatchTuple[] }> = [];
  await Promise.all(
    FOOTBALL_LEAGUES.map(async (league) => {
      for (const season of available) {
        const csv = await fetchCsv(league.code, season);
        if (!csv || csv.length === 0) continue;
        const rows: MatchTuple[] = [];
        for (const row of csv) {
          const ftr = (row["FTR"] || "").trim().toUpperCase();
          const fthg = num(row["FTHG"]);
          const ftag = num(row["FTAG"]);
          if (ftr !== "H" && ftr !== "D" && ftr !== "A") continue;
          if (fthg === null || ftag === null) continue;
          const home = row["HomeTeam"]?.trim();
          const away = row["AwayTeam"]?.trim();
          const date = parseDate(row["Date"] || "");
          if (!home || !away || !date) continue;
          const { open, close } = driftForRow(row);
          rows.push({ date, home, away, fthg, ftag, ftr, open, close });
        }
        if (rows.length > 0) fetched.push({ league: league.code, season, rows });
      }
    })
  );

  // Batch-insert sequentially (the pg pool caps concurrent connections).
  const result: RefreshResult = { seasons: available, leagues: [], totalMatches: 0 };
  const leagueTotals = new Map<string, number>();
  for (const f of fetched) {
    await insertMatches(f.league, f.season, f.rows);
    leagueTotals.set(f.league, (leagueTotals.get(f.league) ?? 0) + f.rows.length);
    result.totalMatches += f.rows.length;
  }
  for (const [code, matches] of Array.from(leagueTotals.entries())) result.leagues.push({ code, matches });

  return result;
}

// ── Lookup ──────────────────────────────────────────────────────────

export interface CsvTeamStats {
  teamName: string;
  league: string;
  matches: number;
  drawRate: number;
  homeDrawRate: number;
  awayDrawRate: number;
  gfAvg: number;
  gaAvg: number;
  homeGfAvg: number;
  homeGaAvg: number;
  awayGfAvg: number;
  awayGaAvg: number;
  avgDrift: number | null; // closing − opening draw odds (negative = price shortened)
}

interface MatchRow {
  match_date: string;
  home: string;
  away: string;
  fthg: number | null;
  ftag: number | null;
  ftr: string | null;
  open_draw: number | null;
  close_draw: number | null;
}

// How many recent matches to include in the rolling form window.
const FORM_WINDOW = 20;

/**
 * Resolve a SportyBet team name to its CSV-derived statistics for a league,
 * computed over the most recent completed matches (rolling across seasons).
 * Returns null when the league isn't in the catalogue or the team can't be
 * matched (caller should fall back to API-Football).
 */
export async function getCsvTeamStats(teamName: string, leagueCode: string): Promise<CsvTeamStats | null> {
  if (!leagueCode) return null;
  try {
    // Distinct team names in this league (across loaded seasons) for matching.
    const teamsQ = await query<{ team: string }>(
      `SELECT home AS team FROM football_matches WHERE league = $1
       UNION SELECT away AS team FROM football_matches WHERE league = $1`,
      [leagueCode]
    );
    const candidates = teamsQ.rows.map((r) => r.team);
    const matched = matchTeamName(teamName, candidates);
    if (!matched) return null;

    const q = await query<MatchRow>(
      `SELECT match_date, home, away, fthg, ftag, ftr, open_draw, close_draw
         FROM football_matches
        WHERE league = $1 AND (home = $2 OR away = $2)
        ORDER BY match_date DESC
        LIMIT $3`,
      [leagueCode, matched, FORM_WINDOW]
    );
    if (q.rows.length === 0) return null;

    let matches = 0, draws = 0;
    let homeMatches = 0, homeDraws = 0, awayMatches = 0, awayDraws = 0;
    let gf = 0, ga = 0, homeGf = 0, homeGa = 0, awayGf = 0, awayGa = 0;
    let openSum = 0, openN = 0, closeSum = 0, closeN = 0, driftSum = 0, driftN = 0;

    for (const r of q.rows) {
      const hg = r.fthg, ag = r.ftag;
      if (hg === null || ag === null) continue;
      const isHome = r.home === matched;
      const drew = hg === ag;

      matches++;
      if (drew) draws++;
      if (isHome) {
        homeMatches++;
        if (drew) homeDraws++;
        homeGf += hg; homeGa += ag; gf += hg; ga += ag;
      } else {
        awayMatches++;
        if (drew) awayDraws++;
        awayGf += ag; awayGa += hg; gf += ag; ga += hg;
      }
      if (r.open_draw !== null) { openSum += r.open_draw; openN++; }
      if (r.close_draw !== null) { closeSum += r.close_draw; closeN++; }
      if (r.open_draw !== null && r.close_draw !== null) { driftSum += r.close_draw - r.open_draw; driftN++; }
    }

    if (matches === 0) return null;

    return {
      teamName: matched,
      league: leagueCode,
      matches,
      drawRate: draws / matches,
      homeDrawRate: homeMatches ? homeDraws / homeMatches : draws / matches,
      awayDrawRate: awayMatches ? awayDraws / awayMatches : draws / matches,
      gfAvg: gf / matches,
      gaAvg: ga / matches,
      homeGfAvg: homeMatches ? homeGf / homeMatches : 0,
      homeGaAvg: homeMatches ? homeGa / homeMatches : 0,
      awayGfAvg: awayMatches ? awayGf / awayMatches : 0,
      awayGaAvg: awayMatches ? awayGa / awayMatches : 0,
      avgDrift: driftN ? driftSum / driftN : null,
    };
  } catch {
    return null;
  }
}

export { leagueCodeFor };
