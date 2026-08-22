#!/usr/bin/env python3
"""
CuxmTier Code Tracker
- save_codes: fetch recommendations from CuxmTier API, save to local JSON store
- check_results: read stored codes, check each via SportyBet share API, report wins/losses

Usage:
  python3 tracker.py save     # fetch and save current codes
  python3 tracker.py check    # check all stored codes for results
  python3 tracker.py report   # print summary of all tracked codes
"""

import json, os, sys, urllib.request
from datetime import datetime, timezone

STORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tracked_codes.json")
CUXMTIER_API = "https://cuxmtier.vercel.app/api/recommend"
SPORTYBET_SHARE = "https://www.sportybet.com/api/ng/orders/share"


def load_store():
    if os.path.exists(STORE_PATH):
        with open(STORE_PATH, "r") as f:
            return json.load(f)
    return {"codes": [], "last_save": None, "last_check": None}


def save_store(data):
    with open(STORE_PATH, "w") as f:
        json.dump(data, f, indent=2)


def fetch_codes():
    """Fetch current recommendations from CuxmTier"""
    req = urllib.request.Request(CUXMTIER_API, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    return data.get("slips", [])


def save_codes():
    """Fetch and store current codes"""
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M')}] Fetching codes from CuxmTier...")
    try:
        slips = fetch_codes()
    except Exception as e:
        print(f"  ERROR fetching: {e}")
        return

    store = load_store()
    now = datetime.now(timezone.utc).isoformat()
    saved_count = 0

    for slip in slips:
        code = slip["code"]
        # Skip if code already stored today
        already_stored = any(
            c["code"] == code and c["date_saved"][:10] == now[:10]
            for c in store["codes"]
        )
        if already_stored:
            print(f"  {code} ({slip['targetOdds']}x) — already stored today, skipping")
            continue

        entry = {
            "code": code,
            "target": slip["targetOdds"],
            "actual_odds": slip["actualOdds"],
            "date_saved": now,
            "picks": [
                {
                    "homeTeam": p["homeTeam"],
                    "awayTeam": p["awayTeam"],
                    "tournament": p["tournament"],
                    "marketDesc": p["marketDesc"],
                    "pickDesc": p["pickDesc"],
                    "odds": p["odds"],
                    "safetyScore": p["safetyScore"],
                    "eventId": p["eventId"],
                    "marketId": p["marketId"],
                    "outcomeId": p["outcomeId"],
                    "specifier": p.get("specifier"),
                    "productId": p.get("productId"),
                    "sportId": p.get("sportId"),
                }
                for p in slip["picks"]
            ],
            "result": None,  # to be filled by check_results
        }
        store["codes"].append(entry)
        saved_count += 1
        print(f"  ✓ Saved {code} ({slip['targetOdds']}x) — {len(slip['picks'])} games")

    store["last_save"] = now
    save_store(store)
    print(f"  Done. {saved_count} new codes saved. Total tracked: {len(store['codes'])}")


def check_code(code_entry):
    """Check a single code against SportyBet share API"""
    code = code_entry["code"]
    try:
        req = urllib.request.Request(
            f"{SPORTYBET_SHARE}/{code}",
            headers={"User-Agent": "Mozilla/5.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())

        if data.get("bizCode") != 10000:
            return {"status": "invalid", "error": data.get("message", "Unknown")}

        outcomes = data["data"]["outcomes"]
        selections = data["data"]["ticket"]["selections"]
        picks_result = []
        won = 0
        lost = 0
        pending = 0

        for o, s, p in zip(outcomes, selections, code_entry["picks"]):
            name = f"{o['homeTeamName']} vs {o['awayTeamName']}"
            status = o.get("matchStatus", "?")

            if status not in ("Ended", "Closed", "Settled"):
                pending += 1
                picks_result.append({
                    "match": name,
                    "pick": p["pickDesc"],
                    "market": p["marketDesc"],
                    "odds": p["odds"],
                    "result": "pending",
                    "status": status,
                })
                continue

            # Find the selected outcome
            is_winning = None
            game_score = o.get("gameScore", "?")
            for mkt in o.get("markets", []):
                if mkt.get("id") != s.get("marketId"):
                    continue
                spec_match = (mkt.get("specifier") or None) == (s.get("specifier") or None)
                if not spec_match:
                    continue
                for out in mkt.get("outcomes", []):
                    if out.get("id") == s.get("outcomeId"):
                        is_winning = out.get("isWinning", False)
                        break
                break

            if is_winning is None:
                # Couldn't match the outcome — treat as pending
                pending += 1
                picks_result.append({
                    "match": name,
                    "pick": p["pickDesc"],
                    "market": p["marketDesc"],
                    "odds": p["odds"],
                    "result": "unknown",
                })
            elif is_winning:
                won += 1
                picks_result.append({
                    "match": name,
                    "pick": p["pickDesc"],
                    "market": p["marketDesc"],
                    "odds": p["odds"],
                    "result": "won",
                    "score": str(game_score),
                })
            else:
                lost += 1
                picks_result.append({
                    "match": name,
                    "pick": p["pickDesc"],
                    "market": p["marketDesc"],
                    "odds": p["odds"],
                    "result": "lost",
                    "score": str(game_score),
                })

        total_resolved = won + lost
        slip_won = lost == 0 and total_resolved == len(code_entry["picks"])

        return {
            "status": "checked",
            "won": won,
            "lost": lost,
            "pending": pending,
            "total": len(code_entry["picks"]),
            "slip_won": slip_won,
            "picks": picks_result,
        }

    except Exception as e:
        return {"status": "error", "error": str(e)}


def check_results():
    """Check all stored codes for results"""
    store = load_store()
    now = datetime.now(timezone.utc).isoformat()

    if not store["codes"]:
        print("No codes to check.")
        return

    unchecked = [c for c in store["codes"] if c.get("result") is None]
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M')}] Checking {len(unchecked)} codes...")

    updated = 0
    for entry in store["codes"]:
        if entry.get("result") is not None:
            continue

        result = check_code(entry)
        entry["result"] = result
        entry["last_checked"] = now
        updated += 1

        if result["status"] == "checked":
            resolved = result["won"] + result["lost"]
            if resolved == result["total"]:
                status = "✓ WON" if result["slip_won"] else "✗ LOST"
            else:
                status = f"⏳ {resolved}/{result['total']} resolved"
            print(f"  {entry['code']} ({entry['target']}x): {status} — {result['won']}W/{result['lost']}L/{result['pending']}P")
        else:
            print(f"  {entry['code']} ({entry['target']}x): {result['status']} — {result.get('error', '')}")

    store["last_check"] = now
    save_store(store)
    print(f"  Done. {updated} codes checked.")


def print_report():
    """Print summary of all tracked codes"""
    store = load_store()

    if not store["codes"]:
        print("No codes tracked yet.")
        return

    total = len(store["codes"])
    resolved = [c for c in store["codes"] if c.get("result") and c["result"].get("status") == "checked"
                and (c["result"]["won"] + c["result"]["lost"]) == c["result"]["total"]]
    won_slips = [c for c in resolved if c["result"]["slip_won"]]
    lost_slips = [c for c in resolved if not c["result"]["slip_won"]]
    pending = [c for c in store["codes"] if not c.get("result") or c["result"].get("status") != "checked"
               or (c["result"]["won"] + c["result"]["lost"]) < c["result"]["total"]]

    print("=" * 60)
    print("CUXMTIER CODE TRACKER — REPORT")
    print("=" * 60)
    print(f"Total codes tracked: {total}")
    print(f"Resolved: {len(resolved)} | Won: {len(won_slips)} | Lost: {len(lost_slips)} | Pending: {len(pending)}")
    print(f"Win rate (resolved): {len(won_slips)/len(resolved)*100:.1f}%" if resolved else "Win rate: N/A")

    print(f"\nLast save: {store.get('last_save', 'Never')}")
    print(f"Last check: {store.get('last_check', 'Never')}")

    # Show all codes
    print(f"\n{'─'*60}")
    for c in store["codes"]:
        r = c.get("result")
        if r and r.get("status") == "checked":
            resolved_count = r["won"] + r["lost"]
            if resolved_count == r["total"]:
                icon = "✓" if r["slip_won"] else "✗"
            else:
                icon = "⏳"
            print(f"  {icon} {c['code']} ({c['target']}x) — {r['won']}W/{r['lost']}L/{r['pending']}P — {c['date_saved'][:16]}")
        else:
            print(f"  ⏳ {c['code']} ({c['target']}x) — unchecked — {c['date_saved'][:16]}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 tracker.py [save|check|report]")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    if cmd == "save":
        save_codes()
    elif cmd == "check":
        check_results()
    elif cmd == "report":
        print_report()
    else:
        print(f"Unknown command: {cmd}")
        print("Usage: python3 tracker.py [save|check|report]")
