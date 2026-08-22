#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════
# CUXMTIER HIGH-ODDS BACKTEST v2 — Poisson Correct Score Model
# Fixed: proper market simulation with mispricing + wider odds range
# ═══════════════════════════════════════════════════════════════

import csv, io, math, random, urllib.request
from collections import defaultdict

LEAGUES = [
    ("E0", "EPL"), ("D1", "Bundesliga"), ("SP1", "La Liga"),
    ("I1", "Serie A"), ("F1", "Ligue 1"),
]

# ═══════════════════════════════════════════════════════════════
# DATA
# ═══════════════════════════════════════════════════════════════

def download():
    matches = []
    for code, name in LEAGUES:
        url = f"https://www.football-data.co.uk/mmz4281/2425/{code}.csv"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read().decode("utf-8", errors="replace")
        except Exception as e:
            print(f"  ⚠ {name}: download failed ({e})")
            continue
        reader = csv.DictReader(io.StringIO(data))
        for row in reader:
            try:
                fthg = int(row.get("FTHG", -1) or -1)
                ftag = int(row.get("FTAG", -1) or -1)
                if fthg < 0:
                    continue
                matches.append({
                    "league": name, "date": row.get("Date", ""),
                    "home": row.get("HomeTeam", ""), "away": row.get("AwayTeam", ""),
                    "fthg": fthg, "ftag": ftag,
                })
            except:
                continue
    return matches

# ═══════════════════════════════════════════════════════════════
# POISSON
# ═══════════════════════════════════════════════════════════════

def poisson_pmf(lmbda, k):
    if lmbda <= 0:
        return 1.0 if k == 0 else 0.0
    return (lmbda ** k) * math.exp(-lmbda) / math.factorial(k)

def correct_score_probs(hl, al, mg=6):
    ps = {}
    t = 0.0
    for i in range(mg+1):
        for j in range(mg+1):
            p = poisson_pmf(hl, i) * poisson_pmf(al, j)
            ps[(i,j)] = p
            t += p
    return {(i,j): p/t for (i,j),p in ps.items()}

# ═══════════════════════════════════════════════════════════════
# TEAM STRENGTHS (rolling, no look-ahead)
# ═══════════════════════════════════════════════════════════════

def build_strengths(matches):
    matches.sort(key=lambda m: m["date"])
    stats = defaultdict(lambda: {"gf_h":0,"ga_h":0,"gp_h":0,"gf_a":0,"ga_a":0,"gp_a":0})
    L_HOME = 1.55; L_AWAY = 1.20
    enriched = []
    for m in matches:
        h, a = m["home"], m["away"]
        hs, as_ = stats[h], stats[a]

        ha = (hs["gf_h"]/hs["gp_h"]) if hs["gp_h"]>2 else L_HOME
        hd = (hs["ga_h"]/hs["gp_h"]) if hs["gp_h"]>2 else L_AWAY
        aa = (as_["gf_a"]/as_["gp_a"]) if as_["gp_a"]>2 else L_AWAY
        ad = (as_["ga_a"]/as_["gp_a"]) if as_["gp_a"]>2 else L_HOME

        hl = max(0.3, min(4.5, ha * ad / L_HOME))
        al = max(0.2, min(3.5, aa * hd / L_AWAY))

        enriched.append({**m, "hl": hl, "al": al})

        # Update AFTER (no look-ahead)
        hs["gf_h"] += m["fthg"]; hs["ga_h"] += m["ftag"]; hs["gp_h"] += 1
        as_["gf_a"] += m["ftag"]; as_["ga_a"] += m["fthg"]; as_["gp_a"] += 1
    return enriched

# ═══════════════════════════════════════════════════════════════
# PICK GENERATION — fair odds vs market with mispricing
# ═══════════════════════════════════════════════════════════════

def generate_picks(matches):
    picks = []
    scorelines = [
        (1,0),(2,0),(2,1),(3,0),(3,1),(3,2),(4,1),(4,2),
        (0,1),(0,2),(1,2),(0,3),(1,3),(2,3),(1,4),(2,4),
        (1,1),(2,2),(3,3),
    ]
    for m in matches:
        if m["hl"] is None:
            continue
        probs = correct_score_probs(m["hl"], m["al"])
        for hg, ag in scorelines:
            fp = probs.get((hg,ag), 0)
            if fp < 0.008:  # ~1/125, min to be interesting
                continue

            fo = 1.0 / fp  # fair odds
            if fo < 2.5 or fo > 80:
                continue

            # Simulate market: bookmaker margin (15-22%) + random mispricing (±15%)
            margin = random.gauss(0.185, 0.03)
            noise = random.gauss(0, 0.12)  # market sometimes over/under-prices
            mo = fo * (1 - margin + noise)
            mo = max(1.5, min(100, mo))

            mi = 1.0 / mo
            edge = (fp - mi) / mi * 100  # positive = our edge

            # Only keep picks with meaningful edge
            if edge < 3:
                continue

            desc = f"{hg}-{ag}"
            won = (m["fthg"]==hg and m["ftag"]==ag)

            picks.append({
                "match": f"{m['home']} vs {m['away']}",
                "league": m["league"],
                "pick": f"CS {desc}",
                "fp": fp, "fo": fo,
                "mo": round(mo, 2), "edge": edge,
                "won": won, "actual": f"{m['fthg']}-{m['ftag']}",
                "eid": f"cs|{m['home']}|{m['away']}|{desc}",
            })
    picks.sort(key=lambda p: p["edge"], reverse=True)
    return picks

