"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";

interface BestAlt {
  marketDesc: string; pickDesc: string; odds: number;
  sigma: number; riskScore: number; riskReasons: string[]; safeReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
}

interface Selection {
  homeTeam: string; awayTeam: string; tournament: string;
  marketDesc: string; pickDesc: string; odds: number;
  probability: number; matchStatus: string;
  riskScore: number; riskReasons: string[]; safeReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
  sigma: number; failProb: number;
  kellyFraction: number; kellyLabel: string;
  evPercent: number;
  adjustedProbability: number;
  priorUsed: { leaguePattern: string; historicalHitRate: number; sampleSize: string } | null;
  bestAlternative: BestAlt | null;
}

interface SavedPick {
  homeTeam: string; awayTeam: string;
  pickDesc: string; odds: number; marketDesc: string;
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
  matchStatus?: string;
  result?: "won" | "lost" | "pending" | "unknown";
}

interface HistoryEntry {
  code: string;
  timestamp: number;
  selections: number;
  targetOdds?: number;
  actualOdds?: number;
  avgEv: number;
  avgRisk: number;
  type: "analyzed" | "generated" | "draw";
  kind?: string;
  parentCode?: string;
  picks: SavedPick[];
  checkedAt?: number;
}

const selKey = (s: Selection) => `${s.eventId}|${s.marketId}|${s.outcomeId}`;

type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";
function riskLevel(score: number): RiskLevel {
  if (score <= 14) return "safe"; if (score <= 20) return "low";
  if (score <= 26) return "medium"; if (score <= 33) return "high";
  return "critical";
}
const riskMeta: Record<RiskLevel, { label: string; dot: string; text: string }> = {
  safe: { label: "Safe", dot: "bg-emerald-400", text: "text-emerald-400" },
  low: { label: "Low", dot: "bg-lime-400", text: "text-lime-400" },
  medium: { label: "Med", dot: "bg-amber-400", text: "text-amber-400" },
  high: { label: "Risky", dot: "bg-orange-400", text: "text-orange-400" },
  critical: { label: "Avoid", dot: "bg-red-400", text: "text-red-400" },
};

function evColor(ev: number) {
  if (ev > 15) return "text-emerald-400";
  if (ev > 5) return "text-lime-400";
  if (ev > 0) return "text-lime-400/60";
  if (ev > -10) return "text-amber-400";
  if (ev > -25) return "text-orange-400";
  return "text-red-400";
}

interface RecommendedPick {
  eventId: string; marketId: string; outcomeId: string;
  specifier?: string; productId: number; sportId: string;
  homeTeam: string; awayTeam: string; tournament: string;
  marketDesc: string; pickDesc: string; odds: number;
  probability: number; safetyScore: number;
}

const SPORT_EMOJI: Record<string, string> = {
  "sr:sport:1": "⚽",
  "sr:sport:2": "🏀",
  "sr:sport:5": "🎾",
  "sr:sport:4": "🏒",
  "sr:sport:21": "🏏",
  "sr:sport:23": "🏐",
  "sr:sport:20": "🏓",
  "sr:sport:31": "🏸",
  "sr:sport:202120001": "🎮",
};

function sportEmoji(sportId: string): string {
  return SPORT_EMOJI[sportId] || "";
}

interface RecommendedSlip {
  targetOdds: number;
  actualOdds: number;
  code: string;
  picks: RecommendedPick[];
}

const HISTORY_KEY = "cuxmtier_history";

function loadHistory(): HistoryEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return raw.map((e: any) => ({
      ...e,
      type: e.type || "analyzed",
      picks: e.picks || [],
      parentCode: e.parentCode || undefined,
    }));
  } catch { return []; }
}
function saveHistory(entries: HistoryEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 20)));
}

