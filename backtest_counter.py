#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# CUXMTIER COUNTER-STRATEGY BACKTEST
# Strategy A: +EV singles (edge-filtered, flat + Kelly staking)
# Strategy B: System/Flexi bets (2/3, 3/4, 2/4)
# ═══════════════════════════════════════════════════════════════

import csv, io, math, random, urllib.request
from collections import defaultdict

LEAGUES = [
    ("E0", "EPL"), ("D1", "Bundesliga"), ("SP1", "La Liga"),
    ("I1", "Serie A"), ("F1", "Ligue 1"),
]

# ═══════════════════════════ DATA ═════════════════════════════

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
                fthg = int(row.get("FTHG", -1) or -1)
                ftag = int(row.get("FTAG", -1) or -1)
                if fthg < 0: continue
                matches.append({
                    "league": name, "date": row.get("Date", ""),
                    "home": row.get("HomeTeam", ""), "away": row.get("AwayTeam", ""),
                    "fthg": fthg, "ftag": ftag,
                })
            except: continue
    return matches

# ═══════════════════════════ POISSON ══════════════════════════

def poisson_pmf(lmbda, k):
    if lmbda <= 0: return 1.0 if k == 0 else 0.0
    return (lmbda ** k) * math.exp(-lmbda) / math.factorial(k)

def scoreline_prob(hl, al, hg, ag, mg=6):
    """Joint Poisson prob for exact scoreline"""
    # Full joint for normalization
    total = 0.0
    for i in range(mg+1):
        for j in range(mg+1):
            total += poisson_pmf(hl, i) * poisson_pmf(al, j)
    p = poisson_pmf(hl, hg) * poisson_pmf(al, ag)
    return p / total if total > 0 else 0

# ═══════════════════════ TEAM STRENGTHS ══════════════════════

def build_strengths(matches):
    matches.sort(key=lambda m: m["date"])
    stats = defaultdict(lambda: {"gf_h":0,"ga_h":0,"gp_h":0,"gf_a":0,"ga_a":0,"gp_a":0})
    L_H, L_A = 1.55, 1.20
    enriched = []
    for m in matches:
        h, a = m["home"], m["away"]
        hs, as_ = stats[h], stats[a]
        ha = (hs["gf_h"]/hs["gp_h"]) if hs["gp_h"]>2 else L_H
        hd = (hs["ga_h"]/hs["gp_h"]) if hs["gp_h"]>2 else L_A
        aa = (as_["gf_a"]/as_["gp_a"]) if as_["gp_a"]>2 else L_A
        ad = (as_["ga_a"]/as_["gp_a"]) if as_["gp_a"]>2 else L_H
        hl = max(0.3, min(4.5, ha * ad / L_H))
        al = max(0.2, min(3.5, aa * hd / L_A))
        enriched.append({**m, "hl": hl, "al": al})
        # Update AFTER
        hs["gf_h"] += m["fthg"]; hs["ga_h"] += m["ftag"]; hs["gp_h"] += 1
        as_["gf_a"] += m["ftag"]; as_["ga_a"] += m["fthg"]; as_["gp_a"] += 1
    return enriched

# ═══════════════════════ PICK GENERATION ═════════════════════

def generate_picks(matches):
    """Generate picks with fair Poisson probability + simulated market"""
    picks = []
    # Realistic scorelines
    scorelines = [
        (1,0),(2,0),(2,1),(3,0),(3,1),(3,2),(4,1),(4,2),
        (0,1),(0,2),(1,2),(0,3),(1,3),(2,3),(1,4),(2,4),
        (1,1),(2,2),
    ]
    for m in matches:
        if m["hl"] is None: continue
        for hg, ag in scorelines:
            fp = scoreline_prob(m["hl"], m["al"], hg, ag)
            if fp < 0.008: continue
            fo = 1.0 / fp
            if fo < 3.0 or fo > 60: continue

            # Market: bookmaker margin (~18% avg for correct scores) + mispricing noise
            margin = random.gauss(0.18, 0.03)
            noise = random.gauss(0, 0.10)
            mo = fo * (1 - margin + noise)
            mo = max(2.0, min(80, mo))

            mi = 1.0 / mo
            edge = (fp - mi) / mi * 100

            if edge < 0: continue  # only +EV picks

            desc = f"{hg}-{ag}"
            won = (m["fthg"]==hg and m["ftag"]==ag)
            picks.append({
                "match": f"{m['home']} vs {m['away']}", "league": m["league"],
                "pick": desc, "fp": fp, "fo": fo, "mo": round(mo,2),
                "edge": edge, "won": won,
                "actual": f"{m['fthg']}-{m['ftag']}",
                "eid": f"cs|{m['home']}|{m['away']}|{desc}",
            })
    picks.sort(key=lambda p: p["edge"], reverse=True)
    return picks

