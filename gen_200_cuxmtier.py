#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# CUXMTIER 200-ODDS TICKET — algorithm replica + real code creation
# ═══════════════════════════════════════════════════════════════

import json, math, urllib.request
from datetime import datetime, timezone, timedelta

SPORTYBET_FACTS = "https://www.sportybet.com/api/ng/factsCenter"
SPORTYBET_SHARE = "https://www.sportybet.com/api/ng/orders/share"
WAT = timezone(timedelta(hours=1))

SPORTS = [("sr:sport:1","Football"),("sr:sport:2","Basketball"),("sr:sport:5","Tennis"),("sr:sport:21","Cricket")]
START = datetime(2026, 8, 13, 0, 0, tzinfo=WAT)
END = datetime(2026, 8, 17, 0, 0, tzinfo=WAT)

# For 200 odds, use a wider "safe-ish" odds range (still high-probability picks)
MIN_ODDS = 1.45
MAX_ODDS = 2.60

def fetch_json(url, method="GET", body=None):
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=headers, method=method,
                                 data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

def league_weight(t):
    n = t.lower()
    if "champions league" in n and "women" not in n: return 1.0
    if "premier league" in n and "women" not in n and "reserve" not in n: return 1.0
    if "world cup" in n: return 1.0
    if "bundesliga" in n and "women" not in n and "reserve" not in n: return 0.95
    if "la liga" in n or "laliga" in n or "primera division" in n: return 0.95
    if "serie a" in n and "women" not in n: return 0.92
    if "ligue 1" in n: return 0.90
    if "europa league" in n: return 0.90
    if "eredivisie" in n: return 0.85
    if "primeira liga" in n: return 0.85
    if "mls" in n: return 0.82
    if "championship" in n: return 0.80
    if "leagues cup" in n: return 0.70
    if "wnba" in n: return 0.72
    if "atp" in n or "wta" in n: return 0.65
    if "torneo federal" in n: return 0.45
    if "gaucho" in n or "goiano" in n or "paulista" in n: return 0.45
    if "usl" in n: return 0.55
    if "cebl" in n or "bsn" in n or "lnbp" in n: return 0.45
    if "challenger" in n: return 0.40
    if "reserve" in n: return 0.35
    if "women" in n: return 0.40
    if "youth" in n or "u19" in n or "u21" in n or "u23" in n: return 0.30
    if "friend" in n: return 0.42
    if "srl" in n or "simulated" in n: return 0
    return 0.60

def market_fav(d, spec=None):
    d = d.lower()
    if "double chance" in d: return 1.08
    if "draw no bet" in d: return 1.05
    if d == "1x2": return 1.0
    if "over/under" in d:
        if spec and "total=0.5" in spec: return 1.10
        if spec and "total=1.5" in spec: return 1.05
        if spec and "total=2.5" in spec: return 0.92
        return 0.85
    if "both teams to score" in d: return 0.85
    if "win either half" in d: return 0.82
    if "1st half" in d or "2nd half" in d: return 0.75
    if "goal bounds" in d: return 0.70
    return 0.88

def score_pick(tourn, mdesc, spec, odds, prob):
    s = prob
    s *= league_weight(tourn)
    s *= market_fav(mdesc, spec)
    if odds <= 1.10: s *= 1.08
    elif odds <= 1.20: s *= 1.04
    elif odds <= 1.30: s *= 1.0
    elif odds <= 1.45: s *= 0.93
    else: s *= 0.85
    return s

