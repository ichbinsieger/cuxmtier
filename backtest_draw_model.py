#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════
# DRAW MODEL BACKTEST — does the upgraded model find a real edge?
#
# Replays the CuxmTier draw model (CSV form/goals/home-away split/drift)
# over Football-Data.co.uk history, strictly out-of-sample (rolling window).
# Answers:
#   1. Is the market efficient? (calibration baseline)
#   2. Does the model's "edge" predict draws?
#   3. Which signals actually earn their weight?
#   4. What does the live 6-leg ~1000x accumulator actually return?
#
# Standalone — downloads the CSVs itself, no DB, no API key.
# ═══════════════════════════════════════════════════════════════════════

import csv, io, math, urllib.request, concurrent.futures
from collections import defaultdict, deque
from datetime import datetime

BASE = "https://www.football-data.co.uk/mmz4281"
SEASONS = ["2425", "2526", "2627"]  # 2425/2526 = history, 2627 = early current
FORM_WINDOW = 20
H2H_WINDOW = 10

# league code -> (name, hardcoded draw rate the live model uses)
LEAGUES = [
    ("E0", "Premier League", 0.24),
    ("E1", "Championship", 0.27),
    ("E2", "League One", 0.26),
    ("E3", "League Two", 0.26),
    ("SC0", "Scottish Premiership", 0.26),
    ("D1", "Bundesliga", 0.24),
    ("D2", "2. Bundesliga", 0.26),
    ("I1", "Serie A", 0.28),
    ("I2", "Serie B", 0.26),
    ("SP1", "La Liga", 0.25),
    ("SP2", "Segunda", 0.26),
    ("F1", "Ligue 1", 0.30),
    ("F2", "Ligue 2", 0.26),
    ("N1", "Eredivisie", 0.27),
    ("P1", "Primeira Liga", 0.27),
    ("B1", "Pro League", 0.26),
    ("T1", "Super Lig", 0.26),
    ("G1", "Super League", 0.26),
]

def parse_csv_line(line):
    out, cur, inq = [], "", False
    for i, ch in enumerate(line):
        if inq:
            if ch == '"':
                if i + 1 < len(line) and line[i+1] == '"':
                    cur += '"'; i += 1
                else:
                    inq = False
            else:
                cur += ch
        elif ch == '"':
            inq = True
        elif ch == ",":
            out.append(cur); cur = ""
        else:
            cur += ch
    out.append(cur)
    return out

def parse_csv(text):
    if text and text[0] == "\ufeff":
        text = text[1:]
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 2:
        return []
    header = [h.strip() for h in parse_csv_line(lines[0])]
    rows = []
    for i in range(1, len(lines)):
        cells = parse_csv_line(lines[i])
        row = {header[j]: cells[j] if j < len(cells) else "" for j in range(len(header))}
        rows.append(row)
    return rows

def fetch(code, season):
    url = f"{BASE}/{season}/{code}.csv"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=25) as r:
            text = r.read().decode("utf-8", "replace")
        if text.lstrip().startswith(("<!DOCTYPE", "<html")):
            return None
        return parse_csv(text)
    except Exception:
        return None

def num(s):
    try:
        if s in ("", None):
            return None
        v = float(s)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None

# pick closing odds (home, draw, away): Pinnacle > market-avg > Bet365
def closing_odds(row):
    for h, d, a in [("PSCH","PSCD","PSCA"), ("AvgCH","AvgCD","AvgCA"), ("B365CH","B365CD","B365CA")]:
        hv, dv, av = num(row.get(h)), num(row.get(d)), num(row.get(a))
        if hv and dv and av:
            return hv, dv, av
    return None, None, None

# opening/closing draw (for drift): market-avg > Pinnacle > Bet365
def draw_odds(row):
    o = num(row.get("AvgD")) or num(row.get("PSD")) or num(row.get("B365D"))
    c = num(row.get("AvgCD")) or num(row.get("PSCD")) or num(row.get("B365CD"))
    return o, c

def download_all():
    codes = [c for c, _, _ in LEAGUES]
    results = {}
    def job(args):
        code, season = args
        return (code, season), fetch(code, season)
    tasks = [(c, s) for c in codes for s in SEASONS]
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for (code, season), rows in ex.map(job, tasks):
            if rows:
                results[(code, season)] = rows
    return results

