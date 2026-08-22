#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# DRAW MARKET ANALYSIS — is there value in betting draws?
# Data: football-data.co.uk 2024/25 (Pinnacle closing odds)
# ═══════════════════════════════════════════════════════════════

import csv, io, math, urllib.request

LEAGUES = [
    ("E0", "EPL"), ("D1", "Bundesliga"), ("SP1", "La Liga"),
    ("I1", "Serie A"), ("F1", "Ligue 1"),
]

def download():
    matches = []
    for code, name in LEAGUES:
        url = f"https://www.football-data.co.uk/mmz4281/2425/{code}.csv"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read().decode("utf-8", errors="replace")
        except:
            continue
        reader = csv.DictReader(io.StringIO(data))
        for row in reader:
            try:
                psd = float(row.get("PSD", 0) or 0)  # Pinnacle draw odds
                ftr = row.get("FTR", "")              # H/D/A
                psh = float(row.get("PSH", 0) or 0)
                psa = float(row.get("PSA", 0) or 0)
                p_over = float(row.get("P>2.5", 0) or 0)
                p_under = float(row.get("P<2.5", 0) or 0)
                fthg = int(row.get("FTHG", -1) or -1)
                ftag = int(row.get("FTAG", -1) or -1)
                if psd <= 0 or ftr not in ("H", "D", "A"):
                    continue
                matches.append({
                    "league": name, "home": row.get("HomeTeam", ""),
                    "away": row.get("AwayTeam", ""),
                    "psh": psh, "psd": psd, "psa": psa,
                    "p_over": p_over, "p_under": p_under,
                    "fthg": fthg, "ftag": ftag, "ftr": ftr,
                })
            except:
                continue
    return matches

matches = download()
print(f"Loaded {len(matches)} matches\n")

# ── 1. Base draw rate by league ──
print("═══ 1. DRAW RATE BY LEAGUE ═══")
from collections import defaultdict
by_league = defaultdict(list)
for m in matches:
    by_league[m["league"]].append(m)

for lg, ms in by_league.items():
    draws = sum(1 for m in ms if m["ftr"] == "D")
    print(f"  {lg:12s}: {draws}/{len(ms)} = {draws/len(ms)*100:.1f}%")

overall_draws = sum(1 for m in matches if m["ftr"] == "D")
print(f"\n  OVERALL: {overall_draws}/{len(matches)} = {overall_draws/len(matches)*100:.1f}%\n")

# ── 2. Odds vs actual (calibration) ──
print("═══ 2. DRAW ODDS CALIBRATION (implied vs actual) ═══")
buckets = [(0,2.5),(2.5,2.8),(2.8,3.0),(3.0,3.2),(3.2,3.4),(3.4,3.6),(3.6,3.8),(3.8,4.2),(4.2,5.0),(5.0,99)]
print(f"  {'Odds':>12} {'n':>4} {'implied%':>8} {'actual%':>8} {'EV (flat)':>9}")
for lo, hi in buckets:
    b = [m for m in matches if lo <= m["psd"] < hi]
    if not b: continue
    n = len(b)
    implied = sum(1/m["psd"] for m in b) / n
    actual = sum(1 for m in b if m["ftr"] == "D") / n
    ev = actual * (sum(m["psd"] for m in b)/n) - 1  # flat stake EV
    print(f"  {lo:.1f}-{hi:.1f}: {n:>4} {implied*100:>7.1f}% {actual*100:>7.1f}% {ev*100:>+8.1f}%")

# ── 3. Flat-bet all draws ──
print("\n═══ 3. FLAT-BET ALL DRAWS (1 unit each) ═══")
staked = len(matches)
returned = sum(m["psd"] for m in matches if m["ftr"] == "D")
roi = (returned - staked) / staked * 100
print(f"  {staked} bets, {overall_draws} wins ({overall_draws/staked*100:.1f}%)")
print(f"  Returned {returned:.0f}u vs {staked}u staked → ROI {roi:+.1f}%\n")

# ── 4. Value filters — does anything beat the margin? ──
print("═══ 4. VALUE FILTERS (trying to find +EV draws) ═══")

def test_filter(label, cond):
    b = [m for m in matches if cond(m)]
    if not b:
        print(f"  {label}: no matches"); return
    n = len(b)
    wins = sum(1 for m in b if m["ftr"] == "D")
    ret = sum(m["psd"] for m in b if m["ftr"] == "D")
    roi = (ret - n) / n * 100
    hit = wins / n * 100
    print(f"  {label}: {n} bets, {hit:.1f}% hit, ROI {roi:+.1f}%")

# 4a. Low total expectation (Under 2.5 favored) — fewer goals = more draws
test_filter("Under 2.5 favored (P<2.5 odds < 2.0)", lambda m: m["p_under"] > 0 and m["p_under"] < 2.0)

# 4b. Evenly-matched teams (home/draw odds close)
test_filter("Even match (|1/psh - 1/psa| < 0.05)", lambda m: abs(1/m["psh"] - 1/m["psa"]) < 0.05)

# 4c. High draw odds (longshot draws)
test_filter("Draw odds > 3.6", lambda m: m["psd"] > 3.6)

# 4d. Low draw odds (favorite to draw)
test_filter("Draw odds < 3.0", lambda m: m["psd"] < 3.0)

# 4e. Home dog (away favorite, draw more likely?)
test_filter("Away favorite (psa < psh)", lambda m: m["psa"] < m["psh"])

# 4f. Under 2.5 strongly favored + even match
test_filter("Under 2.5 favored + even match",
            lambda m: m["p_under"] > 0 and m["p_under"] < 1.9 and abs(1/m["psh"] - 1/m["psa"]) < 0.08)

# 4g. Specific leagues (low-scoring leagues draw more)
test_filter("Ligue 1 only", lambda m: m["league"] == "Ligue 1")
test_filter("Serie A only", lambda m: m["league"] == "Serie A")
test_filter("La Liga only", lambda m: m["league"] == "La Liga")

# ── 5. The draw bias question ──
print("\n═══ 5. IS THERE A DRAW BIAS? (public under-bets draws) ═══")
# If draws were systematically underpriced, flat-betting them would be +EV.
# Compare implied vs actual across all matches:
implied_avg = sum(1/m["psd"] for m in matches) / len(matches)
actual_avg = overall_draws / len(matches)
print(f"  Average implied draw prob: {implied_avg*100:.1f}%")
print(f"  Actual draw rate:          {actual_avg*100:.1f}%")
print(f"  Gap: {actual_avg*100 - implied_avg*100:+.1f} pts "
      f"({'→ draws OVERPRICED (betting them is -EV)' if actual_avg < implied_avg else '→ draws UNDERPRICED (+EV)'})")