# ── Collect picks ──
picks = []
for sid, sname in SPORTS:
    try:
        data = fetch_json(f"{SPORTYBET_FACTS}/importantEvents?sportId={sid}")
    except Exception as e:
        print(f"  ⚠ {sname}: {e}")
        continue
    if data.get("bizCode") != 10000:
        continue
    for t in data.get("data", []):
        tname = t.get("name","?")
        if league_weight(tname) == 0:
            continue
        for ev in t.get("events", []):
            if ev.get("matchStatus") != "Not start":
                continue
            dt = datetime.fromtimestamp(ev.get("estimateStartTime",0)/1000, tz=WAT)
            if not (START <= dt < END):
                continue
            for mkt in ev.get("markets", []):
                spec = mkt.get("specifier")
                mdesc = (mkt.get("desc","") or "").lower()
                # Skip confusing/unhelpful tennis "match to end" and set-score markets
                if "match to end" in mdesc or "set betting" in mdesc or "correct score" in mdesc:
                    continue
                for out in mkt.get("outcomes", []):
                    odds = float(out.get("odds",0))
                    if odds < MIN_ODDS or odds > MAX_ODDS:
                        continue
                    prob = float(out.get("probability","0") or 0)
                    safety = score_pick(tname, mkt.get("desc",""), spec, odds, prob)
                    if safety < 0.08:
                        continue
                    picks.append({
                        "eventId": ev["eventId"], "marketId": mkt["id"],
                        "outcomeId": out["id"], "specifier": spec,
                        "productId": mkt.get("product",1), "sportId": ev["sport"]["id"],
                        "home": ev["homeTeamName"], "away": ev["awayTeamName"],
                        "tournament": tname, "marketDesc": mkt.get("desc",""),
                        "pickDesc": out.get("desc",""), "odds": odds,
                        "probability": prob, "safetyScore": safety, "start": dt,
                    })

picks.sort(key=lambda p: p["safetyScore"], reverse=True)
print(f"Safe picks in window (odds {MIN_ODDS}-{MAX_ODDS}): {len(picks)}")

# ── Build 200-odds accumulator (best-fit, dedupe per event) ──
def build(picks, target, min_g=10, max_g=20):
    best = {}
    for p in picks:
        if p["eventId"] not in best or p["safetyScore"] > best[p["eventId"]]["safetyScore"]:
            best[p["eventId"]] = p
    unique = sorted(best.values(), key=lambda x: x["safetyScore"], reverse=True)
    tl = math.log(target)
    slip, used, cl = [], set(), 0.0
    for _ in range(max_g):
        if len(slip) >= max_g:
            break
        rem = max_g - len(slip)
        nl = tl - cl
        ideal = nl / rem if rem > 0 else 0
        bp, bs = None, float("inf")
        pool = min(len(unique), len(slip) + 80)
        for i in range(pool):
            p = unique[i]
            if p["eventId"] in used:
                continue
            pl = math.log(p["odds"])
            newl = cl + pl
            if len(slip) >= min_g and rem <= 2 and newl > tl * 1.15:
                continue
            if len(slip) >= min_g and pl < 0.12 and nl > 0.3 and rem <= 3:
                continue
            w = abs(pl - ideal) * (1.5 - p["safetyScore"])
            if w < bs:
                bs, bp = w, p
        if not bp:
            for p in unique:
                if p["eventId"] not in used:
                    bp = p; break
        if not bp:
            break
        slip.append(bp); cl += math.log(bp["odds"]); used.add(bp["eventId"])
        if len(slip) >= min_g and 0.97*tl <= cl <= 1.05*tl:
            break
    if len(slip) < min_g:
        return None, 0
    return slip, math.exp(cl)

slip, actual = build(picks, 200)
if not slip:
    print("Could not build slip")
    raise SystemExit(1)

print(f"\n═══ 200-ODDS TICKET (CuxmTier algorithm) ═══")
print(f"Games: {len(slip)} | Odds: {actual:.2f} | Bookmaker prob: {100/actual:.2f}%")
for i, p in enumerate(slip):
    print(f"  {i+1:2d}. {p['home']} vs {p['away']} | {p['marketDesc']}: {p['pickDesc']} @ {p['odds']:.2f}  [{p['safetyScore']:.3f}]  ({p['tournament']})")

# ── Create booking code ──
selections = [{
    "eventId": p["eventId"], "marketId": p["marketId"],
    "specifier": p["specifier"], "outcomeId": p["outcomeId"],
    "productId": p["productId"], "sportId": p["sportId"],
} for p in slip]

try:
    resp = fetch_json(SPORTYBET_SHARE, "POST", {"selections": selections})
    code = resp["data"]["shareCode"]
    print(f"\n✅ BOOKING CODE: {code}")
    print(f"   https://www.sportybet.com/ng/?shareCode={code}")
    with open(r"C:\Users\DELL\Desktop\Projects\cuxmtier\cuxmtier_200_code.txt", "w") as f:
        f.write(code)
except Exception as e:
    print(f"\n❌ Failed to create code: {e}")
    # Save selections for manual retry
    with open(r"C:\Users\DELL\Desktop\Projects\cuxmtier\cuxmtier_200_selections.json", "w") as f:
        json.dump(selections, f)
    print("Saved selections to cuxmtier_200_selections.json")