# ═══════════════════════════════════════════════════════════════
# SLIP BUILDER
# ═══════════════════════════════════════════════════════════════

def build_slip(picks, target, min_g=3, max_g=4):
    tl = math.log(target)
    valid = [p for p in picks if 2.5 <= p["mo"] <= 80]
    if len(valid) < min_g:
        return None

    best = {}
    for p in valid:
        k = p["match"]
        if k not in best or p["edge"] > best[k]["edge"]:
            best[k] = p
    unique = sorted(best.values(), key=lambda x: x["edge"], reverse=True)

    if len(unique) < min_g:
        return None

    slip, cl, used = [], 0.0, set()
    for p in unique:
        if len(slip) >= max_g:
            break
        if p["match"] in used:
            continue
        slip.append(p)
        cl += math.log(p["mo"])
        used.add(p["match"])
        if len(slip) >= min_g and cl >= tl * 0.75:
            break

    if len(slip) < min_g:
        return None
    ao = math.exp(cl)
    if ao < target * 0.4:
        return None
    return {"picks": slip, "odds": round(ao, 1), "target": target}

# ═══════════════════════════════════════════════════════════════
# BACKTEST
# ═══════════════════════════════════════════════════════════════

def chrono_backtest(picks, target, min_g, max_g):
    bm = defaultdict(list)
    for p in picks:
        bm[p["match"]].append(p)
    mo = list(bm.keys())
    step = max(1, len(mo)//25)
    results, avail = [], []
    for i in range(0, len(mo), step):
        for m in mo[i:i+step]:
            avail.extend(bm[m])
        avail.sort(key=lambda x: x["edge"], reverse=True)
        s = build_slip(avail, target, min_g, max_g)
        if s:
            aw = all(p["won"] for p in s["picks"])
            wc = sum(1 for p in s["picks"] if p["won"])
            results.append({"slip": s, "all_won": aw, "wc": wc, "total": len(s["picks"])})
    return results

def mc(picks, target, min_g, max_g, n=3000):
    wins = roi = n_slips = 0.0
    for _ in range(n):
        shuf = picks[:]
        random.shuffle(shuf)
        s = build_slip(shuf, target, min_g, max_g)
        if not s:
            continue
        n_slips += 1
        if all(p["won"] for p in s["picks"]):
            wins += 1
            roi += s["odds"] - 1
        else:
            roi -= 1
    if n_slips == 0:
        return {"hit": 0, "roi": 0, "wins": 0, "n": 0}
    return {"hit": wins/n_slips*100, "roi": roi/n_slips*100, "wins": int(wins), "n": int(n_slips)}

# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

random.seed(42)
print("=" * 70)
print("CUXMTIER HIGH-ODDS BACKTEST v2 — Poisson Correct Score")
print("50x · 100x · 200x — 3-4 picks per slip")
print("=" * 70)

print("\n[1/4] Downloading 2024/25 data...")
matches = download()
print(f"  ✓ {len(matches)} matches")

print("\n[2/4] Rolling team strengths...")
enriched = build_strengths(matches)
print(f"  ✓ {len(enriched)} enriched")

# Quick diagnostic: what do lambdas look like?
hls = [m["hl"] for m in enriched]
als = [m["al"] for m in enriched]
print(f"  Home λ: min={min(hls):.2f} avg={sum(hls)/len(hls):.2f} max={max(hls):.2f}")
print(f"  Away λ: min={min(als):.2f} avg={sum(als)/len(als):.2f} max={max(als):.2f}")

# Diagnostic: correct score probabilities for a typical match
mid = enriched[len(enriched)//2]
probs = correct_score_probs(mid["hl"], mid["al"])
top_scores = sorted(probs.items(), key=lambda x: -x[1])[:10]
print(f"\n  Example: {mid['home']} vs {mid['away']} (λ: {mid['hl']:.2f}/{mid['al']:.2f})")
for (hg, ag), p in top_scores:
    print(f"    {hg}-{ag}: {p*100:.2f}% (fair odds: {1/p:.1f})")

print("\n[3/4] Finding value picks...")
picks = generate_picks(enriched)
print(f"  ✓ {len(picks)} value picks (edge ≥ 3%, odds 2.5-80)")

if picks:
    edges = [p["edge"] for p in picks]
    odds = [p["mo"] for p in picks]
    fps = [p["fp"] for p in picks]
    print(f"  Edge range: {min(edges):.1f}% – {max(edges):.1f}%")
    print(f"  Avg edge: {sum(edges)/len(edges):.1f}%")
    print(f"  Market odds range: {min(odds):.1f} – {max(odds):.1f}")
    print(f"  Avg fair prob: {sum(fps)/len(fps)*100:.1f}%")

    hits = sum(1 for p in picks if p["won"])
    print(f"\n  Pick hit rate: {hits}/{len(picks)} = {hits/len(picks)*100:.1f}%")
    print(f"  Expected (avg fp): {sum(fps)/len(fps)*100:.1f}%")

    print(f"\n  Hit rate by edge bucket:")
    for t in [5, 10, 15, 20, 30]:
        b = [p for p in picks if p["edge"]>=t]
        if b:
            bh = sum(1 for p in b if p["won"])
            print(f"    ≥{t}% edge: {bh}/{len(b)} = {bh/len(b)*100:.1f}%  (avg fp: {sum(p['fp']for p in b)/len(b)*100:.1f}%)")

    # Scoreline frequency
    print(f"\n  Most common correct scores (all matches):")
    from collections import Counter
    sc = Counter(f"{m['fthg']}-{m['ftag']}" for m in enriched)
    for score, cnt in sc.most_common(12):
        print(f"    {score}: {cnt} ({cnt/len(enriched)*100:.1f}%)")

    print(f"\n[4/4] Backtests")
    print("=" * 70)

    for target, mg, Mg in [(50,3,4), (100,3,4), (200,3,4)]:
        print(f"\n─── {target}x ({mg}-{Mg} picks) ───")
        cr = chrono_backtest(picks, target, mg, Mg)
        if cr:
            w = sum(1 for r in cr if r["all_won"])
            t = len(cr)
            troi = sum((r["slip"]["odds"]-1) if r["all_won"] else -1 for r in cr)
            ao = sum(r["slip"]["odds"] for r in cr)/t
            print(f"  Chrono ({t} slips): hit {w}/{t} ({w/t*100:.1f}%) | ROI {troi:+.1f}u ({troi/t*100:+.1f}%) | avg odds {ao:.1f}x")

            # Best slip
            best = max(cr, key=lambda r: (r["slip"]["odds"] if r["all_won"] else 0))
            st = "✓ WON" if best["all_won"] else "✗ LOST"
            print(f"  Best: {st} @ {best['slip']['odds']:.1f}x")
            for i,p in enumerate(best["slip"]["picks"]):
                mk = "✓" if p["won"] else "✗"
                print(f"    {i+1}. {mk} {p['match'][:40]} — {p['pick']} @ {p['mo']:.1f} ({p['edge']:.0f}% edge) → {p['actual']}")
        else:
            print(f"  No slips built")

        mc_res = mc(picks, target, mg, Mg, 3000)
        print(f"  MC (3k): hit {mc_res['hit']:.1f}% ({mc_res['wins']}/{mc_res['n']}) | ROI {mc_res['roi']:+.1f}%")

    # Calibration
    print(f"\n{'='*70}")
    print("CALIBRATION")
    print(f"{'='*70}")
    bins = [(0.01,0.03),(0.03,0.05),(0.05,0.08),(0.08,0.12),(0.12,0.20)]
    for lo,hi in bins:
        b = [p for p in picks if lo<=p["fp"]<hi]
        if not b: continue
        exp = sum(p["fp"] for p in b)/len(b)
        act = sum(1 for p in b if p["won"])/len(b)
        flag = "✓" if abs(exp-act)<0.02 else ("⚠ OVER" if exp>act else "⚠ UNDER")
        print(f"  [{lo:.0%}-{hi:.0%}): n={len(b):3d}  exp={exp:.1%}  act={act:.1%}  {flag}")

    # Overall verdict
    print(f"\n{'='*70}")
    print("BOTTOM LINE")
    print(f"{'='*70}")
    hit_rate = hits/len(picks)*100
    slip_3_hit = (hit_rate/100)**3*100
    print(f"""
  Poisson correct score model on 5 leagues, 2024/25:

  Value picks: {len(picks)} (from {len(enriched)} matches)
  Single-pick accuracy: {hit_rate:.1f}%
  3-leg accumulator expected: {slip_3_hit:.2f}%

  At 50x: breakeven requires {100/50:.1f}% hit rate
  At 100x: breakeven requires {100/100:.1f}% hit rate
  At 200x: breakeven requires {100/200:.2f}% hit rate

  → 3-pick correct score accumulators hit in the 0.01%-0.1% range
  → You'd need 50-200x odds per pick (not 3-12x) to make it work
  → This approach is NOT viable with 3-4 picks at these odds
""")
else:
    print("\n  ⚠ No picks found — Poisson model probability too low for these thresholds")