# ═══════════════════════ MATH HELPERS ════════════════════════

def comb(n, k):
    return math.comb(n, k)

# ═══════════════════════ STRATEGY A: +EV SINGLES ═════════════

def backtest_singles(picks, edge_threshold, stake_per_bet=1.0):
    """Flat staking: bet 1 unit on every +EV pick above threshold"""
    filtered = [p for p in picks if p["edge"] >= edge_threshold]
    if not filtered: return None

    total_staked = len(filtered) * stake_per_bet
    total_return = sum(stake_per_bet * p["mo"] if p["won"] else 0 for p in filtered)
    profit = total_return - total_staked
    roi = profit / total_staked * 100

    wins = sum(1 for p in filtered if p["won"])
    hit_rate = wins / len(filtered) * 100

    # Theoretical EV
    theo_ev = sum((p["fp"] * p["mo"] - 1) * stake_per_bet for p in filtered)

    return {
        "bets": len(filtered),
        "wins": wins,
        "hit_rate": hit_rate,
        "staked": total_staked,
        "returned": total_return,
        "profit": profit,
        "roi": roi,
        "theo_ev": theo_ev,
        "avg_odds": sum(p["mo"] for p in filtered) / len(filtered),
        "avg_edge": sum(p["edge"] for p in filtered) / len(filtered),
    }


def kelly_staking(picks, edge_threshold, bankroll=100.0, fraction=0.25):
    """Fractional Kelly: bet size proportional to edge"""
    filtered = [p for p in picks if p["edge"] >= edge_threshold]
    if not filtered: return None

    br = bankroll
    bets_placed = 0
    wins = 0
    br_history = [br]

    for p in filtered:
        # Kelly fraction: edge / (odds - 1) * fraction
        b = p["mo"] - 1  # decimal odds - 1
        kelly_full = (p["fp"] * p["mo"] - 1) / b
        stake = max(0, kelly_full * fraction * br)
        stake = min(stake, br * 0.10)  # cap at 10% of bankroll

        if stake <= 0:
            continue

        br -= stake
        bets_placed += 1
        if p["won"]:
            br += stake * p["mo"]
            wins += 1
        br_history.append(br)

    if bets_placed == 0: return None

    roi = (br - bankroll) / bankroll * 100
    hit_rate = wins / bets_placed * 100

    return {
        "bets": bets_placed,
        "wins": wins,
        "hit_rate": hit_rate,
        "start_br": bankroll,
        "end_br": round(br, 2),
        "roi": roi,
        "max_drawdown": round(100 - min(br_history) / bankroll * 100, 1) if br_history else 0,
    }

# ═══════════════════════ STRATEGY B: SYSTEM BETS ═════════════

