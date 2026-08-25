#!/usr/bin/env python3
# Follow-up: is a match's OWN draw-odds drift (closing - opening) predictive,
# and does it beat the closing-odds margin? This is the literal #8 signal.
import math, urllib.request, concurrent.futures
from collections import defaultdict

BASE = "https://www.football-data.co.uk/mmz4281"
SEASONS = ["2425", "2526", "2627"]
LEAGUES = ["E0","E1","E2","E3","SC0","D1","D2","I1","I2","SP1","SP2","F1","F2","N1","P1","B1","T1","G1"]

def parse_csv_line(line):
    out, cur, inq = [], "", False
    for i, ch in enumerate(line):
        if inq:
            if ch == '"':
                if i+1 < len(line) and line[i+1] == '"': cur += '"'; i += 1
                else: inq = False
            else: cur += ch
        elif ch == '"': inq = True
        elif ch == ",": out.append(cur); cur = ""
        else: cur += ch
    out.append(cur); return out

def parse_csv(t):
    if t and t[0] == "\ufeff": t = t[1:]
    lines = [l for l in t.splitlines() if l.strip()]
    if len(lines) < 2: return []
    h = [x.strip() for x in parse_csv_line(lines[0])]
    return [{h[j]: (cells[j] if j < len(cells) else "") for j in range(len(h))} for cells in (parse_csv_line(l) for l in lines[1:])]

def num(s):
    try:
        return float(s) if s not in ("", None) else None
    except (TypeError, ValueError):
        return None

def fetch(code, season):
    try:
        req = urllib.request.Request(f"{BASE}/{season}/{code}.csv", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            t = r.read().decode("utf-8", "replace")
        return parse_csv(t) if not t.lstrip().startswith(("<!DOCTYPE","<html")) else None
    except Exception:
        return None

def main():
    data = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        tasks = [(c, s) for c in LEAGUES for s in SEASONS]
        for (c, s), rows in zip(tasks, ex.map(lambda a: fetch(*a), tasks)):
            if rows: data[(c, s)] = rows

    rows = []
    for (c, s), rs in data.items():
        for r in rs:
            ftr = (r.get("FTR") or "").strip().upper()
            fthg, ftag = num(r.get("FTHG")), num(r.get("FTAG"))
            if ftr not in ("H","D","A") or fthg is None or ftag is None: continue
            # open/closing draw odds (market-avg, then Pinnacle, then B365)
            op = num(r.get("AvgD")) or num(r.get("PSD")) or num(r.get("B365D"))
            cl = num(r.get("AvgCD")) or num(r.get("PSCD")) or num(r.get("B365CD"))
            # closing draw only (for flat-bet value)
            cd = num(r.get("AvgCD")) or num(r.get("PSCD")) or num(r.get("B365CD"))
            if op is None or cl is None: continue
            rows.append({"drift": cl - op, "drew": 1 if ftr == "D" else 0, "close": cd})

    print(f"Matches with open+close draw odds: {len(rows)}")
    dr = sum(r["drew"] for r in rows)/len(rows)*100
    print(f"Overall draw rate: {dr:.1f}%\n")

    print("Match-own drift (closing - opening draw odds) → draw rate:")
    buckets = [(-10,-0.35),(-0.35,-0.2),(-0.2,-0.1),(-0.1,0.0),(0.0,0.1),(0.1,0.2),(0.2,0.35),(0.35,10)]
    print(f"  {'drift':>10} {'n':>6} {'draw%':>7} {'avg close':>9}")
    for lo, hi in buckets:
        b = [r for r in rows if lo <= r["drift"] < hi]
        if not b: continue
        d = sum(r["drew"] for r in b)/len(b)*100
        c = sum(r["close"] for r in b)/len(b)
        print(f"  {lo:>+5.2f}..{hi:>+5.2f} {len(b):>6} {d:>6.1f}% {c:>9.2f}")

    # value test: bet draws with strong shortening, at closing odds
    print("\nFlat-bet value test (stake 1u, paid at closing draw odds):")
    def roi(subset, label):
        if not subset: return
        staked = len(subset)
        ret = sum(r["close"] for r in subset if r["drew"] and r["close"])
        r = (ret - staked)/staked*100
        hit = sum(r["drew"] for r in subset)/len(subset)*100
        print(f"  {label:40s} n={staked:>5}  hit={hit:>5.1f}%  ROI={r:+.1f}%")

    roi(rows, "ALL draws (baseline)")
    roi([r for r in rows if r["drift"] <= -0.2], "drift <= -0.20 (strong shortening)")
    roi([r for r in rows if r["drift"] <= -0.3], "drift <= -0.30")
    roi([r for r in rows if r["drift"] >= 0.2], "drift >= +0.20 (lengthening)")
    # shortening AND reasonably-priced
    roi([r for r in rows if r["drift"] <= -0.2 and 3.0 <= r["close"] <= 4.5], "drift<=-0.2 AND close 3.0-4.5")

if __name__ == "__main__":
    main()