export default function Home() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<any>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [resultCode, setResultCode] = useState("");
  const [portfolioBefore, setPortfolioBefore] = useState(0);
  const [portfolioAfter, setPortfolioAfter] = useState(0);
  const [failBefore, setFailBefore] = useState(0);
  const [failAfter, setFailAfter] = useState(0);
  const [copied, setCopied] = useState("");
  const [shrinkN, setShrinkN] = useState(0);
  const [swappedMap, setSwappedMap] = useState<Map<string, Selection["bestAlternative"]>>(new Map());
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showSlipHistory, setShowSlipHistory] = useState(false);
  const [recommendations, setRecommendations] = useState<RecommendedSlip[]>([]);
  const [drawSlip, setDrawSlip] = useState<RecommendedSlip | null>(null);
  const [recsLoading, setRecsLoading] = useState(true);
  const [recsError, setRecsError] = useState("");
  const [recResults, setRecResults] = useState<Record<string, { won: number; lost: number; pending: number; picks: Array<{ result: "won" | "lost" | "pending" }> }>>({});
  const [checkingResults, setCheckingResults] = useState(false);
  const [resultsPage, setResultsPage] = useState(0);
  const RESULTS_PER_PAGE = 10;
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [dbHistory, setDbHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => { setHistory(loadHistory()); }, []);

  // Fetch recommendations + persisted results from the server (DB-backed)
  useEffect(() => {
    let cancelled = false;
    async function loadRecs() {
      try {
        const r = await fetch("/api/recommend");
        const d = await r.json();
        if (!cancelled) {
          if (r.ok && d.slips) {
            setRecommendations(d.slips);
            setDrawSlip(d.draw || null);
            setRecResults(d.results || {});
            const hist: HistoryEntry[] = (d.history || []).map((h: any) => ({
              code: h.code,
              kind: h.kind,
              timestamp: h.timestamp,
              selections: h.selections,
              targetOdds: h.targetOdds,
              actualOdds: h.actualOdds,
              avgEv: h.avgEv ?? 0,
              avgRisk: h.avgRisk ?? 0,
              type: h.kind === "draw" ? "draw" : "generated",
              picks: (h.picks || []).map((p: any) => ({
                homeTeam: p.homeTeam || "", awayTeam: p.awayTeam || "",
                pickDesc: p.pickDesc || "", odds: p.odds || 0, marketDesc: p.marketDesc || "",
                eventId: p.eventId || "", marketId: p.marketId || "", outcomeId: p.outcomeId || "",
                specifierRaw: p.specifier, productId: p.productId || 0, sportId: p.sportId || "",
                matchStatus: p.matchStatus,
                result: p.result || "pending",
              })),
              checkedAt: h.checkedAt,
            }));
            setDbHistory(hist);
          }
          else if (d.error) setRecsError(d.error);
        }
      } catch (e: any) { if (!cancelled) setRecsError(e.message); }
      finally { if (!cancelled) setRecsLoading(false); }
    }
    loadRecs();
    return () => { cancelled = true; };
  }, []);

  // Auto-check recommendation results (safe + draw)
  const checkRecResults = async () => {
    const slips = drawSlip ? [...recommendations, drawSlip] : recommendations;
    if (checkingResults || slips.length === 0) return;
    setCheckingResults(true);
    const results: typeof recResults = {};
    for (const slip of slips) {
      try {
        const r = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: slip.code, action: "check" }),
        });
        const d = await r.json();
        if (!r.ok || !d.results) continue;

        let won = 0, lost = 0, pending = 0;
        const picks: Array<{ result: "won" | "lost" | "pending" }> = [];

        for (const pick of slip.picks) {
          const marketResult = d.results.find((mr: any) =>
            mr.marketId === pick.marketId &&
            (mr.specifier || undefined) === (pick.specifier || undefined) &&
            mr.picks
          );
          if (!marketResult) { pending++; picks.push({ result: "pending" }); continue; }

          const status = marketResult.matchStatus;
          if (status !== "Ended" && status !== "Closed" && status !== "Settled") {
            pending++; picks.push({ result: "pending" }); continue;
          }

          const winnerPick = marketResult.picks.find((p: any) => p.id === pick.outcomeId);
          if (winnerPick?.isWinner) { won++; picks.push({ result: "won" }); }
          else { lost++; picks.push({ result: "lost" }); }
        }
        results[slip.code] = { won, lost, pending, picks };
      } catch { /* skip failed checks */ }
    }
    setRecResults(results);
    setCheckingResults(false);
  };

  // Check ALL history entries (generated + analyzed) — only mark "checked" when fully resolved
  const checkAllHistory = async () => {
    const entries = loadHistory();
    let changed = false;
    for (const entry of entries) {
      const hasUnresolved = entry.picks.some(p => !p.result || p.result === "pending" || p.result === "unknown");
      if (entry.checkedAt && !hasUnresolved) continue;
      try {
        const r = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: entry.code, action: "check" }),
        });
        const d = await r.json();
        if (!r.ok || !d.results) continue;

        const updatedPicks = entry.picks.map(pick => {
          const marketResult = d.results.find((mr: any) =>
            mr.marketId === pick.marketId &&
            (mr.specifier || undefined) === (pick.specifierRaw || undefined) &&
            mr.picks
          );
          if (!marketResult) return { ...pick, result: "unknown" as const };
          const status = marketResult.matchStatus;
          if (status !== "Ended" && status !== "Closed" && status !== "Settled")
            return { ...pick, matchStatus: status, result: "pending" as const };
          const wp = marketResult.picks.find((p: any) => p.id === pick.outcomeId);
          return { ...pick, matchStatus: status, result: (wp?.isWinner ? "won" : "lost") as "won" | "lost" };
        });
        entry.picks = updatedPicks;
        const allResolved = updatedPicks.every(p => p.result === "won" || p.result === "lost");
        if (allResolved) entry.checkedAt = Date.now();
        changed = true;
      } catch { /* skip */ }
    }
    if (changed) {
      saveHistory(entries);
      setHistory(entries);
    }
  };

  useEffect(() => {
    checkAllHistory();
  }, []);

  const all: Selection[] = data?.selections || [];
  const removedList = all.filter(s => removedIds.has(selKey(s)));
  const keptList = all.filter(s => !removedIds.has(selKey(s)));

  const reset = () => {
    setData(null); setRemovedIds(new Set()); setResultCode(""); setPortfolioAfter(0); setFailAfter(0); setShrinkN(0); setSwappedMap(new Map());
  };

  const swapToBest = (s: Selection) => {
    if (!s.bestAlternative) return;
    setSwappedMap(prev => {
      const next = new Map(prev);
      next.set(selKey(s), s.bestAlternative);
      return next;
    });
    setResultCode("");
  };

  const analyze = async () => {
    if (!code.trim() || loading) return;
    setLoading(true); setError(""); reset();
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "analyze" }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setData(d);
      setPortfolioBefore(d.portfolioVol);
      setFailBefore(d.failureProbability);
      const c = code.trim().toUpperCase();
      const entries = loadHistory();
      const existing = entries.findIndex(e => e.code === c);
      const picks: SavedPick[] = (d.selections || []).map((s: any) => ({
        homeTeam: s.homeTeam, awayTeam: s.awayTeam,
        pickDesc: s.pickDesc, odds: s.odds, marketDesc: s.marketDesc,
        eventId: s.eventId, marketId: s.marketId, outcomeId: s.outcomeId,
        specifierRaw: s.specifierRaw, productId: s.productId, sportId: s.sportId,
        matchStatus: s.matchStatus,
      }));
      const entry: HistoryEntry = {
        code: c, timestamp: Date.now(),
        selections: d.totalSelections,
        avgEv: d.selections ? Math.round(d.selections.reduce((s: number, x: any) => s + x.evPercent, 0) / d.selections.length) : 0,
        avgRisk: d.averageRisk,
        type: "analyzed",
        picks,
      };
      if (existing >= 0) entries[existing] = entry;
      else entries.unshift(entry);
      saveHistory(entries);
      setHistory(entries);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const doShrink = async (n: number) => {
    if (!code.trim() || loading) return;
    setLoading(true); setError("");
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "shrink", count: n }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setRemovedIds(new Set(d.removed.map((s: any) => `${s.eventId}|${s.marketId}|${s.outcomeId}`)));
      setResultCode(d.newCode);
      setPortfolioAfter(d.portfolioVolAfter);
      setFailAfter(d.failureProbAfter);
      setShrinkN(n);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const toggleRemove = (s: Selection) => {
    const key = selKey(s);
    setRemovedIds(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    setResultCode("");
  };

  const regenerateCode = async () => {
    if (!code.trim() || loading || keptList.length === 0) return;
    setLoading(true); setError("");
    try {
      const selections = keptList.map(s => {
        const key = selKey(s);
        const swapped = swappedMap.get(key);
        if (swapped) {
          return {
            eventId: swapped.eventId, marketId: swapped.marketId,
            outcomeId: swapped.outcomeId, specifier: swapped.specifierRaw,
            productId: swapped.productId, sportId: swapped.sportId,
          };
        }
        return {
          eventId: s.eventId, marketId: s.marketId,
          outcomeId: s.outcomeId, specifier: s.specifierRaw,
          productId: s.productId, sportId: s.sportId,
        };
      });
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "rebuild", selections }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setResultCode(d.newCode);
      setPortfolioAfter(d.portfolioVolAfter);
      setFailAfter(d.failureProbAfter);
      const entries = loadHistory();
      const genPicks: SavedPick[] = keptList.map(s => {
        const key = selKey(s);
        const sw = swappedMap.get(key);
        return {
          homeTeam: sw ? "" : s.homeTeam, awayTeam: sw ? "" : s.awayTeam,
          pickDesc: sw ? sw.pickDesc : s.pickDesc,
          odds: sw ? sw.odds : s.odds,
          marketDesc: sw ? sw.marketDesc : s.marketDesc,
          eventId: sw ? sw.eventId : s.eventId,
          marketId: sw ? sw.marketId : s.marketId,
          outcomeId: sw ? sw.outcomeId : s.outcomeId,
          specifierRaw: sw ? sw.specifierRaw : s.specifierRaw,
          productId: sw ? sw.productId : s.productId,
          sportId: sw ? sw.sportId : s.sportId,
        };
      });
      const genEntry: HistoryEntry = {
        code: d.newCode, timestamp: Date.now(),
        selections: genPicks.length,
        avgEv: keptList.reduce((s, x) => s + x.evPercent, 0) / keptList.length,
        avgRisk: Math.round(keptList.reduce((s, x) => s + x.riskScore, 0) / keptList.length),
        type: "generated", parentCode: code.trim().toUpperCase(),
        picks: genPicks,
      };
      const genIdx = entries.findIndex(e => e.code === d.newCode);
      if (genIdx >= 0) entries[genIdx] = genEntry;
      else entries.unshift(genEntry);
      saveHistory(entries);
      setHistory(entries);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const addSafe = async () => {
    if (!data || loading) return; setLoading(true);
    try {
      const c = resultCode || code.trim();
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: c, action: "add", count: 3 }) });
      const d = await r.json();
      if (r.ok) {
        const r2 = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: d.newCode, action: "analyze" }) });
        const d2 = await r2.json();
        if (r2.ok) { setData(d2); setCode(d.newCode); setRemovedIds(new Set()); setResultCode(""); setPortfolioBefore(d2.portfolioVol); setFailBefore(d2.failureProbability); }
      } else setError(d.error);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const checkResults = async (entry: HistoryEntry) => {
    setLoading(true);
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: entry.code, action: "check" }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      const updatedPicks: SavedPick[] = entry.picks.map(pick => {
        const match = d.results.find((mr: any) =>
          mr.marketId === pick.marketId &&
          (mr.specifier || undefined) === (pick.specifierRaw || undefined)
        );
        if (!match) return { ...pick, result: "unknown" as const };
        if (match.matchStatus === "Not start" || match.matchStatus === "Playing" || match.matchStatus === "Live") {
          return { ...pick, matchStatus: match.matchStatus, result: "pending" as const };
        }
        const winnerPick = match.picks.find((p: any) => p.id === pick.outcomeId);
        return { ...pick, matchStatus: match.matchStatus, result: (winnerPick?.isWinner ? "won" : "lost") as "won" | "lost" };
      });
      const entries = loadHistory();
      const idx = entries.findIndex(e => e.code === entry.code);
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], picks: updatedPicks, checkedAt: Date.now() };
        saveHistory(entries);
        setHistory(entries);
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const loadHistoryCode = (entry: HistoryEntry) => {
    setCode(entry.code);
  };

  const copy = (t: string) => { navigator.clipboard.writeText(t); setCopied(t); setTimeout(() => setCopied(""), 2000); };

  const volColor = (v: number) => v > 200 ? "text-red-400" : v > 100 ? "text-amber-400" : v > 50 ? "text-lime-400" : "text-emerald-400";
  const failColor = (f: number) => f > 80 ? "text-red-400" : f > 60 ? "text-amber-400" : f > 40 ? "text-lime-400" : "text-emerald-400";

  // Result summary for a slip
  const slipStatus = (res?: { won: number; lost: number; pending: number }, total?: number) => {
    if (!res) return { resolved: false, won: false, lost: false, pending: true };
    const resolvedAll = res.pending === 0;
    return {
      resolved: resolvedAll,
      won: resolvedAll && res.lost === 0,
      lost: resolvedAll && res.lost > 0,
      pending: !resolvedAll,
    };
  };

  return (
    <div className="min-h-screen bg-[#07070a] text-white font-sans relative overflow-x-hidden">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[500px] rounded-full bg-violet-600/[0.13] blur-[130px] animate-float" />
        <div className="absolute top-1/3 -left-40 w-[450px] h-[450px] rounded-full bg-emerald-500/[0.07] blur-[120px] animate-float [animation-delay:2s]" />
        <div className="absolute bottom-0 -right-40 w-[500px] h-[500px] rounded-full bg-amber-500/[0.06] blur-[130px] animate-float [animation-delay:4s]" />
        <div className="absolute inset-0 dot-grid opacity-40" />
      </div>

      <div className="relative z-10">
        {/* ── HERO ── */}
        <section className={`flex flex-col items-center justify-center px-4 sm:px-6 ${data ? "py-10 sm:py-14" : "min-h-screen"}`}>
          <div className="w-full max-w-xl mx-auto text-center">
            <div className="animate-fade-up [animation-delay:50ms]">
              <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.25em] text-violet-400/60 mb-5">
                <span className="w-4 h-px bg-violet-400/40" />
                EV-powered slip analysis
                <span className="w-4 h-px bg-violet-400/40" />
              </span>
            </div>
            <h1 className="animate-fade-up [animation-delay:150ms] text-4xl sm:text-5xl font-bold tracking-tight mb-4">
              Cuxm<span className="text-violet-400">Tier</span>
            </h1>
            <p className="animate-fade-up [animation-delay:250ms] text-sm text-white/35 max-w-md mx-auto mb-8 leading-relaxed">
              Analyze your SportyBet booking codes, strip the risky picks, and get a leaner slip — backed by MVE risk scoring and historical priors.
            </p>

            <div className="animate-fade-up [animation-delay:350ms] flex gap-2">
              <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && analyze()}
                placeholder="sportybet code"
                spellCheck={false}
                className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-2xl px-5 py-4 text-base font-mono tracking-[0.12em] text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.05] transition-all backdrop-blur" />
              <button onClick={analyze} disabled={loading || !code.trim()}
                className="shrink-0 px-7 py-4 bg-violet-600 text-white font-semibold rounded-2xl hover:bg-violet-500 disabled:opacity-25 disabled:cursor-not-allowed transition-all text-sm shadow-lg shadow-violet-600/20">
                {loading ? "..." : "Analyze"}
              </button>
              {data && <button onClick={reset} className="shrink-0 px-4 py-4 bg-white/[0.03] border border-white/[0.08] text-white/40 text-sm rounded-2xl hover:bg-white/[0.08] hover:text-white/70 transition-all">Reset</button>}
            </div>
            <div className="animate-fade-up [animation-delay:400ms] mt-4">
              <Link href="/alter" className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-emerald-600/10 border border-emerald-500/30 text-emerald-300 text-sm font-semibold hover:bg-emerald-600/20 transition-all">
                ✨ AlterMe <span className="text-emerald-300/50 font-normal">— auto-swap every pick to its best option</span>
              </Link>
            </div>
            {error && <p className="mt-3 text-red-400/70 text-sm">{error}</p>}
          </div>
        </section>

        {/* ── SLIP HISTORY (analyzed) ── */}
        {history.filter(h => h.type === "analyzed").length > 0 && (
          <section className="max-w-3xl mx-auto px-4 sm:px-6 mb-8">
            <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06]">
              <button onClick={() => setShowSlipHistory(!showSlipHistory)}
                className="w-full flex items-center justify-between mb-3">
                <h3 className="text-[11px] uppercase tracking-[0.15em] text-white/35">Slip History</h3>
                <span className="text-[11px] text-white/25">{showSlipHistory ? "▾" : "▸"}</span>
              </button>
              {showSlipHistory && (
                <div className="space-y-1.5">
                  {history.filter(h => h.type === "analyzed").slice(0, 15).map((h, i) => {
                    const wonCount = h.picks.filter(p => p.result === "won").length;
                    const lostCount = h.picks.filter(p => p.result === "lost").length;
                    const pendingCount = h.picks.filter(p => !p.result || p.result === "pending").length;
                    const hasResults = h.checkedAt || wonCount + lostCount > 0;
                    return (
                      <div key={i} className="flex items-center gap-2 px-3 py-2.5 rounded-xl hover:bg-white/[0.03] transition-all group">
                        <button onClick={() => loadHistoryCode(h)} className="flex-1 flex items-center justify-between text-left min-w-0">
                          <div className="min-w-0">
                            <span className="text-sm font-mono text-white/50 group-hover:text-white/70 truncate">{h.code}</span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[10px] text-white/20">{new Date(h.timestamp).toLocaleDateString()}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            {hasResults && (
                              <span className="text-[10px]">
                                {wonCount > 0 && <span className="text-emerald-400/70">{wonCount}✅</span>}
                                {lostCount > 0 && <span className="text-red-400/60 ml-0.5">{lostCount}❌</span>}
                                {pendingCount > 0 && <span className="text-white/20 ml-0.5">{pendingCount}⏳</span>}
                              </span>
                            )}
                            <span className={`text-[11px] font-bold ${evColor(h.avgEv)}`}>{h.avgEv > 0 ? "+" : ""}{h.avgEv}%</span>
                            <span className="text-[10px] text-white/20">{h.selections}p</span>
                          </div>
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); checkResults(h); }}
                          className="shrink-0 text-[10px] px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-white/30 hover:text-white/60 hover:bg-white/[0.06] transition-all">
                          {h.checkedAt ? "↻" : "Check"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── RECOMMENDATIONS ── */}
        {!data && (
          <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-10">
            {recsLoading && (
              <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/[0.06]">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-2 h-2 rounded-full bg-violet-400/60 animate-pulse" />
                  <div className="h-3 w-48 bg-white/[0.06] rounded animate-pulse" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="p-5 rounded-2xl bg-white/[0.02] border border-white/[0.06] space-y-3">
                      <div className="h-4 w-24 bg-white/[0.05] rounded animate-pulse" />
                      <div className="h-3 w-32 bg-white/[0.04] rounded animate-pulse" />
                      {[1, 2, 3].map(j => <div key={j} className="h-3 w-full bg-white/[0.03] rounded animate-pulse" />)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!recsLoading && recsError && (
              <div className="p-4 rounded-2xl bg-amber-500/[0.05] border border-amber-500/15">
                <p className="text-sm text-amber-400/60">Couldn&apos;t load recommendations. Try analyzing a code instead.</p>
              </div>
            )}

            {!recsLoading && recommendations.length > 0 && (
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                <div className="flex items-center justify-between gap-3 mb-5">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-white/50">Recommended Safe Slips</h2>
                  </div>
                  <button onClick={checkRecResults} disabled={checkingResults}
                    className="text-[11px] px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-white/35 hover:text-white/70 transition-all disabled:opacity-30">
                    {checkingResults ? "..." : "↻ Refresh Results"}
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  {recommendations.map((slip, idx) => {
                    const res = recResults[slip.code];
                    const st = slipStatus(res, slip.picks.length);
                    return (
                      <div key={idx}
                        className={`relative p-5 rounded-2xl bg-white/[0.02] border transition-all group ${
                          st.won ? "border-emerald-500/40" : st.lost ? "border-red-500/30" : "border-emerald-500/[0.12] hover:border-emerald-500/25"
                        }`}>
                        <div className="flex items-center justify-between mb-4">
                          <div>
                            <span className="text-2xl font-bold text-emerald-400">{slip.actualOdds}</span>
                            <span className="text-xs text-white/30 ml-1.5">odds</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {res && (
                              <span className="text-[10px]">
                                {res.won > 0 && <span className="text-emerald-400/70">{res.won}✅</span>}
                                {res.lost > 0 && <span className="text-red-400/60 ml-0.5">{res.lost}❌</span>}
                                {res.pending > 0 && <span className="text-white/25 ml-0.5">{res.pending}⏳</span>}
                              </span>
                            )}
                            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400/60">
                              {slip.picks.length} games
                            </span>
                          </div>
                        </div>

                        <div className="space-y-2 mb-4">
                          {slip.picks.map((p, j) => {
                            const pr = res?.picks[j];
                            const pickWon = pr?.result === "won";
                            const pickLost = pr?.result === "lost";
                            return (
                              <div key={j} className={`flex items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 -mx-1 transition-colors ${
                                pickWon ? "bg-emerald-500/[0.05]" : pickLost ? "bg-red-500/[0.05]" : ""
                              }`}>
                                <div className="min-w-0 flex items-center gap-2">
                                  {pr && <span className="shrink-0 text-xs">{pickWon ? "✅" : pickLost ? "❌" : "⏳"}</span>}
                                  <div className="min-w-0">
                                    <p className={`text-xs truncate ${pickLost ? "text-white/30 line-through" : pickWon ? "text-white/80" : "text-white/60"}`}>
                                      <span className="mr-1">{sportEmoji(p.sportId)}</span>
                                      {p.homeTeam} <span className="text-white/15">vs</span> {p.awayTeam}
                                    </p>
                                    <p className="text-[10px] text-white/25 truncate">{p.marketDesc} — {p.pickDesc} · {p.tournament}</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <span className="text-xs font-mono text-white/35">@{p.odds}</span>
                                  <span className="text-[11px] font-bold text-emerald-400/60 tabular-nums">{Math.round(p.probability * 100)}%</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-xs font-mono tracking-[0.08em] text-white/40 bg-white/[0.03] rounded-xl px-3 py-2.5 truncate">
                            {slip.code}
                          </code>
                          <button onClick={() => copy(slip.code)}
                            className={`shrink-0 px-4 py-2.5 rounded-xl text-[11px] font-semibold transition-all ${
                              copied === slip.code
                                ? "bg-emerald-500/20 text-emerald-300"
                                : "bg-white/[0.05] border border-white/[0.1] text-white/45 hover:text-white/80 hover:bg-white/[0.08]"
                            }`}>
                            {copied === slip.code ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* ── RISKY DRAW ── */}
                {drawSlip && (
                  <div className="mt-6 relative overflow-hidden rounded-3xl bg-gradient-to-br from-amber-500/[0.08] via-transparent to-orange-500/[0.06] border border-amber-500/25 p-6">
                    <div className="absolute -top-20 -right-20 w-64 h-64 rounded-full bg-amber-500/[0.12] blur-[90px] pointer-events-none" />
                    <div className="relative">
                      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
                        <div className="flex items-center gap-3">
                          <span className="text-xl">🎯</span>
                          <div>
                            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-amber-400">Risky Draw · {drawSlip.actualOdds}×</h2>
                            <p className="text-[11px] text-white/35 mt-0.5">All draws — {drawSlip.picks.length} games, high risk, high reward</p>
                          </div>
                        </div>
                        {(() => {
                          const res = recResults[drawSlip.code];
                          const st = slipStatus(res, drawSlip.picks.length);
                          if (st.won) return <span className="text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300">✓ WON</span>;
                          if (st.lost) return <span className="text-xs font-bold px-3 py-1.5 rounded-lg bg-red-500/15 text-red-300">✗ LOST</span>;
                          return <span className="text-xs font-bold px-3 py-1.5 rounded-lg bg-white/[0.05] text-white/40">⏳ pending</span>;
                        })()}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-5">
                        {drawSlip.picks.map((p, j) => {
                          const pr = recResults[drawSlip.code]?.picks[j];
                          const pickWon = pr?.result === "won";
                          const pickLost = pr?.result === "lost";
                          return (
                            <div key={j} className={`flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 bg-black/20 border border-white/[0.04] ${
                              pickWon ? "border-emerald-500/30" : pickLost ? "border-red-500/25 opacity-60" : ""
                            }`}>
                              <div className="min-w-0">
                                <p className={`text-xs truncate ${pickLost ? "text-white/30 line-through" : "text-white/70"}`}>
                                  {pr && <span className="mr-1">{pickWon ? "✅" : pickLost ? "❌" : ""}</span>}
                                  {p.homeTeam} <span className="text-white/15">vs</span> {p.awayTeam}
                                </p>
                                <p className="text-[10px] text-white/30 truncate">{p.tournament} · Draw</p>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="text-sm font-bold text-amber-400">@{p.odds}</span>
                                <p className="text-[9px] text-white/30">{Math.round(p.probability * 100)}%</p>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs font-mono tracking-[0.08em] text-amber-200/60 bg-black/30 rounded-xl px-3 py-2.5 truncate">
                          {drawSlip.code}
                        </code>
                        <button onClick={() => copy(drawSlip.code)}
                          className={`shrink-0 px-4 py-2.5 rounded-xl text-[11px] font-semibold transition-all ${
                            copied === drawSlip.code
                              ? "bg-amber-500/25 text-amber-200"
                              : "bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25"
                          }`}>
                          {copied === drawSlip.code ? "Copied" : "Copy"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <p className="mt-5 text-[11px] text-white/15 text-center">
                  Recommendations refresh every 4 hours. Algorithmically built from live SportyBet data — odds may shift.
                </p>
              </motion.div>
            )}
          </section>
        )}

        {/* ── RESULTS HISTORY ── */}
        {(() => {
          const genHistory = dbHistory;
          if (genHistory.length === 0) return null;

          const byDate = new Map<string, HistoryEntry[]>();
          for (const h of genHistory) {
            const dateKey = new Date(h.timestamp).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
            if (!byDate.has(dateKey)) byDate.set(dateKey, []);
            byDate.get(dateKey)!.push(h);
          }

          const days = Array.from(byDate.entries()).sort((a, b) => {
            // Sort chronologically by the latest entry in each day group, not
            // alphabetically by the "DD Mon YY" string (which would put "01 Sep"
            // below "31 Aug" because "0" < "3").
            const ta = Math.max(...a[1].map((e) => e.timestamp));
            const tb = Math.max(...b[1].map((e) => e.timestamp));
            return tb - ta;
          });
          const totalPages = Math.ceil(days.length / RESULTS_PER_PAGE);
          const pageDays = days.slice(resultsPage * RESULTS_PER_PAGE, (resultsPage + 1) * RESULTS_PER_PAGE);

          const allResolved = genHistory.filter(h => {
            const r = h.picks.filter(p => p.result === "won" || p.result === "lost").length;
            return r === h.selections;
          });
          const totalWon = allResolved.filter(h => h.picks.filter(p => p.result === "lost").length === 0).length;
          const totalLost = allResolved.filter(h => h.picks.filter(p => p.result === "lost").length > 0).length;

          return (
            <section className="max-w-3xl mx-auto px-4 sm:px-6 mb-10">
              <div className="p-6 rounded-3xl bg-white/[0.02] border border-white/[0.06]">
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-white/50">Results History</h2>
                  <div className="flex items-center gap-3">
                    {allResolved.length > 0 && (
                      <span className="text-[11px] text-white/30">
                        <span className="text-emerald-400/70">{totalWon}W</span>
                        <span className="text-white/15 mx-0.5">·</span>
                        <span className="text-red-400/60">{totalLost}L</span>
                        <span className="text-white/30 ml-1">({Math.round(totalWon / allResolved.length * 100)}%)</span>
                      </span>
                    )}
                    <button onClick={() => { setCheckingResults(true); Promise.all([checkRecResults(), checkAllHistory()]).finally(() => setCheckingResults(false)); }}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-white/35 hover:text-white/70 transition-all">
                      ↻ Check All
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-3 px-3 pb-2 border-b border-white/[0.05] mb-2">
                  <span className="text-[9px] text-white/25 uppercase tracking-wider w-16 shrink-0">Date</span>
                  <span className="text-[9px] text-white/25 uppercase tracking-wider w-14 text-center">5x</span>
                  <span className="text-[9px] text-white/25 uppercase tracking-wider w-14 text-center">10x</span>
                  <span className="text-[9px] text-white/25 uppercase tracking-wider w-14 text-center">15x</span>
                  <span className="text-[9px] text-white/25 uppercase tracking-wider w-16 text-center">🎯 1000x</span>
                </div>

                <div className="flex items-center gap-3 px-3 pb-2 mb-1 flex-wrap">
                  <span className="text-[9px] text-white/25"><span className="text-emerald-400/70">✅</span> won</span>
                  <span className="text-[9px] text-white/25"><span className="text-red-400/60">❌</span> lost</span>
                  <span className="text-[9px] text-white/25"><span className="text-white/50">⏳</span> still playing</span>
                  <span className="text-[9px] text-white/25"><span className="text-white/50">···</span> all pending</span>
                </div>

                <div className="space-y-1">
                  {pageDays.map(([dateKey, entries]) => {
                    const latest: Record<number, HistoryEntry | null> = { 5: null, 10: null, 15: null, 1000: null };
                    for (const e of entries) {
                      const t = e.targetOdds || 0;
                      const key = t === 5 ? 5 : t === 10 ? 10 : t === 15 ? 15 : t === 1000 ? 1000 : 0;
                      if (key === 0) continue;
                      if (!latest[key] || e.timestamp > latest[key]!.timestamp) latest[key] = e;
                    }

                    const isExpanded = expandedDays.has(dateKey);
                    const toggleDay = () => {
                      setExpandedDays(prev => {
                        const next = new Set(prev);
                        if (next.has(dateKey)) next.delete(dateKey);
                        else next.add(dateKey);
                        return next;
                      });
                    };

                    const renderBadge = (e: HistoryEntry | null, target: number) => {
                      if (!e) return <span className="text-[11px] text-white/10 w-14 text-center">—</span>;
                      const won = e.picks.filter(p => p.result === "won").length;
                      const lost = e.picks.filter(p => p.result === "lost").length;
                      const pending = e.picks.filter(p => !p.result || p.result === "pending" || p.result === "unknown").length;
                      const allDone = won + lost === e.selections;
                      const slipWon = allDone && lost === 0;
                      const slipLost = allDone && lost > 0;
                      const w = target === 1000 ? "w-16" : "w-14";
                      return (
                        <span className={`text-[10px] font-bold ${w} text-center px-2 py-0.5 rounded ${slipWon ? "bg-emerald-500/10 text-emerald-400" : slipLost ? "bg-red-500/10 text-red-400" : allDone ? "bg-white/[0.03] text-white/30" : "bg-white/[0.02] text-white/25"}`}>
                          {allDone ? (slipWon ? "WON" : "LOST") : pending === e.selections ? "···" : `${won}W${lost}L`}
                        </span>
                      );
                    };

                    return (
                      <div key={dateKey}>
                        <button onClick={toggleDay}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/[0.02] transition-all text-left group">
                          <span className="text-[11px] text-white/40 w-16 shrink-0">{dateKey}</span>
                          {renderBadge(latest[5], 5)}
                          {renderBadge(latest[10], 10)}
                          {renderBadge(latest[15], 15)}
                          {renderBadge(latest[1000], 1000)}
                          <span className="text-[10px] text-white/15 ml-auto">{entries.length} codes</span>
                          <span className="text-[10px] text-white/25">{isExpanded ? "▾" : "▸"}</span>
                        </button>

                        {isExpanded && (
                          <div className="ml-16 mb-2 space-y-0.5">
                            {entries.sort((a, b) => b.timestamp - a.timestamp).map(e => {
                              const won = e.picks.filter(p => p.result === "won").length;
                              const lost = e.picks.filter(p => p.result === "lost").length;
                              const pending = e.picks.filter(p => !p.result || p.result === "pending" || p.result === "unknown").length;
                              const allDone = won + lost === e.selections;
                              const slipWon = allDone && lost === 0;
                              const slipLost = allDone && lost > 0;
                              const target = e.targetOdds || 0;
                              const time = new Date(e.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                              const isDraw = e.type === "draw";
                              return (
                                <div key={e.code} onClick={() => loadHistoryCode(e)}
                                  className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/[0.02] cursor-pointer transition-all">
                                  <span className="text-[10px] text-white/25 w-10">{time}</span>
                                  <code className={`text-[10px] font-mono w-16 ${isDraw ? "text-amber-300/50" : "text-white/35"}`}>{e.code}</code>
                                  <span className={`text-[10px] w-8 text-center ${target > 0 ? (isDraw ? "text-amber-300/50" : "text-white/30") : "text-white/15"}`}>
                                    {target > 0 ? `${target}x` : "—"}
                                  </span>
                                  <span className="text-[10px] tabular-nums flex items-center gap-1.5">
                                    <span className="text-emerald-400/70">{won}W</span>
                                    <span className={lost > 0 ? "text-red-400/60" : "text-white/30"}>{lost}L</span>
                                    <span className="text-white/40">{pending}⏳</span>
                                  </span>
                                  {allDone && (
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ml-auto ${slipWon ? "bg-emerald-500/10 text-emerald-400/70" : "bg-red-500/10 text-red-400/60"}`}>
                                      {slipWon ? "WON" : "LOST"}
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-3 mt-5">
                    <button onClick={() => setResultsPage(Math.max(0, resultsPage - 1))}
                      disabled={resultsPage === 0}
                      className="text-[11px] px-4 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.05] text-white/40 hover:text-white/70 disabled:opacity-20 disabled:cursor-not-allowed transition-all">
                      ← Prev
                    </button>
                    <span className="text-[11px] text-white/30">{resultsPage + 1} / {totalPages}</span>
                    <button onClick={() => setResultsPage(Math.min(totalPages - 1, resultsPage + 1))}
                      disabled={resultsPage >= totalPages - 1}
                      className="text-[11px] px-4 py-1.5 rounded-lg bg-white/[0.02] border border-white/[0.05] text-white/40 hover:text-white/70 disabled:opacity-20 disabled:cursor-not-allowed transition-all">
                      Next →
                    </button>
                  </div>
                )}
              </div>
            </section>
          );
        })()}

        <AnimatePresence>
          {data && (
            <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-3xl mx-auto px-4 sm:px-6 pb-32 sm:pb-40">
              {/* ── PORTFOLIO GAUGE ── */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-white/30 mb-2">Portfolio Volatility</p>
                  <div className="flex items-end gap-2">
                    <span className={`text-3xl font-bold ${volColor(portfolioAfter || portfolioBefore)}`}>
                      {portfolioAfter || portfolioBefore}%
                    </span>
                    {portfolioAfter > 0 && portfolioBefore > 0 && (
                      <span className="text-sm text-emerald-400/70 mb-1">↓ {portfolioBefore - portfolioAfter}%</span>
                    )}
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${volColor(portfolioAfter || portfolioBefore)}`}
                      style={{ width: `${Math.min(100, (portfolioAfter || portfolioBefore) / 3)}%`, opacity: 0.6 }} />
                  </div>
                </div>
                <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-white/30 mb-2">Failure Probability</p>
                  <div className="flex items-end gap-2">
                    <span className={`text-3xl font-bold ${failColor(failAfter || failBefore)}`}>
                      {failAfter || failBefore}%
                    </span>
                    {failAfter > 0 && failBefore > 0 && (
                      <span className="text-sm text-emerald-400/70 mb-1">↓ {failBefore - failAfter}%</span>
                    )}
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${failColor(failAfter || failBefore)}`}
                      style={{ width: `${failAfter || failBefore}%`, opacity: 0.6 }} />
                  </div>
                </div>
              </div>

              {data.correlationWarnings?.length > 0 && (
                <div className="mb-6 p-4 rounded-2xl bg-amber-500/[0.05] border border-amber-500/15">
                  {data.correlationWarnings.map((w: string, i: number) => (
                    <p key={i} className="text-xs text-amber-400/70">⚠ {w}</p>
                  ))}
                </div>
              )}

              {data.hedgeWarnings?.length > 0 && (
                <div className="mb-6 p-4 rounded-2xl bg-red-500/[0.04] border border-red-500/15">
                  <p className="text-[10px] uppercase tracking-[0.15em] text-red-400/60 mb-2">⚠️ Hedge/Arbitrage Detected</p>
                  {data.hedgeWarnings.map((w: string, i: number) => (
                    <p key={i} className="text-xs text-red-400/70">{w}</p>
                  ))}
                </div>
              )}

              {resultCode && (
                <div className="mb-6 p-5 rounded-2xl bg-emerald-500/[0.05] border border-emerald-500/20">
                  <p className="text-[11px] uppercase tracking-[0.15em] text-white/30 mb-2">New Code — {keptList.length} of {all.length} kept</p>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xl font-mono tracking-[0.1em] text-white/80">{resultCode}</p>
                    <button onClick={() => copy(resultCode)}
                      className={`shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                        copied === resultCode ? "bg-emerald-500/20 text-emerald-300" : "bg-white/[0.05] border border-white/[0.1] text-white/50 hover:text-white hover:bg-white/[0.08]"
                      }`}>{copied === resultCode ? "Copied" : "Copy"}</button>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-[11px] text-white/30 uppercase tracking-wider">Auto-remove:</span>
                {[2, 3, 4, 5, 6].map(n => (
                  <button key={n} onClick={() => doShrink(n)}
                    className={`w-10 h-10 rounded-xl text-xs font-semibold transition-all ${
                      shrinkN === n ? "bg-violet-600 text-white" : "bg-white/[0.03] border border-white/[0.08] text-white/40 hover:text-white/80"
                    }`}>-{n}</button>
                ))}
                <div className="w-px h-6 bg-white/[0.08] mx-1 hidden sm:block" />
                <button onClick={addSafe} disabled={loading}
                  className="px-4 py-2.5 rounded-xl text-[11px] font-semibold uppercase tracking-wider bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-30">+ Add Safe</button>
                {removedIds.size > 0 && !resultCode && (
                  <button onClick={regenerateCode} disabled={loading}
                    className="px-4 py-2.5 rounded-xl text-[11px] font-semibold uppercase tracking-wider bg-violet-500/10 border border-violet-500/25 text-violet-300 hover:bg-violet-500/20 transition-all">Get Code</button>
                )}
              </div>
              <p className="text-[11px] text-white/20 mb-6">Tap × to remove individual picks</p>

              <div className="mb-8">
                <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/40 mb-3">Keeping · {keptList.length} games</h2>
                <div className="space-y-2.5">
                  {keptList.length === 0 && <p className="text-white/10 text-sm py-4">None kept</p>}
                  {keptList.map((s, i) => <Card key={selKey(s)} s={s} i={i} onRemove={() => toggleRemove(s)} onSwap={() => swapToBest(s)} isSwapped={swappedMap.has(selKey(s))} />)}
                </div>
              </div>

              {removedList.length > 0 && (
                <div>
                  <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-red-400/50 mb-3">Removed · {removedList.length} games</h2>
                  <div className="space-y-2.5 opacity-55">
                    {removedList.map((s, i) => <Card key={selKey(s)} s={s} i={i} removed />)}
                  </div>
                </div>
              )}

              <div className="mt-10 p-5 rounded-2xl bg-white/[0.02] border border-white/[0.06]">
                <p className="text-[10px] uppercase tracking-[0.15em] text-white/30 mb-4">Risk Score · 0–100 explained</p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
                  {([
                    [0, 14, "Safe", "bg-emerald-400", "Almost certain — big league, short odds, easy market"],
                    [15, 20, "Low", "bg-lime-400", "Likely to land — decent odds, known league"],
                    [21, 26, "Medium", "bg-amber-400", "Could go either way — mid odds or obscure league"],
                    [27, 33, "Risky", "bg-orange-400", "Leaning against you — high odds, small tournament"],
                    [34, 100, "Avoid", "bg-red-400", "Very unlikely — live game, tiny league, or huge odds"],
                  ] as const).map(([lo, hi, label, dot, desc]) => (
                    <div key={label} className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                        <span className="text-[10px] font-bold text-white/60">{label}</span>
                      </div>
                      <span className="text-[11px] font-mono text-white/40">{lo}–{hi}</span>
                      <p className="text-[9px] text-white/25 leading-relaxed">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 mb-4 p-5 rounded-2xl bg-white/[0.02] border border-white/[0.06]">
                <p className="text-[10px] uppercase tracking-[0.15em] text-white/30 mb-3">EV% · Expected Value explained</p>
                <p className="text-xs text-white/40 mb-4 leading-relaxed">
                  EV% = (odds × true probability − 1) × 100. It tells you if you&apos;re getting a fair price.
                  A <span className="text-emerald-400">positive</span> number means the bet is <span className="text-emerald-400">underpriced</span> — you have an edge.
                  A <span className="text-red-400">negative</span> number means you&apos;re <span className="text-red-400">overpaying</span> — the bookmaker wins long-term.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
                  {([
                    ["+10%+", "text-emerald-400", "bg-emerald-400", "Strong edge · bet is underpriced"],
                    ["+1 to +10%", "text-lime-400", "bg-lime-400", "Small edge · worth including"],
                    ["0 to −5%", "text-lime-400/50", "bg-lime-400/50", "Fair price · bookmaker margin"],
                    ["−6 to −15%", "text-amber-400", "bg-amber-400", "Overpaying · remove if possible"],
                    ["below −15%", "text-red-400", "bg-red-400", "Terrible value · bleeding money"],
                  ] as const).map(([range, textC, dot, desc]) => (
                    <div key={range} className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                        <span className={`text-[10px] font-bold ${textC}`}>{range}</span>
                      </div>
                      <p className="text-[9px] text-white/25 leading-relaxed">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Card({ s, i, removed, onRemove, onSwap, isSwapped }: { s: Selection; i: number; removed?: boolean; onRemove?: () => void; onSwap?: () => void; isSwapped?: boolean }) {
  const rl = riskLevel(s.riskScore);
  const m = riskMeta[rl];
  const showBest = s.bestAlternative && !removed && !isSwapped;
  const ev = s.evPercent ?? 0;

  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.012 }}
      className={`relative border rounded-2xl px-5 py-4 transition-colors ${
        removed ? "bg-red-500/[0.02] border-red-500/[0.1]"
          : isSwapped ? "bg-emerald-500/[0.02] border-emerald-500/[0.12]"
          : "bg-white/[0.02] border-white/[0.06] hover:border-white/[0.12]"
      }`}
    >
      {isSwapped && <div className="absolute top-2.5 left-5 text-[9px] font-bold text-emerald-400/60 uppercase tracking-wider">✓ Swapped</div>}
      <div className="flex items-start gap-4">
        <div className="shrink-0 pt-1.5"><div className={`w-1.5 h-1.5 rounded-full ${m.dot}`} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] uppercase tracking-[0.1em] text-white/25 truncate">{s.tournament}</span>
            {s.matchStatus !== "Not start" && <span className="text-[9px] font-bold text-amber-500/60">LIVE</span>}
            {s.priorUsed && (
              <span className="text-[9px] px-1.5 py-[1px] rounded-md bg-violet-500/[0.08] text-violet-400/60">📊 {Math.round(s.priorUsed.historicalHitRate * 100)}% prior</span>
            )}
          </div>
          <h3 className="text-[15px] font-medium tracking-tight text-white/85 truncate">{s.homeTeam} <span className="text-white/15 mx-1">vs</span> {s.awayTeam}</h3>
          {isSwapped && s.bestAlternative ? (
            <p className="text-xs mt-1">
              <span className="text-white/20 line-through">{s.marketDesc} — {s.pickDesc} @{s.odds}</span>
              <span className="ml-2 text-emerald-400/70">{s.bestAlternative.marketDesc} — {s.bestAlternative.pickDesc} <span className="text-white/30">@{s.bestAlternative.odds}</span></span>
            </p>
          ) : (
            <p className="text-xs text-white/35 mt-1">{s.marketDesc} — {s.pickDesc} <span className="ml-1.5 text-white/25">@{s.odds}</span></p>
          )}
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {s.safeReasons?.map((r, j) => <span key={"s"+j} className="text-[9px] px-2 py-[2px] rounded-md bg-emerald-500/[0.08] text-emerald-400/80">{r}</span>)}
            {s.riskReasons?.map((r, j) => <span key={"r"+j} className={`text-[9px] px-2 py-[2px] rounded-md ${removed ? "bg-white/[0.03] text-white/25" : "bg-red-500/[0.06] text-red-400/70"}`}>{r}</span>)}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1.5">
          {onRemove && (
            <button onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="w-7 h-7 rounded-full bg-white/[0.04] border border-white/[0.1] flex items-center justify-center text-white/35 hover:bg-red-500/20 hover:border-red-500/30 hover:text-red-400 active:bg-red-500/30 active:text-red-400 transition-all text-sm leading-none">×</button>
          )}
          <span className={`text-lg font-bold ${removed ? "text-white/25" : evColor(ev)}`}>
            {ev > 0 ? "+" : ""}{ev}%
          </span>
          <span className="text-[8px] uppercase tracking-wider text-white/20">EV</span>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${removed ? "text-white/25" : m.text}`}>{m.label} {s.riskScore}</span>
          {showBest && onSwap && (
            <button onClick={(e) => { e.stopPropagation(); onSwap(); }}
              className="text-[9px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20 transition-all">
              Best
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
