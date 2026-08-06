"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

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
const riskMeta: Record<RiskLevel, { label: string; bar: string; dot: string; text: string }> = {
  safe:     { label: "Safe",     bar: "bg-emerald-400", dot: "bg-emerald-400", text: "text-emerald-400" },
  low:      { label: "Low Risk", bar: "bg-lime-400",    dot: "bg-lime-400",    text: "text-lime-400" },
  medium:   { label: "Moderate", bar: "bg-amber-400",   dot: "bg-amber-400",   text: "text-amber-400" },
  high:     { label: "Risky",    bar: "bg-orange-400",  dot: "bg-orange-500",  text: "text-orange-400" },
  critical: { label: "Avoid",    bar: "bg-red-400",     dot: "bg-red-500",     text: "text-red-400" },
};

const selKey = (s: Selection) => `${s.eventId}|${s.marketId}|${s.outcomeId}`;

export default function Home() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [shrinkResult, setShrinkResult] = useState<{ newCode: string; totalNew: number; removed: Selection[] } | null>(null);
  const [copied, setCopied] = useState("");
  const [autoCode, setAutoCode] = useState("");
  const [autoCount, setAutoCount] = useState(0);

  const analyze = async () => {
    if (!code.trim() || loading) return;
    setLoading(true); setError(""); setAnalysis(null); setShrinkResult(null); setAutoCode("");
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "analyze" }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setAnalysis(d);

      // Auto-generate code for safe picks
      const safe = (d.selections as Selection[]).filter(s => getRiskLevel(s.riskScore) !== "high" && getRiskLevel(s.riskScore) !== "critical");
      if (safe.length > 0 && safe.length < d.selections.length) {
        try {
          const rr = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "shrink", count: d.selections.length - safe.length }) });
          const dd = await rr.json();
          if (rr.ok) { setAutoCode(dd.newCode); setAutoCount(dd.totalNew); }
        } catch {}
      }
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
      setShrinkResult({ newCode: d.newCode, totalNew: d.totalNew, removed: d.removed });
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const addSafe = async () => {
    if (!analysis || loading) return; setLoading(true);
    try {
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "add", count: 3 }) });
      const d = await r.json();
      if (r.ok) {
        const r2 = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: d.newCode, action: "analyze" }) });
        const d2 = await r2.json();
        if (r2.ok) { setAnalysis(d2); setCode(d.newCode); setShrinkResult(null); setAutoCode(""); }
      } else setError(d.error);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const copy = (t: string) => { navigator.clipboard.writeText(t); setCopied(t); setTimeout(() => setCopied(""), 2000); };

  const all = analysis?.selections || [];
  const removedKeys = shrinkResult ? new Set(shrinkResult.removed.map(s => selKey(s))) : new Set<string>();
  const kept = all.filter(s => !removedKeys.has(selKey(s)));
  const removed = all.filter(s => removedKeys.has(selKey(s)));
  const displayCode = shrinkResult?.newCode || autoCode || "";
  const displayCount = shrinkResult?.totalNew || autoCount || 0;

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-white font-sans">
      {/* ── HERO ── */}
      <section className={`flex flex-col items-center justify-center px-6 ${analysis ? "py-20" : "min-h-screen"}`}>
        <div className="w-full max-w-lg mx-auto text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-3">
            Cuxm<span className="text-violet-400">Tier</span>
          </h1>
          <p className="text-white/25 text-sm mb-8">Analyze your SportyBet slip. Keep the safe picks, cut the rest.</p>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && analyze()}
              placeholder="S9C3D6" spellCheck={false}
              className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-5 py-3.5 text-lg font-mono tracking-[0.12em] text-white placeholder:text-white/[0.10] focus:outline-none focus:border-violet-500/40 transition-all" />
            <button onClick={analyze} disabled={loading || !code.trim()}
              className="shrink-0 px-6 py-3.5 bg-violet-600 text-white font-semibold rounded-xl hover:bg-violet-500 disabled:opacity-20 disabled:cursor-not-allowed transition-all text-sm">
              {loading ? "…" : "Analyze"}
            </button>
          </div>
          {error && <p className="mt-4 text-red-400/70 text-sm">{error}</p>}
        </div>
      </section>

      {/* ── RESULTS ── */}
      <AnimatePresence>
        {analysis && (
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-2xl mx-auto px-6 pb-40">
            {/* Auto-keep code */}
            {displayCode && (
              <div className="mb-8 p-5 rounded-2xl bg-emerald-500/[0.04] border border-emerald-500/15">
                <p className="text-[11px] uppercase tracking-[0.15em] text-white/20 mb-1">
                  {shrinkResult ? "New code" : "Auto-keep code"} — Keeping {displayCount} of {analysis.totalSelections}
                </p>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xl font-mono tracking-[0.1em] text-white/70">{displayCode}</p>
                  <button onClick={() => copy(displayCode)}
                    className={`shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                      copied === displayCode ? "bg-emerald-500/15 text-emerald-300" : "bg-white/[0.04] border border-white/[0.08] text-white/40 hover:text-white hover:bg-white/[0.06]"
                    }`}>{copied === displayCode ? "Copied" : "Copy"}</button>
                </div>
                {!shrinkResult && <p className="text-[11px] text-white/10 mt-2">Auto-picked from safe selections. Use the buttons below to adjust how many to remove.</p>}
              </div>
            )}

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-2 mb-10">
              <span className="text-[10px] text-white/15 uppercase tracking-wider mr-1">Remove:</span>
              {[2, 3, 4, 5, 6].map((n) => (
                <button key={n} onClick={() => shrink(n)}
                  className={`w-9 h-9 rounded-lg text-xs font-semibold transition-all ${
                    shrinkResult?.removed.length === n ? "bg-violet-600 text-white" : "bg-white/[0.03] border border-white/[0.06] text-white/30 hover:text-white/70"
                  }`}>-{n}</button>
              ))}
              <button onClick={addSafe} disabled={loading}
                className="ml-2 px-3.5 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-wider bg-emerald-500/8 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/15 transition-all disabled:opacity-30">
                + Add Safe Bets
              </button>
            </div>

            {/* Kept */}
            <div className="mb-8">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30 mb-3">Keeping · {kept.length} games</h2>
              <div className="space-y-2">
                {kept.length === 0 && <p className="text-white/[0.04] text-sm py-4">All games removed</p>}
                {kept.map((s, i) => <Card key={selKey(s)} s={s} i={i} />)}
              </div>
            </div>

            {/* Removed */}
            {removed.length > 0 && (
              <div>
                <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-red-400/40 mb-3">Removed · {removed.length} games</h2>
                <div className="space-y-2 opacity-60">
                  {removed.map((s, i) => <Card key={selKey(s)} s={s} i={i} removed />)}
                </div>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      <footer className="border-t border-white/[0.03] py-10 text-center text-[11px] text-white/[0.06] uppercase tracking-[0.2em]">
        CuxmTier · Not affiliated with SportyBet
      </footer>
    </div>
  );
}

// ── Game Card ──
function Card({ s, i, removed }: { s: Selection; i: number; removed?: boolean }) {
  const risk = getRiskLevel(s.riskScore);
  const m = riskMeta[risk];

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: i * 0.012 }}
      className={`relative border rounded-xl px-5 py-4 transition-colors ${
        removed ? "bg-red-500/[0.02] border-red-500/[0.08]" : "bg-white/[0.01] border-white/[0.04]"
      }`}
    >
      <div className="flex items-start gap-4">
        {/* Color bar + dot */}
        <div className="shrink-0 flex flex-col items-center gap-2 pt-1">
          <div className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
          <div className={`w-0.5 flex-1 rounded-full ${m.bar} opacity-20`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] uppercase tracking-[0.1em] text-white/12 truncate">{s.tournament}</span>
            {s.matchStatus !== "Not start" && <span className="text-[9px] font-bold text-amber-500/50">LIVE</span>}
          </div>
          <h3 className="text-[14px] font-medium tracking-tight text-white/75 truncate">
            {s.homeTeam} <span className="text-white/8 mx-1">vs</span> {s.awayTeam}
          </h3>
          <p className="text-[12px] text-white/20 mt-0.5">
            {s.marketDesc} — {s.pickDesc} <span className="ml-1.5 text-white/12">@{s.odds}</span>
          </p>

          {/* Reasons — plain English */}
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {s.safeReasons?.map((r, j) => (
              <span key={"safe"+j} className="text-[9px] px-1.5 py-[2px] rounded bg-emerald-500/[0.06] text-emerald-400/70">{r}</span>
            ))}
            {s.riskReasons?.map((r, j) => (
              <span key={"risk"+j} className={`text-[9px] px-1.5 py-[2px] rounded ${removed ? "bg-white/[0.02] text-white/15" : "bg-red-500/[0.05] text-red-400/60"}`}>{r}</span>
            ))}
          </div>
        </div>

        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${removed ? "text-white/15" : m.text}`}>
            {risk}
          </span>
          <span className={`text-lg font-bold ${removed ? "text-white/15" : m.text}`}>{s.riskScore}</span>
        </div>
      </div>
    </motion.div>
  );
}
