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
//   • Only clean markets are considered (1X2, double chance, O/U, GG/NG [BTTS],
//     DNB, handicap, odd/even + their 1st/2nd-half variants — not corners/cards/
//     minute/player novelty markets, and not 1X2 variants like "1UP"/"Never Down").
//   • Directional odds floor: favorites/moderate dogs keep a 50%-of-original floor
//     so the slip doesn't collapse; true longshots (>=5.0) drop to the MIN_ODDS
//     floor so they can reach safe alternatives instead of other longshots.
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

// Clean, well-understood markets we're willing to alter INTO, per sport.
// Excludes novelty markets ("Goal Bounds", correct score, corners, cards,
// "score 2 in a row"…) and 1X2 variants ("1X2 - 1UP", "Never Down").
function isCleanMarket(sportId: string, desc: string): boolean {
  const d = desc.toLowerCase().trim();
  if (sportId === "sr:sport:1") {
    // Football. Exact-match the core markets so the variants stay out
    // ("1X2 - 1UP", "GG/NG 2+", "Over/Under - Early Goals", "Double Chance - 1UP").
    const exact = new Set([
      "1x2",
      "double chance",
      "over/under",
      "gg/ng", // = Both Teams to Score (SportyBet's real label — NOT "Both Teams to Score")
      "draw no bet",
      "odd/even",
      // Half markets — scored with raw bookmaker prob, never the full-match model.
      "1st half - 1x2",
      "1st half - double chance",
      "1st half - over/under",
      "1st half - gg/ng",
      "1st half - draw no bet",
      "2nd half - 1x2",
      "2nd half - double chance",
      "2nd half - over/under",
      "2nd half - gg/ng",
      "2nd half - draw no bet",
    ]);
    if (exact.has(d)) return true;
    // European handicap ("Handicap 0:1", "Handicap 0:2", "Handicap 1:0"…) and
    // Asian handicap ("Asian Handicap -1.5", "Asian Handicap +0.5"…).
    if (/^handicap \d+:\d+$/.test(d)) return true;
    if (d.startsWith("asian handicap")) return true;
    return false;
  }
  if (sportId === "sr:sport:5") {
    // Tennis — match winner, "X to win a set", games totals/spread
    return d === "winner" || d.includes("to win a set") || d.includes("over/under") || d.includes("handicap");
  }
  if (sportId === "sr:sport:2") {
    // Basketball
    return d === "winner" || d.includes("money line") || d.includes("over/under") || d.includes("handicap");
  }
  // Generic fallback (other sports) — match result + totals only
  return d === "winner" || d === "money line" || d.includes("over/under");
}

// Composite score = win probability (primary) + a capped edge bonus.
function alterScore(winProb: number, evPercent: number): number {
  const edgeBonus = Math.max(-20, Math.min(40, evPercent)) / 400; // -0.05 .. +0.10
  return winProb + edgeBonus;
}

// SportyBet REUSES outcome ids across markets and specifiers — "Under 1",
// "Under 2.5" and "Under 4.5" are ALL outcome id "13" (likewise "Over"=12,
// "Home"=1, "Away"=3 …). Two picks are only "the same" when marketId +
// specifier + outcomeId all match. Comparing outcomeId alone wrongly treats
// "Under 1" and "Under 2.5" as identical and blocks a legitimate swap.
function samePick(
  a: { marketId: string; specifier?: string; outcomeId: string },
  b: { marketId: string; specifier?: string; outcomeId: string }
): boolean {
  return (
    a.marketId === b.marketId &&
    (a.specifier || undefined) === (b.specifier || undefined) &&
    a.outcomeId === b.outcomeId
  );
}