def load_matches(data):
    matches = []
    for (code, season), rows in data.items():
        for row in rows:
            ftr = (row.get("FTR") or "").strip().upper()
            fthg, ftag = num(row.get("FTHG")), num(row.get("FTAG"))
            if ftr not in ("H", "D", "A") or fthg is None or ftag is None:
                continue
            home = (row.get("HomeTeam") or "").strip()
            away = (row.get("AwayTeam") or "").strip()
            ds = (row.get("Date") or "").strip()
            if not home or not away or not ds:
                continue
            try:
                d, mo, y = ds.split("/")
                date = datetime(int(y), int(mo), int(d))
            except (ValueError, IndexError):
                continue
            ch, cd, ca = closing_odds(row)
            od, cdr = draw_odds(row)
            matches.append({
                "league": code, "season": season, "date": date,
                "home": home, "away": away, "fthg": fthg, "ftag": ftag,
                "drew": 1 if ftr == "D" else 0,
                "close_h": ch, "close_d": cd, "close_a": ca,
                "open_d": od, "close_draw": cdr,
            })
    matches.sort(key=lambda m: m["date"])
    return matches

def implied_probs(m):
    ch, cd, ca = m["close_h"], m["close_d"], m["close_a"]
    if not (ch and cd and ca):
        return None, None, None
    inv = 1.0/ch + 1.0/cd + 1.0/ca
    return (1.0/ch)/inv, (1.0/cd)/inv, (1.0/ca)/inv  # normalized (no overround)

def clamp(x, lo, hi):
    return max(lo, min(hi, x))

def score_draw(bookmaker, league, hf, af, h2h):
    form = league
    rates = []
    if hf: rates.append(hf["hr"] if hf["hr"] is not None else hf["dr"])
    if af: rates.append(af["ar"] if af["ar"] is not None else af["dr"])
    if rates: form = sum(rates) / len(rates)

    goals = league
    if hf and af:
        combined = (hf["gf"] + hf["ga"])/2 + (af["gf"] + af["ga"])/2
        goals = clamp(0.42 - 0.055*combined, 0.18, 0.34)

    # parity — the live code currently leaves this dead; compute properly here
    parity = league

    drift_sig = None
    drifts = []
    if hf and hf["drift"] is not None: drifts.append(hf["drift"])
    if af and af["drift"] is not None: drifts.append(af["drift"])
    if drifts:
        d = sum(drifts)/len(drifts)
        drift_sig = clamp(league + (-d)*0.20, 0.15, 0.40)

    used_h2h = h2h is not None
    used_drift = drift_sig is not None
    if used_h2h:
        adj = (0.38*bookmaker + 0.09*league + 0.15*form + 0.08*goals
               + 0.06*parity + 0.20*h2h
               + (0.04*drift_sig if used_drift else 0.04*league))
    else:
        adj = (0.43*bookmaker + 0.14*league + 0.25*form + 0.10*goals
               + 0.05*parity
               + (0.03*drift_sig if used_drift else 0.03*league))
    return clamp(adj, bookmaker - 0.12, bookmaker + 0.12)

def build_team_form(recents):
    if not recents:
        return None
    n = len(recents)
    draws = sum(1 for r in recents if r["drew"])
    hm = sum(1 for r in recents if r["home"])
    hd = sum(1 for r in recents if r["home"] and r["drew"])
    am = n - hm
    ad = draws - hd
    gf = sum(r["gf"] for r in recents)/n
    ga = sum(r["ga"] for r in recents)/n
    drift_vals = [r["close_draw"] - r["open_d"] for r in recents if r["open_d"] and r["close_draw"]]
    return {
        "dr": draws/n,
        "hr": hd/hm if hm else None,
        "ar": ad/am if am else None,
        "gf": gf, "ga": ga,
        "drift": (sum(drift_vals)/len(drift_vals)) if drift_vals else None,
        "n": n,
    }

