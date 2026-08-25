// ─────────────────────────────────────────────────────────────────────
// ALTER — auto-swap every leg of a ticket to its best option.
//
// For each selection in a SportyBet ticket we fetch the event's FULL market
// list (the share API only returns the selected outcome), enumerate every
// alternative outcome across the "Main" markets, score each by "highest win
// probability + edge", and swap the pick when a clearly-better option exists.
//
// Win probability is history-informed: for football 1X2 / double-chance
// markets we use the Football-Data.co.uk match history (team form, home/away
// split, goals, draw model) to adjust the bookmaker's implied probability.
// Everything else falls back to the historical priors table, then raw odds.
//
// Guards:
//   • Only "Main" markets are considered (1X2, double chance, O/U, BTTS,
//     handicaps, DNB — not corners/cards/minute novelty markets).
//   • Minimum odds floor so we never collapse the slip into near-certainty
//     bets like "Over 0.5 @ 1.05".
//   • A swap requires the alternative to beat the current pick by at least
//     MIN_IMPROVEMENT on the composite score.
// ─────────────────────────────────────────────────────────────────────

import { SportyOutcome, SportySelection, createBookCode, fetchBookCode, fetchEventDetail } from "./sportybet";
import { scoreDraw } from "./drawModel";
import type { TeamForm } from "./drawModel";
import { getCsvTeamStats, leagueCodeFor, type CsvTeamStats } from "./footballData";
import { findPrior, blendProbability } from "./priors";

// Only consider alternatives with these odds or higher (skips near-certainty).
const MIN_ODDS = 1.2;
// How much better (on the composite score) the alternative must be to swap.
const MIN_IMPROVEMENT = 0.03;

// Clean, well-understood markets we're willing to alter INTO. Excludes novelty
// markets ("Goal Bounds", "Excluded Number of Goals", "score 2 in a row",
// correct score, corners, cards…) and 1X2 variants ("1X2 - 1UP", "Never Down").
function isCleanMarket(desc: string): boolean {
  const d = desc.toLowerCase().trim();
  return (
    d === "1x2" ||
    d === "double chance" ||
    d === "over/under" ||
    d === "both teams to score" ||
    d === "draw no bet"
  );
}

// Composite score = win probability (primary) + a capped edge bonus.
function alterScore(winProb: number, evPercent: number): number {
  const edgeBonus = Math.max(-20, Math.min(40, evPercent)) / 400; // -0.05 .. +0.10
  return winProb + edgeBonus;
}

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

// ── History-informed 1X2 probabilities for a football event ──────────

interface OneX2Probs {
  homeWin: number;
  draw: number;
  awayWin: number;
}

async function computeOneX2(event: SportyOutcome): Promise<OneX2Probs | null> {
  if (event.sport.id !== "sr:sport:1") return null;

  const oneX2 = event.markets.find((m) => m.desc.toLowerCase() === "1x2");
  if (!oneX2) return null;

  let homeB = 0, drawB = 0, awayB = 0;
  for (const o of oneX2.outcomes) {
    const d = o.desc.toLowerCase();
    const p = parseFloat(o.probability || "0");
    if (d === "home" || d === "1") homeB = p;
    else if (d === "away" || d === "2") awayB = p;
    else if (d === "draw" || d === "x") drawB = p;
  }
  if (!homeB || !drawB || !awayB) return null;

  const tournament = event.sport.category.tournament.name;
  const country = event.sport.category.name;
  const code = leagueCodeFor(tournament, country);

  const homeStats = code ? await getCsvTeamStats(event.homeTeamName, code) : null;
  const awayStats = code ? await getCsvTeamStats(event.awayTeamName, code) : null;

  const drawScore = scoreDraw(
    drawB,
    tournament,
    homeStats ? formFromCsv(homeStats) : null,
    awayStats ? formFromCsv(awayStats) : null,
    null,
    null,
    null
  );
  const modelDraw = drawScore.adjustedProbability;

  const ratio = homeB / (homeB + awayB);
  const modelHome = (1 - modelDraw) * ratio;
  const modelAway = (1 - modelDraw) * (1 - ratio);

  return { homeWin: modelHome, draw: modelDraw, awayWin: modelAway };
}

function outcomeWinProb(
  probs: OneX2Probs | null,
  marketDesc: string,
  pickDesc: string,
  tournament: string,
  specifier: string | undefined,
  bookmakerProb: number
): number {
  const md = marketDesc.toLowerCase();
  const d = pickDesc.toLowerCase();

  if (probs) {
    if (md === "1x2") {
      if (d === "home" || d === "1") return probs.homeWin;
      if (d === "away" || d === "2") return probs.awayWin;
      if (d === "draw" || d === "x") return probs.draw;
    }
    if (md.includes("double chance")) {
      const hasHome = d.includes("home");
      const hasAway = d.includes("away");
      const hasDraw = d.includes("draw");
      if (hasHome && hasDraw) return probs.homeWin + probs.draw;
      if (hasAway && hasDraw) return probs.awayWin + probs.draw;
      if (hasHome && hasAway) return probs.homeWin + probs.awayWin;
    }
  }

  const prior = findPrior(tournament, marketDesc, specifier);
  return prior ? blendProbability(bookmakerProb, prior) : bookmakerProb;
}

// ── Public types ─────────────────────────────────────────────────────

export interface AlteredPickInfo {
  marketDesc: string;
  pickDesc: string;
  odds: number;
  probability: number;
  winProb: number;
  evPercent: number;
}

export interface AlteredLeg {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  tournament: string;
  category: string;
  sportId: string;
  changed: boolean;
  original: AlteredPickInfo;
  altered: AlteredPickInfo | null;
  reason: string;
}

