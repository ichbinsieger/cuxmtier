"use client";

import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Lenis from "lenis";

// Types
interface Selection {
  homeTeam: string;
  awayTeam: string;
  tournament: string;
  marketDesc: string;
  pickDesc: string;
  odds: number;
  probability: number;
  matchStatus: string;
  riskScore: number;
  riskReasons: string[];
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifierRaw?: string;
  productId: number;
  sportId: string;
}

interface AnalysisData {
  originalCode: string;
  totalSelections: number;
  averageRisk: number;
  selections: Selection[];
}

interface ShrinkResult {
  originalCode: string;
  newCode: string;
  totalOriginal: number;
  totalNew: number;
  removedCount: number;
  removed: Selection[];
  kept: Selection[];
}

// Risk color
function riskColor(score: number) {
  if (score <= 15) return "text-emerald-400";
  if (score <= 22) return "text-lime-400";
  if (score <= 28) return "text-amber-400";
  return "text-red-400";
}

function riskBg(score: number) {
  if (score <= 15) return "bg-emerald-500/10 border-emerald-500/20";
  if (score <= 22) return "bg-lime-500/10 border-lime-500/20";
  if (score <= 28) return "bg-amber-500/10 border-amber-500/20";
  return "bg-red-500/10 border-red-500/20";
}

