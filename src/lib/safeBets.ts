import { SportySelection } from "./sportybet";

// Pre-built catalog of safe bets from major upcoming matches.
// These are refreshed periodically. Each entry maps to a SportyBet selection.
// Format: { eventId, marketId, specifier?, outcomeId, desc }

interface SafeBetTemplate {
  eventId: string;
  marketId: string;
  specifier?: string;
  outcomeId: string;
  label: string; // e.g. "Man City vs Arsenal — Over 1.5"
  odds: number;
  tournament: string;
}

// Safe bets catalog — manually curated from current SportyBet offerings
// These are matches from major leagues with simple, high-probability markets
const SAFE_BETS: SafeBetTemplate[] = [
  // UEFA Europa League — Thursday Aug 6
  { eventId: "sr:match:73008852", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Hradec Kralove vs Besiktas — Over 1.5", odds: 1.12, tournament: "UEFA Europa League" },
  { eventId: "sr:match:73009106", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Salzburg vs Pafos — Over 1.5", odds: 1.10, tournament: "UEFA Europa League" },
  { eventId: "sr:match:73014456", marketId: "10", outcomeId: "10", label: "Benfica vs Hearts — Home or Away", odds: 1.08, tournament: "UEFA Europa League" },
  // UEFA Conference League
  { eventId: "sr:match:73011592", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Debrecen vs Copenhagen — Over 1.5", odds: 1.14, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011618", marketId: "10", outcomeId: "10", label: "Ajax vs Shelbourne — Home or Away", odds: 1.05, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011628", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Sheriff vs St. Gallen — Over 1.5", odds: 1.11, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011586", marketId: "10", outcomeId: "10", label: "Twente vs DAC 1904 — Home or Away", odds: 1.06, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011632", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Beitar Jerusalem vs Austria Wien — Over 1.5", odds: 1.10, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011582", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Zalgiris vs Hajduk Split — Over 1.5", odds: 1.13, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011616", marketId: "10", outcomeId: "10", label: "Rakow vs Hammarby — Home or Away", odds: 1.10, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011598", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Goteborg vs Gent — Over 1.5", odds: 1.12, tournament: "UEFA Conference League" },
  { eventId: "sr:match:73011626", marketId: "18", specifier: "total=1.5", outcomeId: "12", label: "Valur vs Nordsjaelland — Over 1.5", odds: 1.10, tournament: "UEFA Conference League" },
];

export function getSafeBets(count: number, excludeEventIds: string[] = []): SafeBetTemplate[] {
  const excludeSet = new Set(excludeEventIds);
  return SAFE_BETS
    .filter(b => !excludeSet.has(b.eventId))
    .slice(0, count);
}

export function safeBetToSelection(bet: SafeBetTemplate): SportySelection {
  return {
    eventId: bet.eventId,
    marketId: bet.marketId,
    specifier: bet.specifier || undefined,
    outcomeId: bet.outcomeId,
    productId: 3,
    sportId: "sr:sport:1",
  };
}