def backtest_system(picks, edge_threshold, system_type, target_odds=None):
    """
    System bets:
    - system_type: (M, N) = "M from N", e.g. (2,3) = doubles from 3 selections
    - Each pick is a correct score from the edge-filtered pool
    - We bet on all combinations of N picks taken M at a time
    """
    filtered = [p for p in picks if p["edge"] >= edge_threshold]
    if len(filtered) < system_type[1]:
        return None

    M, N = system_type  # M successful picks needed out of N
    n_combs = comb(N, M)  # number of combinations per system bet
    stake_per_comb = 1.0
    total_stake_per_system = n_combs * stake_per_comb

    # Run through picks in chronological-ish order, building system bets
    # Dedup per match
    bm = defaultdict(list)
    for p in filtered:
        bm[p["match"]].append(p)

    # Take best edge pick per match
    unique = []
    seen = set()
    for p in filtered:
        if p["match"] not in seen:
            unique.append(p)
            seen.add(p["match"])

    unique.sort(key=lambda p: p["edge"], reverse=True)

    # Build system bets in groups of N
    results = []
    for i in range(0, len(unique) - N + 1, N):
        group = unique[i:i+N]
        if len(group) < N:
            continue

        # Check if target_odds constraint is met
        if target_odds:
            # For system M/N, check if any M-combination reaches target
            meets_target = False
            for ci in range(comb(N, M)):
                # This is crude — just check median odds product
                prod = 1.0
                # Actually, let's check all combinations properly
                pass
            # Skip target check for now — just run all systems

        # Generate all M-combinations
        total_return = 0.0
        won_combos = 0

        # Calculate all M-combinations of indices
        def gen_combos(arr, k):
            if k == 0: yield []
            else:
                for i in range(len(arr)):
                    for c in gen_combos(arr[i+1:], k-1):
                        yield [arr[i]] + c

        for combo in gen_combos(group, M):
            odds = 1.0
            all_won = True
            for p in combo:
                odds *= p["mo"]
                if not p["won"]:
                    all_won = False
                    break
            if all_won:
                total_return += odds * stake_per_comb
                won_combos += 1

        profit = total_return - total_stake_per_system
        results.append({
            "group_size": N,
            "picks_required": M,
            "combs": n_combs,
            "staked": total_stake_per_system,
            "returned": total_return,
            "profit": profit,
            "won_combos": won_combos,
            "picks_won": sum(1 for p in group if p["won"]),
        })

    if not results:
        return None

    total_systems = len(results)
    total_profit = sum(r["profit"] for r in results)
    total_staked = sum(r["staked"] for r in results)
    roi = total_profit / total_staked * 100
    systems_with_return = sum(1 for r in results if r["returned"] > 0)

    avg_group_picks_won = sum(r["picks_won"] for r in results) / total_systems

    return {
        "systems": total_systems,
        "total_staked": total_staked,
        "total_profit": total_profit,
        "roi": roi,
        "systems_with_return": systems_with_return,
        "avg_group_picks_won": avg_group_picks_won,
    }

# ═══════════════════════ MAIN ═════════════════════════════════

random.seed(42)
print("=" * 70)
print("CUXMTIER COUNTER-STRATEGY BACKTEST")
print("Strategy A: +EV Singles  |  Strategy B: System/Flexi Bets")
print("=" * 70)

print("\n[1/3] Loading data + building model...")
matches = download()
enriched = build_strengths(matches)
picks = generate_picks(enriched)

# Split picks into chronological halves for train/test
midpoint = len(picks) // 2
picks.sort(key=lambda p: p["eid"])  # crude chronological proxy
train, test = picks[:midpoint], picks[midpoint:]

print(f"  Matches: {len(matches)}")
print(f"  +EV picks: {len(picks)} (edge ≥ 0%)")
print(f"  Train: {len(train)} | Test: {len(test)}")
print(f"  Overall hit rate: {sum(1 for p in picks if p['won'])/len(picks)*100:.1f}%")
print(f"  Avg odds: {sum(p['mo'] for p in picks)/len(picks):.1f}x")
print(f"  Avg edge: {sum(p['edge'] for p in picks)/len(picks):.1f}%")

# ═══════════════════════ STRATEGY A RESULTS ══════════════════

print(f"\n{'='*70}")
print("STRATEGY A: +EV SINGLES (Flat Staking, 1 unit/bet)")
print(f"{'='*70}")

edge_levels = [0, 3, 5, 10, 15, 20, 25]
print(f"\n{'Edge':>6} {'Bets':>6} {'Wins':>6} {'Hit%':>7} {'AvgOdds':>8} {'Staked':>8} {'Return':>8} {'Profit':>8} {'ROI%':>7} {'TheoEV':>8}")
print("-" * 85)

for el in edge_levels:
    r = backtest_singles(picks, el)
    if not r:
        print(f"{el:>5}%  {'—':>6}  {'—':>6}  {'—':>7}  {'—':>8}  {'—':>8}  {'—':>8}  {'—':>8}  {'—':>7}  {'—':>8}")
        continue
    print(f"{el:>5}%  {r['bets']:>6}  {r['wins']:>6}  {r['hit_rate']:>6.1f}%  {r['avg_odds']:>7.1f}x  "
          f"{r['staked']:>7.1f}  {r['returned']:>7.1f}  {r['profit']:>+7.1f}  {r['roi']:>+6.1f}%  {r['theo_ev']:>+7.1f}")

# Edge gradient: does higher edge → higher hit rate?
print(f"\n  Edge → Hit Rate Gradient:")
for el in [0, 5, 10, 15, 20]:
    b = [p for p in picks if p["edge"] >= el]
    if b:
        hr = sum(1 for p in b if p["won"]) / len(b) * 100
        avg_fp = sum(p["fp"] for p in b) / len(b) * 100
        print(f"    ≥{el}% edge: {hr:.1f}% hit (exp: {avg_fp:.1f}%)  n={len(b)}")