export default function Home() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [shrinkResult, setShrinkResult] = useState<ShrinkResult | null>(null);
  const [shrinkCount, setShrinkCount] = useState(4);
  const [showShrinkInput, setShowShrinkInput] = useState(false);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const mainRef = useRef<HTMLDivElement>(null);

  // Lenis smooth scroll
  useEffect(() => {
    const lenis = new Lenis({ duration: 1.2, easing: (t) => 1 - Math.pow(1 - t, 3) });
    function raf(time: number) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);
    return () => lenis.destroy();
  }, []);

  const handleAnalyze = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setError("");
    setAnalysis(null);
    setShrinkResult(null);
    setRemovedIds(new Set());

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), action: "analyze" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setAnalysis(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleShrink = async (count: number) => {
    if (!code.trim()) return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), action: "shrink", count }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setShrinkResult(data);
      setRemovedIds(new Set(data.removed.map((s: Selection) => s.eventId + s.marketId + s.outcomeId)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickShrink = (count: number) => {
    setShrinkCount(count);
    handleShrink(count);
  };

  return (
    <div ref={mainRef} className="min-h-screen bg-[#0a0a0a] text-white font-sans">
      {/* Hero */}
      <section className="relative min-h-screen flex flex-col items-center justify-center px-4 overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[800px] h-[800px] bg-violet-600/20 rounded-full blur-[120px]" />
          <div className="absolute top-1/2 -right-40 w-[500px] h-[500px] bg-emerald-500/10 rounded-full blur-[100px]" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.25, 0.4, 0.25, 1] }}
          className="relative z-10 text-center max-w-2xl mx-auto"
        >
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/10 bg-white/5 mb-8">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] uppercase tracking-[0.2em] text-white/50">SportyBet Analysis</span>
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6">
            Your slip,{" "}
            <span className="bg-gradient-to-r from-violet-400 via-emerald-400 to-violet-400 bg-clip-text text-transparent">
              smarter.
            </span>
          </h1>
          <p className="text-lg text-white/40 mb-12 max-w-md mx-auto leading-relaxed">
            Paste a SportyBet booking code. We analyze every game, flag the risky ones, and give you a leaner slip.
          </p>

          {/* Input */}
          <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              placeholder="S9C3D6"
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-5 py-4 text-lg font-mono tracking-widest text-white placeholder:text-white/20 focus:outline-none focus:border-violet-500/50 focus:bg-white/[0.07] transition-all"
            />
            <button
              onClick={handleAnalyze}
              disabled={loading || !code.trim()}
              className="px-8 py-4 bg-white text-black font-semibold rounded-xl hover:bg-white/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-sm uppercase tracking-wider"
            >
              {loading ? "Analyzing..." : "Analyze"}
            </button>
          </div>

          {error && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-4 text-red-400 text-sm"
            >
              {error}
            </motion.p>
          )}
        </motion.div>

        {/* Scroll hint */}
        {!analysis && !shrinkResult && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 2 }}
            className="absolute bottom-10 flex flex-col items-center gap-3 text-white/20"
          >
            <span className="text-[10px] uppercase tracking-[0.3em]">Scroll</span>
            <div className="w-[1px] h-12 bg-gradient-to-b from-white/30 to-transparent" />
          </motion.div>
        )}
      </section>

      {/* Results */}
      <AnimatePresence>
        {(analysis || shrinkResult) && (
          <motion.section
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="relative z-10 max-w-5xl mx-auto px-4 pb-32"
          >
            {/* Shrink controls */}
            <div className="sticky top-6 z-20 mb-10 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2 bg-white/[0.03] border border-white/10 rounded-xl p-1.5 backdrop-blur-xl">
                {[2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    onClick={() => handleQuickShrink(n)}
                    disabled={loading}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      shrinkResult?.removedCount === n
                        ? "bg-violet-500 text-white"
                        : "text-white/50 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    -{n}
                  </button>
                ))}
                <button
                  onClick={() => setShowShrinkInput(!showShrinkInput)}
                  className="px-3 py-2 rounded-lg text-white/30 hover:text-white/60 text-lg"
                >
                  …
                </button>
              </div>

              {shrinkResult && (
                <motion.div
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="flex items-center gap-3 ml-auto"
                >
                  <span className="text-white/30 text-sm">
                    {shrinkResult.totalOriginal} → {shrinkResult.totalNew} games
                  </span>
                  <button
                    onClick={() => navigator.clipboard.writeText(shrinkResult.newCode)}
                    className="px-5 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm font-mono tracking-widest rounded-xl hover:bg-emerald-500/20 transition-all cursor-pointer"
                  >
                    {shrinkResult.newCode}
                    <span className="ml-2 text-[10px] opacity-50">📋</span>
                  </button>
                </motion.div>
              )}
            </div>

            {/* Custom shrink input */}
            <AnimatePresence>
              {showShrinkInput && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mb-6 flex items-center gap-3"
                >
                  <input
                    type="number"
                    min={1}
                    max={analysis ? analysis.totalSelections - 1 : 20}
                    value={shrinkCount}
                    onChange={(e) => setShrinkCount(parseInt(e.target.value) || 1)}
                    className="w-20 bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-white text-center focus:outline-none focus:border-violet-500/50"
                  />
                  <button
                    onClick={() => handleShrink(shrinkCount)}
                    disabled={loading}
                    className="px-4 py-2 bg-white/10 border border-white/10 text-white text-sm rounded-xl hover:bg-white/20 transition-all"
                  >
                    Shrink
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Game cards */}
            <div className="grid gap-3">
              {(shrinkResult
                ? [...shrinkResult.kept, ...shrinkResult.removed]
                : analysis?.selections || []
              ).map((sel, i) => {
                const isRemoved = removedIds.has(sel.eventId + sel.marketId + sel.outcomeId);
                return (
                  <motion.div
                    key={sel.eventId + sel.marketId + sel.outcomeId}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className={`relative border rounded-xl p-5 transition-all ${
                      isRemoved
                        ? "border-red-500/20 bg-red-500/[0.03] opacity-50 line-through"
                        : riskBg(sel.riskScore)
                    }`}
                  >
                    {/* Risk badge */}
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] uppercase tracking-widest text-white/30">
                            {sel.tournament}
                          </span>
                          {sel.matchStatus !== "Not start" && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[9px] font-bold uppercase">
                              LIVE
                            </span>
                          )}
                        </div>
                        <h3 className="text-base font-semibold text-white/90 truncate">
                          {sel.homeTeam}{" "}
                          <span className="text-white/20 font-normal">vs</span>{" "}
                          {sel.awayTeam}
                        </h3>
                        <p className="text-sm text-white/40 mt-1">
                          {sel.marketDesc} — <span className="text-white/60">{sel.pickDesc}</span>
                        </p>
                        {sel.riskReasons.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {sel.riskReasons.map((r, j) => (
                              <span
                                key={j}
                                className="text-[10px] px-2 py-0.5 rounded-md bg-white/5 text-white/40"
                              >
                                {r}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="text-right shrink-0">
                        <div className={`text-lg font-bold ${riskColor(sel.riskScore)}`}>
                          {sel.riskScore}
                        </div>
                        <div className="text-[10px] uppercase tracking-widest text-white/20 mt-0.5">
                          Risk
                        </div>
                        <div className="text-sm text-white/50 mt-2">{sel.odds}</div>
                      </div>
                    </div>

                    {/* Risk bar */}
                    <div className="mt-4 h-0.5 rounded-full bg-white/5 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${sel.riskScore}%` }}
                        transition={{ delay: i * 0.05, duration: 0.5 }}
                        className={`h-full rounded-full ${
                          sel.riskScore <= 15
                            ? "bg-emerald-500"
                            : sel.riskScore <= 22
                            ? "bg-lime-500"
                            : sel.riskScore <= 28
                            ? "bg-amber-500"
                            : "bg-red-500"
                        }`}
                      />
                    </div>

                    {isRemoved && (
                      <div className="absolute top-3 right-3 text-[9px] uppercase tracking-[0.2em] text-red-400 font-bold">
                        Removed
                      </div>
                    )}
                  </motion.div>
                );
              })}
            </div>

            {/* Empty state */}
            {analysis && analysis.selections.length === 0 && (
              <div className="text-center py-20 text-white/20">
                <p className="text-lg">No selections found</p>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10 text-center text-white/20 text-sm">
        <p>CuxmTier — Not affiliated with SportyBet. Bet responsibly.</p>
      </footer>
    </div>
  );
}
