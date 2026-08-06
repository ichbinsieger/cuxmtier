"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Lenis from "lenis";

// ── Types ──
interface Selection {
  homeTeam: string; awayTeam: string; tournament: string;
  marketDesc: string; pickDesc: string; odds: number;
  probability: number; matchStatus: string;
  riskScore: number; riskReasons: string[]; safeReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
}
interface AnalysisData {
  originalCode: string; totalSelections: number;
  averageRisk: number; selections: Selection[];
  safeketCode: string; safekeptCount: number;
}
interface ShrinkResult {
  originalCode: string; newCode: string;
  totalOriginal: number; totalNew: number; removedCount: number;
  removed: Selection[]; kept: Selection[];
}

// ── Risk helpers ──
type RiskLevel = "safe" | "low" | "medium" | "high" | "critical";
function getRiskLevel(score: number): RiskLevel {
  if (score <= 14) return "safe";
  if (score <= 20) return "low";
  if (score <= 26) return "medium";
  if (score <= 33) return "high";
  return "critical";
}
const riskMeta = {
  safe:     { label: "Safe",     bg: "bg-emerald-500/10",  border: "border-emerald-500/25",   text: "text-emerald-400",   bar: "bg-emerald-400",   dot: "bg-emerald-400" },
  low:      { label: "Low Risk", bg: "bg-lime-500/10",     border: "border-lime-500/20",      text: "text-lime-400",      bar: "bg-lime-400",      dot: "bg-lime-400" },
  medium:   { label: "Moderate", bg: "bg-amber-500/10",    border: "border-amber-500/20",     text: "text-amber-400",     bar: "bg-amber-400",     dot: "bg-amber-400" },
  high:     { label: "Risky",    bg: "bg-orange-500/10",   border: "border-orange-500/20",    text: "text-orange-400",    bar: "bg-orange-400",    dot: "bg-orange-500" },
  critical: { label: "Avoid",    bg: "bg-red-500/10",      border: "border-red-500/25",       text: "text-red-400",       bar: "bg-red-400",       dot: "bg-red-500" },
};

const selKey = (s: Selection) => `${s.eventId}|${s.marketId}|${s.outcomeId}`;