export interface AlterResult {
  originalCode: string;
  newCode: string;
  totalOriginalOdds: number;
  totalNewOdds: number;
  changedCount: number;
  legs: AlteredLeg[];
}

interface ScoredAlt {
  marketId: string;
  outcomeId: string;
  specifier?: string;
  productId: number;
  marketDesc: string;
  pickDesc: string;
  odds: number;
  bookmakerProb: number;
  winProb: number;
  evPercent: number;
  score: number;
}

// ── Main ─────────────────────────────────────────────────────────────

export async function alterTicket(code: string): Promise<AlterResult> {
  const ticket = await fetchBookCode(code);
  const selections = ticket.ticket.selections;

  // Fetch full event details (parallel) — the share API only has selected picks.
  const eventIds = Array.from(new Set(selections.map((s) => s.eventId)));
  const events = await Promise.all(eventIds.map((id) => fetchEventDetail(id)));
  const eventMap = new Map<string, SportyOutcome | null>();
  eventIds.forEach((id, i) => eventMap.set(id, events[i]));

  const legs: AlteredLeg[] = [];
  const newSelections: SportySelection[] = [];

  for (const sel of selections) {
    const event = eventMap.get(sel.eventId) ?? null;
    if (!event || !event.markets || event.markets.length === 0) {
      newSelections.push(sel);
      continue;
    }

    const tournament = event.sport.category.tournament.name;
    const probs = await computeOneX2(event);

    // Resolve the original pick's odds, then cap how far we're allowed to drop.
    // An altered leg must not fall below 50% of its original odds (so a Draw @
    // 3.1 can go down to ~1.55 but never collapse to a 1.2 near-certainty).
    let originalOdds = 0;
    for (const market of event.markets) {
      if (market.id === sel.marketId) {
        const o = market.outcomes.find((x) => x.id === sel.outcomeId);
        if (o) originalOdds = parseFloat(o.odds) || 0;
        break;
      }
    }
    const minOdds = Math.max(MIN_ODDS, originalOdds > 0 ? originalOdds * 0.5 : 0);

    // Score every outcome in the clean markets, above the odds floor.
    const scored: ScoredAlt[] = [];
    for (const market of event.markets) {
      if (!isCleanMarket(market.desc)) continue;
      for (const outcome of market.outcomes) {
        const odds = parseFloat(outcome.odds);
        if (!Number.isFinite(odds) || odds < minOdds) continue;
        const bookmakerProb = parseFloat(outcome.probability || "0") || (odds > 0 ? 1 / odds : 0);
        const winProb = outcomeWinProb(probs, market.desc, outcome.desc, tournament, market.specifier, bookmakerProb);
        const evPercent = Math.round((odds * winProb - 1) * 100);
        scored.push({
          marketId: market.id,
          outcomeId: outcome.id,
          specifier: market.specifier,
          productId: market.product,
          marketDesc: market.desc,
          pickDesc: outcome.desc,
          odds,
          bookmakerProb,
          winProb,
          evPercent,
          score: alterScore(winProb, evPercent),
        });
      }
    }

    const current = scored.find((s) => s.marketId === sel.marketId && s.outcomeId === sel.outcomeId);
    let best = current;
    for (const s of scored) {
      if (!best || s.score > best.score) best = s;
    }

    const originalInfo: AlteredPickInfo = current
      ? {
          marketDesc: current.marketDesc, pickDesc: current.pickDesc, odds: current.odds,
          probability: current.bookmakerProb, winProb: current.winProb, evPercent: current.evPercent,
        }
      : { marketDesc: "?", pickDesc: "?", odds: 0, probability: 0, winProb: 0, evPercent: 0 };

    const changed = !!current && !!best && best.outcomeId !== current.outcomeId && best.score - current.score >= MIN_IMPROVEMENT;

    let alteredInfo: AlteredPickInfo | null = null;
    let reason = "";
    if (changed && best) {
      alteredInfo = {
        marketDesc: best.marketDesc, pickDesc: best.pickDesc, odds: best.odds,
        probability: best.bookmakerProb, winProb: best.winProb, evPercent: best.evPercent,
      };
      reason = `Swapped "${current!.pickDesc}" → "${best.pickDesc}": win prob ${Math.round(current!.winProb * 100)}% → ${Math.round(best.winProb * 100)}%, EV ${current!.evPercent}% → ${best.evPercent}%`;
      newSelections.push({
        eventId: sel.eventId, marketId: best.marketId, specifier: best.specifier,
        outcomeId: best.outcomeId, productId: best.productId, sportId: sel.sportId,
      });
    } else {
      if (!current) reason = "Original pick not in Main markets — kept as-is.";
      else if (!best || best.outcomeId === current.outcomeId) reason = `Kept "${current.pickDesc}" — already the best option.`;
      else reason = `Kept "${current.pickDesc}" — best alternative "${best.pickDesc}" not clearly better.`;
      newSelections.push(sel);
    }

    legs.push({
      eventId: sel.eventId,
      homeTeam: event.homeTeamName,
      awayTeam: event.awayTeamName,
      tournament,
      category: event.sport.category.name,
      sportId: event.sport.id,
      changed,
      original: originalInfo,
      altered: alteredInfo,
      reason,
    });
  }

  const newCode = await createBookCode(newSelections);

  const totalOriginalOdds = Math.round(legs.reduce((p, l) => p * (l.original.odds || 1), 1) * 100) / 100;
  const totalNewOdds = Math.round(legs.reduce((p, l) => p * (l.changed && l.altered ? l.altered.odds : l.original.odds || 1), 1) * 100) / 100;

  return {
    originalCode: code,
    newCode,
    totalOriginalOdds,
    totalNewOdds,
    changedCount: legs.filter((l) => l.changed).length,
    legs,
  };
}