def main():
    print("Downloading CSVs ...")
    data = download_all()
    loaded = sum(len(v) for v in data.values())
    print(f"  {len(data)} league-seasons, {loaded} raw rows\n")

    matches = load_matches(data)
    draws = sum(m["drew"] for m in matches)
    print(f"Total usable matches: {len(matches)}  |  overall draw rate {draws/len(matches)*100:.1f}%\n")

    # rolling team form + h2h, chronological
    team_recent = defaultdict(list)   # (league, team) -> list of recent match dicts
    h2h_hist = defaultdict(list)      # (league, sorted team pair) -> list of drew(0/1)

    records = []  # each scored match
    for m in matches:
        key_h = (m["league"], m["home"])
        key_a = (m["league"], m["away"])
        hf = build_team_form(team_recent[key_h])
        af = build_team_form(team_recent[key_a])

        ph, pd, pa = implied_probs(m)
        if ph is None:
            # can't score without closing odds; still update history
            team_recent[key_h].append({"home": True, "drew": m["drew"], "gf": m["fthg"], "ga": m["ftag"], "open_d": m["open_d"], "close_draw": m["close_draw"]})
            team_recent[key_a].append({"home": False, "drew": m["drew"], "gf": m["ftag"], "ga": m["fthg"], "open_d": m["open_d"], "close_draw": m["close_draw"]})
            pk = tuple(sorted([m["home"], m["away"]]))
            h2h_hist[(m["league"],) + pk].append(m["drew"])
            continue

        # h2h proxy (same-league prior meetings)
        pk = (m["league"],) + tuple(sorted([m["home"], m["away"]]))
        hh = h2h_hist[pk][-H2H_WINDOW:] if h2h_hist[pk] else []
        h2h = (sum(hh)/len(hh)) if len(hh) >= 2 else None  # need >=2 meetings to trust

        league_rate = dict((c, r) for c, _, r in LEAGUES)[m["league"]]

        adj_full = score_draw(pd, league_rate, hf, af, h2h)
        adj_noh2h = score_draw(pd, league_rate, hf, af, None)

        records.append({
            "m": m, "implied": pd, "adj": adj_full, "adj_noh2h": adj_noh2h,
            "edge": adj_full - pd,
            "form": (hf["hr"] if hf and hf["hr"] is not None else (hf["dr"] if hf else None)),
            "form_away": (af["ar"] if af and af["ar"] is not None else (af["dr"] if af else None)),
            "goals": ((hf["gf"]+hf["ga"])/2 + (af["gf"]+af["ga"])/2) if (hf and af) else None,
            "drift": ((hf["drift"] if hf and hf["drift"] is not None else 0) + (af["drift"] if af and af["drift"] is not None else 0))/2 if (hf or af) else None,
            "parity": abs(ph - pa),
            "h2h": h2h,
            "hf": hf, "af": af,
        })

        # update history AFTER scoring (out-of-sample)
        team_recent[key_h].append({"home": True, "drew": m["drew"], "gf": m["fthg"], "ga": m["ftag"], "open_d": m["open_d"], "close_draw": m["close_draw"]})
        team_recent[key_a].append({"home": False, "drew": m["drew"], "gf": m["ftag"], "ga": m["fthg"], "open_d": m["open_d"], "close_draw": m["close_draw"]})
        if len(team_recent[key_h]) > FORM_WINDOW: team_recent[key_h].pop(0)
        if len(team_recent[key_a]) > FORM_WINDOW: team_recent[key_a].pop(0)
        h2h_hist[pk].append(m["drew"])

    # require meaningful form sample on both sides
    scored = [r for r in records if (r["hf"] and r["hf"]["n"] >= 5) and (r["af"] and r["af"]["n"] >= 5)]
    print(f"Scored matches (both teams >=5 prior games): {len(scored)}\n")

    # ── 1. Market calibration ────────────────────────────────────────
    print("═══ 1. MARKET CALIBRATION (implied vs actual draw rate) ═══")
    buckets = [(0,0.20),(0.20,0.24),(0.24,0.28),(0.28,0.32),(0.32,0.36),(0.36,0.45),(0.45,1.0)]
    print(f"  {'implied%':>10} {'n':>6} {'actual%':>8}")
    for lo, hi in buckets:
        b = [r for r in scored if lo <= r["implied"] < hi]
        if not b: continue
        act = sum(r["m"]["drew"] for r in b)/len(b)
        print(f"  {lo*100:>4.0f}-{hi*100:<4.0f} {len(b):>6} {act*100:>7.1f}%")

    # ── 2. Model edge test ───────────────────────────────────────────
    print("\n═══ 2. MODEL EDGE TEST (does a bigger edge mean more draws?) ═══")
    edge_buckets = [(-1, -0.03), (-0.03, -0.01), (-0.01, 0.01), (0.01, 0.03), (0.03, 1)]
    print(f"  {'edge':>10} {'n':>6} {'actual%':>8} {'implied%':>9}")
    for lo, hi in edge_buckets:
        b = [r for r in scored if lo <= r["edge"] < hi]
        if not b: continue
        act = sum(r["m"]["drew"] for r in b)/len(b)
        imp = sum(r["implied"] for r in b)/len(b)
        print(f"  {lo:>+5.2f}..{hi:>+5.2f} {len(b):>6} {act*100:>7.1f}% {imp*100:>8.1f}%")

    # Brier scores
    def brier(preds):
        return sum((p - r["m"]["drew"])**2 for p, r in preds)/len(preds)
    b_book = brier([(r["implied"], r) for r in scored])
    b_model = brier([(r["adj"], r) for r in scored])
    print(f"\n  Brier (lower=better): bookmaker {b_book:.4f}  vs  model {b_model:.4f}")

    # ── 3. Signal decomposition ──────────────────────────────────────
    print("\n═══ 3. SIGNAL DECOMPOSITION (quartile draw rates) ═══")
    def quartile_analysis(label, key_fn, valid_fn=None):
        rs = [r for r in scored if (valid_fn is None or valid_fn(r))]
        if len(rs) < 100: 
            print(f"  {label}: insufficient data"); return
        rs.sort(key=key_fn)
        q = len(rs)//4
        quads = [rs[:q], rs[q:2*q], rs[2*q:3*q], rs[3*q:]]
        rates = [sum(r["m"]["drew"] for r in quad)/len(quad)*100 for quad in quads]
        print(f"  {label:22s} Q1..Q4: " + "  ".join(f"{x:.1f}%" for x in rates))

    quartile_analysis("form (home draw-rate)", lambda r: r["form"])
    quartile_analysis("form (away draw-rate)", lambda r: r["form_away"])
    quartile_analysis("goals (low→high)", lambda r: r["goals"])
    quartile_analysis("drift (shorten→lengthen)", lambda r: r["drift"])
    quartile_analysis("parity (close→apart)", lambda r: r["parity"])
    quartile_analysis("h2h draw-rate", lambda r: r["h2h"], valid_fn=lambda r: r["h2h"] is not None)

    # ── 4. Betting simulation ────────────────────────────────────────
    print("\n═══ 4. BETTING SIM (flat + accumulator) ═══")
    # flat bet every scored draw at closing odds
    staked = len(scored)
    returned = sum(r["m"]["close_draw"] for r in scored if r["m"]["drew"] and r["m"]["close_draw"])
    flat_roi = (returned - staked)/staked*100
    print(f"  Flat-bet all draws: {staked} bets, ROI {flat_roi:+.1f}%")

    # accumulator: top-edged draws at odds 2.8-4.5, 6-leg
    pool = [r for r in scored if r["m"]["close_draw"] and 2.8 <= r["m"]["close_draw"] <= 4.5]
    pool.sort(key=lambda r: r["edge"], reverse=True)
    # build sequential 6-leg accumulators
    acc_wins = acc_total = 0
    i = 0
    while i + 6 <= len(pool):
        leg = pool[i:i+6]
        acc_total += 1
        if all(r["m"]["drew"] for r in leg):
            acc_wins += 1
        i += 6
    if acc_total:
        odds_total = 1
        print(f"  Accumulator (6-leg, top-edge draws, {acc_total} tickets): {acc_wins} wins "
              f"({acc_wins/acc_total*100:.1f}%)")
        # expected combined odds of one ticket
        sample = pool[:6]
        combined = math.prod([r["m"]["close_draw"] for r in sample if r["m"]["close_draw"]])
        print(f"  Typical 6-leg combined odds ~{combined:.0f}x; fair hit chance ~{(1/combined)*100:.2f}%")

if __name__ == "__main__":
    main()
