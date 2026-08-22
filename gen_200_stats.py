#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# STATS-BASED 200-ODDS TICKET
# Uses real ESPN standings (WNBA 2026, MLS 2026, Liga MX Apertura 2026)
# ═══════════════════════════════════════════════════════════════

import json, math, urllib.request
from datetime import datetime, timezone, timedelta

SPORTYBET_FACTS = "https://www.sportybet.com/api/ng/factsCenter"
SPORTYBET_SHARE = "https://www.sportybet.com/api/ng/orders/share"
WAT = timezone(timedelta(hours=1))
START = datetime(2026, 8, 13, 0, 0, tzinfo=WAT)
END = datetime(2026, 8, 17, 0, 0, tzinfo=WAT)

def fetch_json(url, method="GET", body=None):
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=headers, method=method,
                                 data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())

# ── Fetch events ──
events = []
for sid in ["sr:sport:1", "sr:sport:2", "sr:sport:5"]:
    try:
        data = fetch_json(f"{SPORTYBET_FACTS}/importantEvents?sportId={sid}")
    except Exception as e:
        continue
    if data.get("bizCode") != 10000:
        continue
    for t in data.get("data", []):
        for ev in t.get("events", []):
            if ev.get("matchStatus") != "Not start":
                continue
            dt = datetime.fromtimestamp(ev.get("estimateStartTime", 0)/1000, tz=WAT)
            if START <= dt < END:
                events.append(ev)

# ── Stats picks in confidence order ──
# (home keyword, away keyword, market, pick, reason)
STATS_PICKS = [
    ("Minnesota Lynx", "Portland Fire", "1X2", "Away", "Lynx 27-7 (best) vs Fire 13-19"),
    ("Connecticut Sun", "Atlanta Dream", "1X2", "Away", "Dream 20-12 vs Sun 8-23 (2nd worst)"),
    ("Dallas Wings", "Toronto Tempo", "1X2", "Home", "Wings 19-14 vs Tempo 10-22"),
    ("Golden State Valkyries", "Chicago Sky", "1X2", "Home", "GSV 23-9 vs Sky 12-21"),
    ("Los Angeles FC", "Queretaro", "1X2", "Home", "LAFC 10-5 vs Queretaro 2-1"),
    ("New York Liberty", "Los Angeles Sparks", "1X2", "Home", "Liberty 20-14 vs Sparks 12-20"),
    ("Las Vegas Aces", "Washington Mystics", "1X2", "Home", "Aces 23-11 vs Mystics 19-13"),
    ("Van Assche", "Lajovic", "Winner", "Home", "Van Assche heavy favourite (1.35)"),
    ("Philadelphia Union", "Santos Laguna", "1X2", "Home", "Santos 0-3 bottom of Liga MX"),
    ("Korneeva", "Charaeva", "Winner", "Home", "Korneeva big favourite (1.27)"),
    ("Tien", "Shelton", "Winner", "Away", "Shelton higher-ranked"),
    ("Orlando City", "Atletico San Luis", "1X2", "Home", "San Luis 0-1 weak"),
    ("Gauff", "Rybakina", "Winner", "Home", "Gauff world #3 favourite"),
    ("Inter Miami", "Leon", "1X2", "Home", "Miami 11-2 MLS vs Leon 1-2 Liga MX"),
    ("America", "Austin", "1X2", "Home", "America 2-0 Liga MX leaders"),
]

def match_event(ev, hk, ak):
    h = ev.get("homeTeamName", "").lower()
    a = ev.get("awayTeamName", "").lower()
    hk, ak = hk.lower(), ak.lower()
    return (hk in h and ak in a) or (hk in a and ak in h)

def find_outcome(ev, mkt_kw, pick):
    for mkt in ev.get("markets", []):
        if mkt_kw.lower() not in (mkt.get("desc", "") or "").lower():
            continue
        for out in mkt.get("outcomes", []):
            if (out.get("desc", "") or "").lower() == pick.lower():
                return mkt, out
    return None, None

selected = []
used = set()
for hk, ak, mkt_kw, pick, reason in STATS_PICKS:
    for ev in events:
        if ev["eventId"] in used:
            continue
        if not match_event(ev, hk, ak):
            continue
        mkt, out = find_outcome(ev, mkt_kw, pick)
        if not mkt or not out:
            continue
        odds = float(out.get("odds", 0))
        if odds <= 1.0:
            continue
        selected.append({
            "eventId": ev["eventId"], "marketId": mkt["id"],
            "outcomeId": out["id"], "specifier": mkt.get("specifier"),
            "productId": mkt.get("product", 1), "sportId": ev["sport"]["id"],
            "home": ev["homeTeamName"], "away": ev["awayTeamName"],
            "tournament": ev["sport"]["category"]["tournament"]["name"],
            "marketDesc": mkt.get("desc",""), "pickDesc": out.get("desc",""),
            "odds": odds, "reason": reason,
        })
        used.add(ev["eventId"])
        break

print(f"Matched {len(selected)} stats picks:")
total = 1.0
for p in selected:
    total *= p["odds"]
    print(f"  {p['home']} vs {p['away']} | {p['pickDesc']} @ {p['odds']:.2f}  — {p['reason']}")

print(f"\nAll {len(selected)} games combined: {total:.0f} odds")

# ── Build to ~200 odds: greedily add in confidence order until hitting 200 ──
target_log = math.log(200)
cl = 0.0
slip = []
for p in selected:
    if cl >= target_log * 0.98:
        break
    slip.append(p)
    cl += math.log(p["odds"])

actual = math.exp(cl)
print(f"\n═══ STATS 200-ODDS TICKET ═══")
print(f"Games: {len(slip)} | Odds: {actual:.2f}")
for i, p in enumerate(slip):
    print(f"  {i+1:2d}. {p['home']} vs {p['away']} | {p['pickDesc']} @ {p['odds']:.2f}  ({p['tournament']})")

# ── Create code ──
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
    with open(r"C:\Users\DELL\Desktop\Projects\cuxmtier\stats_200_code.txt", "w") as f:
        f.write(code)
except Exception as e:
    print(f"\n❌ Code creation failed: {e}")
