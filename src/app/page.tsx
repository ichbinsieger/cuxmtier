"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Lenis from "lenis";

// ── Types ──
interface Selection {
  homeTeam: string; awayTeam: string; tournament: string;
  marketDesc: string; pickDesc: string; odds: number;
  probability: number; matchStatus: string;
  riskScore: number; riskReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
}
interface AnalysisData {
  originalCode: string; totalSelections: number;
  averageRisk: number; selections: Selection[];
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
const riskConfig: Record<RiskLevel, { label: string; bg: string; border: string; text: string; bar: string; dot: string }> = {
  safe:     { label: "Safe",     bg: "bg-emerald-950/60",  border: "border-emerald-800/50",  text: "text-emerald-300",  bar: "bg-emerald-400",  dot: "bg-emerald-400" },
  low:      { label: "Low Risk", bg: "bg-lime-950/50",     border: "border-lime-800/40",     text: "text-lime-300",     bar: "bg-lime-400",     dot: "bg-lime-400" },
  medium:   { label: "Medium",   bg: "bg-amber-950/50",    border: "border-amber-800/40",    text: "text-amber-300",   bar: "bg-amber-400",   dot: "bg-amber-400" },
  high:     { label: "Risky",    bg: "bg-orange-950/50",   border: "border-orange-800/40",   text: "text-orange-300",  bar: "bg-orange-400",  dot: "bg-orange-500" },
  critical: { label: "Critical", bg: "bg-red-950/60",      border: "border-red-800/50",      text: "text-red-300",     bar: "bg-red-400",     dot: "bg-red-500" },
};

export default function Home() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [shrinkResult, setShrinkResult] = useState<ShrinkResult | null>(null);
  const [shrinkCount, setShrinkCount] = useState(4);
  const [showCustom, setShowCustom] = useState(false);
  const [copied, setCopied] = useState(false);

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
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "analyze" }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setAnalysis(d);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const shrink = async (count: number) => {
    if (!code.trim() || loading) return;
    setLoading(true); setError("");
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "shrink", count }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setShrinkResult(d);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const selections = shrinkResult
    ? [...shrinkResult.kept.map((s: any) => ({ ...s, removed: false })), ...shrinkResult.removed.map((s: any) => ({ ...s, removed: true }))]
    : (analysis?.selections || []).map((s) => ({ ...s, removed: false }));

  const removedSet = new Set(shrinkResult?.removed.map((s: any) => s.eventId + s.marketId + s.outcomeId) || []);

  return (
    <div className="min-h-screen bg-[#050508] text-white font-sans selection:bg-violet-500/30">
      {/* ── HERO ── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center px-6">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-violet-600/[0.07] rounded-full blur-[150px]" />
          <div className="absolute bottom-0 right-0 w-[600px] h-[600px] bg-emerald-500/[0.04] rounded-full blur-[120px]" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.25, 0.4, 0.25, 1] }}
          className="relative z-10 w-full max-w-lg mx-auto text-center"
        >
          <div className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] mb-10">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]" />
            <span className="text-[10px] uppercase tracking-[0.25em] text-white/30 font-medium">Powered by Data</span>
          </div>

          <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold tracking-[-0.03em] leading-[1.05] mb-6">
            Your slip,<br />
            <span className="bg-gradient-to-r from-violet-300 via-white to-emerald-300 bg-clip-text text-transparent">
              stripped clean.
            </span>
          </h1>
          <p className="text-base text-white/25 max-w-sm mx-auto mb-12 leading-relaxed">
            Paste a SportyBet code. We rank every game by risk, flag what to cut, and hand you a tighter slip.
          </p>

          <div className="flex gap-3">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && analyze()}
              placeholder="Enter booking code"
              spellCheck={false}
              className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-2xl px-5 py-4 text-lg font-mono tracking-[0.15em] text-white placeholder:text-white/[0.12] focus:outline-none focus:border-violet-500/40 focus:bg-white/[0.05] transition-all duration-300"
            />
            <button
              onClick={analyze}
              disabled={loading || !code.trim()}
              className="shrink-0 px-7 py-4 bg-white text-black font-semibold rounded-2xl hover:bg-[#e8e8e8] disabled:opacity-20 disabled:cursor-not-allowed transition-all duration-200 text-sm uppercase tracking-wider"
            >
              {loading ? "…" : "Go"}
            </button>
          </div>
          {error && <p className="mt-4 text-red-400/80 text-sm">{error}</p>}
        </motion.div>

        {!analysis && !shrinkResult && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2 }}
            className="absolute bottom-12 flex flex-col items-center gap-4 text-white/[0.10]">
            <span className="text-[9px] uppercase tracking-[0.4em]">Scroll to explore</span>
            <div className="w-px h-10 bg-gradient-to-b from-white/20 to-transparent" />
          </motion.div>
        )}
      </section>

      {/* ── RESULTS ── */}
      <AnimatePresence>
        {(analysis || shrinkResult) && (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative z-10 max-w-3xl mx-auto px-6 pb-40"
          >
            {/* ── HEADER BAR ── */}
            <div className="sticky top-6 z-30 mb-12">
              <div className="bg-[#0a0a10]/80 backdrop-blur-2xl border border-white/[0.06] rounded-2xl p-4 flex flex-wrap items-center gap-4">
                {/* Risk summary */}
                <div className="flex items-center gap-4 mr-auto">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                    <span className="text-xs text-white/30">
                      {(shrinkResult?.kept || analysis?.selections || []).filter((s: any) => getRiskLevel(s.riskScore) === "safe" || getRiskLevel(s.riskScore) === "low").length} safe
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    <span className="text-xs text-white/30">
                      {(shrinkResult?.kept || analysis?.selections || []).filter((s: any) => getRiskLevel(s.riskScore) === "medium").length} medium
                    </span>
                  </div>
                  {shrinkResult && (
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                      <span className="text-xs text-white/30">
                        {shrinkResult.removedCount} removed
                      </span>
                    </div>
                  )}
                </div>

                {/* Shrink buttons */}
                <div className="flex items-center gap-1.5 bg-white/[0.02] rounded-xl p-1">
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} onClick={() => shrink(n)}
                      className={`w-9 h-9 rounded-lg text-xs font-semibold transition-all duration-200 ${
                        shrinkResult?.removedCount === n
                          ? "bg-violet-600 text-white shadow-[0_0_12px_rgba(139,92,246,0.4)]"
                          : "text-white/30 hover:text-white hover:bg-white/[0.05]"
                      }`}>
                      -{n}
                    </button>
                  ))}
                  <button onClick={() => setShowCustom(!showCustom)}
                    className="w-9 h-9 rounded-lg text-white/20 hover:text-white/50 text-sm">…</button>
                </div>

                {shrinkResult && (
                  <button
                    onClick={() => { navigator.clipboard.writeText(shrinkResult.newCode); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                    className="shrink-0 flex items-center gap-2 px-4 py-2.5 bg-emerald-500/10 border border-emerald-500/25 rounded-xl hover:bg-emerald-500/20 transition-all group cursor-pointer">
                    <span className="text-sm font-mono tracking-[0.1em] text-emerald-300">{shrinkResult.newCode}</span>
                    <span className="text-[10px] text-emerald-500/70 group-hover:text-emerald-400">
                      {copied ? "Copied" : "Copy"}
                    </span>
                  </button>
                )}
              </div>

              {/* Custom shrink */}
              <AnimatePresence>
                {showCustom && (
                  <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                    className="mt-3 flex items-center gap-3 bg-[#0a0a10]/80 backdrop-blur-2xl border border-white/[0.06] rounded-xl p-3">
                    <input type="number" min={1} max={(analysis?.totalSelections || 10) - 1} value={shrinkCount}
                      onChange={(e) => setShrinkCount(Number(e.target.value) || 1)}
                      className="w-16 bg-white/[0.03] border border-white/[0.08] rounded-xl px-3 py-2 text-sm text-white text-center focus:outline-none focus:border-violet-500/40" />
                    <button onClick={() => shrink(shrinkCount)}
                      className="px-5 py-2 bg-white/[0.05] border border-white/[0.08] text-white/60 text-sm rounded-xl hover:bg-white/[0.1] hover:text-white transition-all">
                      Shrink by {shrinkCount}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ── GAME LIST ── */}
            <div className="space-y-2">
              {selections.map((sel: any, i: number) => {
                const risk = getRiskLevel(sel.riskScore);
                const cfg = riskConfig[risk];
                const isRemoved = sel.removed || removedSet.has(sel.eventId + sel.marketId + sel.outcomeId);

                return (
                  <motion.div
                    key={sel.eventId + sel.marketId + sel.outcomeId}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.02, duration: 0.3 }}
                    className={`group relative border rounded-2xl transition-all duration-300 hover:border-white/[0.12] ${
                      isRemoved
                        ? `${cfg.bg} ${cfg.border} opacity-60 grayscale-[0.3]`
                        : "bg-white/[0.015] border-white/[0.04]"
                    }`}
                  >
                    {/* Risk stripe on left */}
                    <div className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-full ${cfg.bar} ${isRemoved ? "opacity-50" : ""}`} />

                    <div className="pl-5 pr-5 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          {/* Tournament + Live badge */}
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-[10px] uppercase tracking-[0.15em] text-white/20 font-medium truncate">
                              {sel.tournament}
                            </span>
                            {sel.matchStatus !== "Not start" && (
                              <span className="shrink-0 px-1.5 py-[1px] rounded text-[9px] font-bold uppercase bg-amber-500/20 text-amber-400 tracking-wider">
                                LIVE
                              </span>
                            )}
                          </div>

                          {/* Teams */}
                          <h3 className={`text-[15px] font-semibold tracking-[-0.01em] truncate ${isRemoved ? "text-white/40" : "text-white/85"}`}>
                            {sel.homeTeam}
                            <span className="text-white/15 font-normal mx-2">vs</span>
                            {sel.awayTeam}
                          </h3>

                          {/* Market + pick */}
                          <p className={`text-[12px] mt-1 ${isRemoved ? "text-white/20" : "text-white/35"}`}>
                            {sel.marketDesc} —
                            <span className={isRemoved ? "text-white/30" : "text-white/55"}> {sel.pickDesc}</span>
                            <span className="ml-2 text-[11px] text-white/20">@{sel.odds}</span>
                          </p>

                          {/* Risk reasons */}
                          {sel.riskReasons?.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {sel.riskReasons.map((r: string, j: number) => (
                                <span key={j} className={`text-[9px] px-1.5 py-[2px] rounded-md border ${isRemoved ? "bg-white/[0.02] border-white/[0.04] text-white/20" : "bg-white/[0.02] border-white/[0.04] text-white/25"}`}>
                                  {r}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Risk badge */}
                        <div className="shrink-0 flex flex-col items-end gap-1">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${cfg.bg} ${cfg.border}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} ${isRemoved ? "opacity-40" : ""}`} />
                            <span className={cfg.text}>{cfg.label}</span>
                          </span>
                          <span className={`text-[20px] font-bold tracking-tight ${isRemoved ? "text-white/15" : cfg.text}`}>
                            {sel.riskScore}
                          </span>
                        </div>
                      </div>

                      {/* Risk bar */}
                      <div className="mt-3 h-[2px] rounded-full bg-white/[0.03] overflow-hidden">
                        <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${sel.riskScore}%` }}
                          transition={{ delay: i * 0.03, duration: 0.6, ease: "easeOut" }}
                          className={`h-full rounded-full ${cfg.bar} ${isRemoved ? "opacity-30" : ""}`}
                        />
                      </div>

                      {isRemoved && (
                        <div className="absolute -top-2 -right-2 px-2.5 py-0.5 rounded-full bg-red-600/90 text-[9px] font-bold uppercase tracking-widest text-white shadow-lg">
                          Cut
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {selections.length === 0 && (
              <div className="text-center py-32 text-white/[0.08]">
                <p className="text-2xl font-light tracking-tight">Nothing here yet</p>
                <p className="text-sm mt-2">Paste a code above to get started.</p>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {/* ── FOOTER ── */}
      <footer className="border-t border-white/[0.03] py-12 text-center text-[11px] text-white/[0.10] uppercase tracking-[0.2em]">
        CuxmTier · Not affiliated with SportyBet · Gamble responsibly
      </footer>
    </div>
  );
}