# ═══════════════════════ KELLY STAKING ═══════════════════════

print(f"\n{'='*70}")
print("STRATEGY A (cont'd): FRACTIONAL KELLY STAKING (¼ Kelly)")
print(f"{'='*70}")

for el in [3, 5, 10, 15]:
    r = kelly_staking(picks, el, bankroll=100.0, fraction=0.25)
    if not r:
        print(f"  ≥{el}% edge: No bets placed")
        continue
    print(f"  ≥{el}% edge: {r['bets']} bets | {r['wins']} wins ({r['hit_rate']:.1f}%) | "
          f"BR: 100 → {r['end_br']} ({r['roi']:+.1f}%) | Max DD: {r['max_drawdown']:.1f}%")

# ═══════════════════════ STRATEGY B RESULTS ══════════════════

print(f"\n{'='*70}")
print("STRATEGY B: SYSTEM/FLEXI BETS")
print(f"{'='*70}")

systems = [(2,3), (2,4), (3,4), (3,5)]
for sys_type in systems:
    for el in [5, 10]:
        r = backtest_system(picks, el, sys_type)
        if not r:
            print(f"  {sys_type[0]}/{sys_type[1]} @ ≥{el}% edge: No systems built")
            continue
        print(f"  {sys_type[0]}/{sys_type[1]} @ ≥{el}% edge: {r['systems']} systems | "
              f"profit {r['total_profit']:+.1f}u | ROI {r['roi']:+.1f}% | "
              f"{r['systems_with_return']}/{r['systems']} had returns | "
              f"avg {r['avg_group_picks_won']:.1f}/{sys_type[1]} picks correct")

# ═══════════════════════ COMPARISON SUMMARY ══════════════════

print(f"\n{'='*70}")
print("HEAD-TO-HEAD COMPARISON")
print(f"{'='*70}")

# Best singles strategy
best_single = backtest_singles(picks, 10)
# Best system strategy
best_sys = backtest_system(picks, 10, (3, 4))

print(f"""
  ┌─────────────────────┬──────────────┬──────────────┐
  │                     │ +EV Singles  │ System 3/4   │
  │                     │ (≥10% edge)  │ (≥10% edge)  │
  ├─────────────────────┼──────────────┼──────────────┤
  │ Bets / Systems      │ {best_single['bets']:>12}  │ {best_sys['systems'] if best_sys else '—':>12}  │
  │ Total Staked        │ {best_single['staked']:>9.0f}u   │ {best_sys['total_staked'] if best_sys else '—':>9}   │
  │ Total Profit        │ {best_single['profit']:>+9.1f}u  │ {best_sys['total_profit'] if best_sys else '—':>9}  │
  │ ROI                 │ {best_single['roi']:>+8.1f}%    │ {f"{best_sys['roi']:+.1f}%" if best_sys else '—':>8}    │
  │ Win Rate (indiv)    │ {best_single['hit_rate']:>8.1f}%   │             │
  │ Systems with return │              │ {f"{best_sys['systems_with_return']}/{best_sys['systems']}" if best_sys else '—':>12}  │
  └─────────────────────┴──────────────┴──────────────┘
""")

print("THEORETICAL BREAKDOWN:")
print("""
  System bets DON'T improve expected value — they redistribute variance:
  - EV(system M/N) = (p×o)^M - 1  — same as M-leg accumulator
  - The benefit is more frequent returns, reducing ruin risk
  - The cost is higher total stake (betting on all combinations)

  +EV singles IS mathematically superior:
  - Each bet is independent — no compounding of market margin
  - Kelly staking compounds edge exponentially over time
  - Variance is MUCH lower — you see wins regularly
  - The catch: you need GENUINE edge, not simulated edge
""")

# Final calibration check
print("MODEL CALIBRATION CHECK:")
bins = [(0.01,0.03),(0.03,0.05),(0.05,0.08),(0.08,0.12),(0.12,0.20)]
for lo,hi in bins:
    b = [p for p in picks if lo<=p["fp"]<hi]
    if not b: continue
    exp = sum(p["fp"] for p in b)/len(b)
    act = sum(1 for p in b if p["won"])/len(b)
    print(f"  Fair prob {lo:.0%}-{hi:.0%}: expected={exp:.1%}  actual={act:.1%}  n={len(b)}")
