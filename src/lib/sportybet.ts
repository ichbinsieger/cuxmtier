// SportyBet API wrapper — no auth needed for share codes

const BASE = "https://www.sportybet.com/api/ng/orders/share";

// SportyBet's CloudFront blocks bare/generic user-agents (403). A realistic
// desktop Chrome UA passes. Keep Accept-Language + sec-ch-ua for good measure.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface SportySelection {
  eventId: string;
  marketId: string;
  specifier?: string;
  outcomeId: string;
  productId: number;
  sportId: string;
}

export interface SportyOutcome {
  eventId: string;
  gameId: string;
  estimateStartTime: number;
  matchStatus: string;
  homeTeamName: string;
  awayTeamName: string;
  sport: {
    id: string;
    name: string;
    category: {
      id: string;
      name: string;
      tournament: {
        id: string;
        name: string;
      };
    };
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
      isWinning?: boolean | number;
    }>;
  }>;
  bookingStatus: string;
}

export interface SharedTicket {
  shareCode: string;
  shareURL: string;
  ticket: {
    selections: SportySelection[];
  };
  outcomes: SportyOutcome[];
}

export async function fetchBookCode(code: string): Promise<SharedTicket> {
  const res = await fetch(`${BASE}/${code}`, {
    headers: BROWSER_HEADERS,
  });

  if (!res.ok) throw new Error(`Failed to fetch code: ${res.status}`);
  
  const json = await res.json();
  if (json.bizCode !== 10000) throw new Error(json.message || "Invalid code");
  
  return json.data;
}

/**
 * Fetch FULL event detail (all markets + outcomes) by event id. The share API
 * only returns the *selected* outcome per market, so the Alter feature uses
 * this endpoint to enumerate every alternative option for a game.
 */
export async function fetchEventDetail(eventId: string): Promise<SportyOutcome | null> {
  try {
    const res = await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(eventId)}`, {
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.bizCode !== 10000) return null;
    return json.data as SportyOutcome;
  } catch {
    return null;
  }
}

export async function createBookCode(selections: SportySelection[]): Promise<string> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ selections }),
  });

  if (!res.ok) throw new Error(`Failed to create code: ${res.status}`);
  
  const json = await res.json();
  if (json.bizCode !== 10000) throw new Error(json.message || "Failed to create");
  
  return json.data.shareCode;
}

// Extract the selected outcome for each selection
export function resolveOutcome(outcomes: SportyOutcome[], sel: SportySelection) {
  const outcome = outcomes.find(o => o.eventId === sel.eventId);
  if (!outcome) return null;
  
  const market = outcome.markets.find(m => 
    m.id === sel.marketId && 
    (m.specifier || undefined) === (sel.specifier || undefined)
  );
  if (!market) return null;
  
  const pick = market.outcomes.find(o => o.id === sel.outcomeId);
  if (!pick) return null;
  
  return {
    homeTeam: outcome.homeTeamName,
    awayTeam: outcome.awayTeamName,
    tournament: outcome.sport.category.tournament.name,
    category: outcome.sport.category.name,
    marketDesc: market.desc,
    marketGroup: market.group,
    specifier: market.specifier,
    pickDesc: pick.desc,
    odds: parseFloat(pick.odds),
    probability: parseFloat(pick.probability || "0"),
    matchStatus: outcome.matchStatus,
    eventId: sel.eventId,
    marketId: sel.marketId,
    outcomeId: sel.outcomeId,
    specifierRaw: sel.specifier,
    productId: sel.productId,
    sportId: sel.sportId,
  };
}