export default function Home() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [shrinkResult, setShrinkResult] = useState<ShrinkResult | null>(null);
  const [shrinkCount, setShrinkCount] = useState(4);
  const [copied, setCopied] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [autoCode, setAutoCode] = useState("");

  useEffect(() => {
    const lenis = new Lenis({ duration: 1.2, easing: (t) => 1 - Math.pow(1 - t, 3) });
    let id: number;
    function raf(t: number) { lenis.raf(t); id = requestAnimationFrame(raf); }
    id = requestAnimationFrame(raf);
    return () => { lenis.destroy(); cancelAnimationFrame(id); };
  }, []);

  const analyze = async () => {
    if (!code.trim() || loading) return;
    setLoading(true); setError(""); setAnalysis(null); setShrinkResult(null);
    setCheckedIds(new Set()); setManualMode(false); setAutoCode("");
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "analyze" }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setAnalysis(d);

      // Auto-generate code for safe picks only
      const safeOnes = (d.selections as Selection[]).filter((s) => getRiskLevel(s.riskScore) !== "high" && getRiskLevel(s.riskScore) !== "critical");
      if (safeOnes.length > 0 && safeOnes.length < d.selections.length) {
        autoGenerateCode(safeOnes);
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const autoGenerateCode = async (selections: Selection[]) => {
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "shrink", count: analysis!.totalSelections - selections.length }) });
      const d = await r.json();
      if (r.ok) setAutoCode(d.newCode);
    } catch {}
  };

  const shrink = async (count: number) => {
    if (!code.trim() || loading) return;
    setLoading(true); setError(""); setManualMode(false);
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "shrink", count }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setShrinkResult(d);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const toggleCheck = (sel: Selection) => {
    setCheckedIds(prev => { const n = new Set(prev); n.has(selKey(sel)) ? n.delete(selKey(sel)) : n.add(selKey(sel)); return n; });
  };

  const rebuildManual = async () => {
    if (!analysis || loading) return;
    setLoading(true); setError("");
    try {
      const kept = analysis.selections.filter(s => !checkedIds.has(selKey(s)));
      if (kept.length === 0) { setError("Keep at least one game"); setLoading(false); return; }
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "shrink", count: analysis.selections.length - kept.length }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setShrinkResult(d);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const allSelections: Selection[] = analysis?.selections || [];
  const displayRemoved = shrinkResult ? new Set<string>(shrinkResult.removed.map((s: Selection) => selKey(s))) : new Set<string>();
  const checkedKeys = manualMode ? checkedIds : displayRemoved;
  const keptSelections = allSelections.filter(s => !checkedKeys.has(selKey(s)));
  const removedSelections = allSelections.filter(s => checkedKeys.has(selKey(s)));
  const displayCode = shrinkResult?.newCode || autoCode || "";
  const hasAutoCode = !!autoCode && !shrinkResult;

  const copy = (text: string) => { navigator.clipboard.writeText(text); setCopied(text); setTimeout(() => setCopied(""), 2000); };

  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white font-sans antialiased">
      {/* ── HERO ── */}
      <section className="min-h-screen flex flex-col items-center justify-center px-6">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="w-full max-w-lg mx-auto text-center"
        >
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
            Cuxm<span className="text-violet-400">Tier</span>
          </h1>
          <p className="text-white/30 text-sm mb-10 max-w-xs mx-auto leading-relaxed">
            Paste a SportyBet booking code. Get a risk analysis and a tighter slip.
          </p>

          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && analyze()}
              placeholder="S9C3D6"
              spellCheck={false}
              className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-5 py-3.5 text-lg font-mono tracking-[0.12em] text-white placeholder:text-white/[0.10] focus:outline-none focus:border-violet-500/40 transition-all"
            />
            <button
              onClick={analyze}
              disabled={loading || !code.trim()}
              className="shrink-0 px-6 py-3.5 bg-violet-600 text-white font-semibold rounded-xl hover:bg-violet-500 disabled:opacity-20 disabled:cursor-not-allowed transition-all text-sm"
            >
              {loading ? "…" : "Analyze"}
            </button>
          </div>
          {error && <p className="mt-4 text-red-400/80 text-sm">{error}</p>}
        </motion.div>
      </section>

      {/* ── RESULTS ── */}
      <AnimatePresence>
        {analysis && (
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-3xl mx-auto px-6 pb-40">
            {/* ── AUTO KEEP CODE ── */}
            {displayCode && (
              <div className={`mb-10 p-5 rounded-2xl border ${hasAutoCode ? "bg-emerald-500/[0.04] border-emerald-500/20" : "bg-violet-500/[0.04] border-violet-500/20"}`}>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-white/25 mb-1">
                      {hasAutoCode ? "Auto-keep code" : "New code"} — Keeping {shrinkResult?.totalNew || allSelections.filter(s => getRiskLevel(s.riskScore) !== "high" && getRiskLevel(s.riskScore) !== "critical").length} of {analysis.totalSelections}
                    </p>
                    <p className="text-xl font-mono tracking-[0.1em] text-white/80">{displayCode}</p>
                  </div>
                  <button onClick={() => copy(displayCode)}
                    className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      copied === displayCode
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-white/[0.05] border border-white/[0.08] text-white/50 hover:text-white hover:bg-white/[0.08]"
                    }`}>
                    {copied === displayCode ? "Copied" : "Copy Code"}
                  </button>
                </div>
                {hasAutoCode && <p className="text-[11px] text-white/15 mt-3">Auto-generated from safe picks. Use shrink buttons below to customize.</p>}
              </div>
            )}

            {/* ── CONTROLS ── */}
            <div className="flex flex-wrap items-center gap-2 mb-10">
              {/* Shrink buttons */}
              <div className="flex items-center gap-1 bg-white/[0.02] border border-white/[0.05] rounded-xl p-1">
                {[2, 3, 4, 5, 6].map((n) => (
                  <button key={n} onClick={() => shrink(n)}
                    className={`w-9 h-9 rounded-lg text-xs font-semibold transition-all ${
                      shrinkResult?.removedCount === n && !manualMode
                        ? "bg-violet-600 text-white"
                        : "text-white/30 hover:text-white/70 hover:bg-white/[0.04]"
                    }`}>-{n}</button>
                ))}
              </div>

              {/* Manual mode */}
              <button onClick={() => { setManualMode(!manualMode); if (!manualMode) setCheckedIds(new Set(allSelections.filter(s => getRiskLevel(s.riskScore) === "high" || getRiskLevel(s.riskScore) === "critical").map(selKey))); }}
                className={`px-3.5 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-wider transition-all border ${
                  manualMode ? "bg-violet-500/10 border-violet-500/30 text-violet-300" : "bg-white/[0.02] border-white/[0.06] text-white/30 hover:text-white/60"
                }`}>Select</button>

              {/* Add safe bets */}
              <button onClick={async () => {
                if (!analysis || loading) return; setLoading(true);
                try {
                  const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "add", count: 3 }) });
                  const d = await r.json();
                  if (r.ok) {
                    const r2 = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: d.newCode, action: "analyze" }) });
                    const d2 = await r2.json();
                    if (r2.ok) { setAnalysis(d2); setCode(d.newCode); setShrinkResult(null); setCheckedIds(new Set()); setAutoCode(""); }
                  } else { setError(d.error); }
                } catch (e: any) { setError(e.message); }
                finally { setLoading(false); }
              }} disabled={loading}
                className="px-3.5 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-wider bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-30">
                +Safe Bets
              </button>

              {manualMode && checkedIds.size > 0 && (
                <button onClick={rebuildManual} disabled={loading}
                  className="px-3.5 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-wider bg-violet-500/10 border border-violet-500/20 text-violet-300 hover:bg-violet-500/20 transition-all">
                  Apply ({allSelections.length - checkedIds.size} kept)
                </button>
              )}

              {manualMode && <span className="text-[10px] text-white/15 ml-1">Tap games to toggle</span>}
            </div>

            {/* ── KEPT ── */}
            <div className="mb-8">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-1 h-4 rounded-full bg-emerald-400" />
                <h2 className="text-xs font-bold uppercase tracking-[0.25em] text-white/40">Keeping · {keptSelections.length} games</h2>
              </div>
              <div className="space-y-2">
                {keptSelections.length === 0 && <p className="text-white/[0.05] text-sm italic py-4">All games flagged</p>}
                {keptSelections.map((sel, i) => <GameCard key={selKey(sel)} sel={sel} i={i} onToggle={manualMode ? toggleCheck : undefined} checked={checkedKeys.has(selKey(sel))} />)}
              </div>
            </div>

            {/* ── REMOVED ── */}
            {removedSelections.length > 0 && (
              <div>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-1 h-4 rounded-full bg-red-400" />
                  <h2 className="text-xs font-bold uppercase tracking-[0.25em] text-red-400/50">Flagged · {removedSelections.length} games</h2>
                </div>
                <div className="space-y-2 opacity-70">
                  {removedSelections.map((sel, i) => <GameCard key={selKey(sel)} sel={sel} i={i} onToggle={manualMode ? toggleCheck : undefined} checked={checkedKeys.has(selKey(sel))} removed />)}
                </div>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      <footer className="border-t border-white/[0.03] py-10 text-center text-[11px] text-white/[0.08] uppercase tracking-[0.2em]">
        CuxmTier · Not affiliated with SportyBet
      </footer>
    </div>
  );
}

// ── Game Card ──
function GameCard({ sel, i, onToggle, checked, removed }: {
  sel: Selection; i: number; onToggle?: (s: Selection) => void; checked?: boolean; removed?: boolean;
}) {
  const risk = getRiskLevel(sel.riskScore);
  const m = riskMeta[risk];

  // Build smart reason
  const reasons = sel.riskReasons?.length ? sel.riskReasons : [];
  if (sel.safeReasons?.length) reasons.push(...sel.safeReasons);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: i * 0.015 }}
      onClick={() => onToggle?.(sel)}
      className={`relative border rounded-xl px-5 py-4 transition-all ${
        onToggle ? "cursor-pointer" : ""
      } ${
        removed
          ? "bg-red-500/[0.03] border-red-500/[0.10]"
          : "bg-white/[0.01] border-white/[0.04] hover:border-white/[0.10]"
      }`}
    >
      {/* Color dot */}
      <div className={`absolute left-3 top-4 w-1.5 h-1.5 rounded-full ${m.dot}`} />

      {/* Checkbox */}
      {onToggle && (
        <div className="absolute left-9 top-3.5">
          <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
            checked ? "bg-violet-600 border-violet-500" : "border-white/[0.12]"
          }`}>
            {checked && <svg width="7" height="5" viewBox="0 0 8 6" fill="none"><path d="M1 3l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
          </div>
        </div>
      )}

      <div className={`${onToggle ? "ml-8" : "ml-2.5"} flex items-start justify-between gap-4`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] uppercase tracking-[0.12em] text-white/15 truncate">{sel.tournament}</span>
            {sel.matchStatus !== "Not start" && <span className="text-[9px] font-bold uppercase text-amber-500/60">Live</span>}
          </div>
          <h3 className="text-[14px] font-medium tracking-tight text-white/80 truncate">
            {sel.homeTeam} <span className="text-white/10 mx-1.5">vs</span> {sel.awayTeam}
          </h3>
          <p className="text-[12px] text-white/25 mt-0.5">
            {sel.marketDesc} — {sel.pickDesc} <span className="ml-1.5 text-white/15">@{sel.odds}</span>
          </p>

          {/* Reasons */}
          {reasons.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {reasons.map((r, j) => (
                <span key={j} className={`text-[9px] px-2 py-[2px] rounded-md ${
                  removed ? "bg-white/[0.02] text-white/15" : "bg-white/[0.03] border border-white/[0.04] text-white/30"
                }`}>{r}</span>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-3">
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${m.bg} ${m.border} ${m.text}`}>{risk}</span>
          <span className={`text-lg font-bold ${m.text} w-8 text-right`}>{sel.riskScore}</span>
        </div>
      </div>
    </motion.div>
  );
}