// A bare pick label ("Over 0.5", "No", "3") is meaningless without its market —
// full-match "Over/Under: Over 0.5" (~95%) and "1st Half - Over/Under: Over 0.5"
// (~77%) are completely different bets. Qualify every pick with its market desc.
function pickLabel(p: { marketDesc: string; pickDesc: string }): string {
  return `${p.marketDesc}: ${p.pickDesc}`;
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
  // Half markets ("1st Half - …", "2nd Half - …") follow a different distribution
  // from the full match. Never apply the full-match 1X2/double-chance model or a
  // full-match prior to them — trust the bookmaker's own number.
  const isHalf = md.includes("1st half") || md.includes("2nd half");

  if (probs && !isHalf) {
    if (md === "1x2") {
      if (d === "home" || d === "1") return probs.homeWin;
      if (d === "away" || d === "2") return probs.awayWin;
      if (d === "draw" || d === "x") return probs.draw;
    }
    if (md === "double chance") {
      const hasHome = d.includes("home");
      const hasAway = d.includes("away");
      const hasDraw = d.includes("draw");
      if (hasHome && hasDraw) return probs.homeWin + probs.draw;
      if (hasAway && hasDraw) return probs.awayWin + probs.draw;
      if (hasHome && hasAway) return probs.homeWin + probs.awayWin;
    }
  }

  if (isHalf) return bookmakerProb;

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
    const sportId = event.sport.id;
    const probs = await computeOneX2(event);

    // Resolve the original pick across ALL markets (for accurate display, even
    // when it sits in a market we don't alter into).
    let origMarketDesc = "?", origPickDesc = "?", origOdds = 0, origSpecifier: string | undefined, origProductId = 0;
    for (const market of event.markets) {
      if (market.id !== sel.marketId) continue;
      origMarketDesc = market.desc;
      origSpecifier = market.specifier;
      origProductId = market.product;
      const o = market.outcomes.find((x) => x.id === sel.outcomeId);
      if (o) { origPickDesc = o.desc; origOdds = parseFloat(o.odds) || 0; }
      break;
    }
    // Directional odds floor:
    //   • Favorites & moderate dogs (odds < LONG_SHOT_ODDS): keep the 50% floor so
    //     the slip's value doesn't collapse (a Draw @ 3.1 → floor 1.55, never 1.2).
    //   • True longshots (odds >= LONG_SHOT_ODDS): the 50% floor strands the leg in
    //     longshot territory — a 9.9 pick → floor 4.95 can only reach OTHER longshots
    //     ("Under 1" → "Over 4.5"). Drop to MIN_ODDS so AlterMe can actually reach
    //     safe alternatives (Double Chance, Under 2.5, BTTS No …).
    const LONG_SHOT_ODDS = 5.0;
    const minOdds =
      origOdds > 0 && origOdds < LONG_SHOT_ODDS
        ? Math.max(MIN_ODDS, origOdds * 0.5)
        : MIN_ODDS;

    // Score every outcome in the clean markets for this sport, above the floor.
    const scored: ScoredAlt[] = [];
    for (const market of event.markets) {
      if (!isCleanMarket(sportId, market.desc)) continue;
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

    // The original pick — score it ourselves so it's always present for display,
    // even if its own market isn't in the clean list (e.g. an exotic market).
    let current = scored.find((s) => samePick(s, sel));
    if (!current && origOdds > 0) {
      const bookmakerProb = 1 / origOdds;
      const winProb = outcomeWinProb(probs, origMarketDesc, origPickDesc, tournament, origSpecifier, bookmakerProb);
      const evPercent = Math.round((origOdds * winProb - 1) * 100);
      current = {
        marketId: sel.marketId, outcomeId: sel.outcomeId, specifier: origSpecifier, productId: origProductId,
        marketDesc: origMarketDesc, pickDesc: origPickDesc, odds: origOdds, bookmakerProb, winProb, evPercent,
        score: alterScore(winProb, evPercent),
      };
    }

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

    const changed = !!current && !!best && !samePick(best, current) && best.score - current.score >= MIN_IMPROVEMENT;

    let alteredInfo: AlteredPickInfo | null = null;
    let reason = "";
    if (changed && best) {
      alteredInfo = {
        marketDesc: best.marketDesc, pickDesc: best.pickDesc, odds: best.odds,
        probability: best.bookmakerProb, winProb: best.winProb, evPercent: best.evPercent,
      };
      reason = `Swapped "${pickLabel(current!)}" → "${pickLabel(best)}": win prob ${Math.round(current!.winProb * 100)}% → ${Math.round(best.winProb * 100)}%, EV ${current!.evPercent}% → ${best.evPercent}%`;
      newSelections.push({
        eventId: sel.eventId, marketId: best.marketId, specifier: best.specifier,
        outcomeId: best.outcomeId, productId: best.productId, sportId: sel.sportId,
      });
    } else {
      if (!current) reason = "Original pick couldn't be resolved — kept as-is.";
      else if (!best || samePick(best, current)) reason = `Kept "${pickLabel(current)}" — already the best option.`;
      else reason = `Kept "${pickLabel(current)}" — best alternative "${pickLabel(best)}" not clearly better.`;
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
