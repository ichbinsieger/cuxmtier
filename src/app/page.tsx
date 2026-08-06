"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface Selection {
  homeTeam: string; awayTeam: string; tournament: string;
  marketDesc: string; pickDesc: string; odds: number;
  probability: number; matchStatus: string;
  riskScore: number; riskReasons: string[]; safeReasons: string[];
  eventId: string; marketId: string; outcomeId: string;
  specifierRaw?: string; productId: number; sportId: string;
  sigma: number; failProb: number;
  kellyFraction: number; kellyLabel: string;
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

  const all: Selection[] = data?.selections || [];
  const removedList = all.filter(s => removedIds.has(selKey(s)));
  const keptList = all.filter(s => !removedIds.has(selKey(s)));

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
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const reset = () => {
    setData(null); setRemovedIds(new Set()); setResultCode(""); setPortfolioAfter(0); setFailAfter(0); setShrinkN(0);
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
    setResultCode(""); // clear auto-code when manually changing
  };

  const regenerateCode = async () => {
    if (!code.trim() || loading || keptList.length === 0) return;
    setLoading(true); setError("");
    try {
      const keys = Array.from(removedIds);
      const r = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.trim(), action: "custom", removeIds: keys }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setResultCode(d.newCode);
      setPortfolioAfter(d.portfolioVolAfter);
      setFailAfter(d.failureProbAfter);
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

  const copy = (t: string) => { navigator.clipboard.writeText(t); setCopied(t); setTimeout(() => setCopied(""), 2000); };

  const volColor = (v: number) => v > 200 ? "text-red-400" : v > 100 ? "text-amber-400" : v > 50 ? "text-lime-400" : "text-emerald-400";
  const failColor = (f: number) => f > 80 ? "text-red-400" : f > 60 ? "text-amber-400" : f > 40 ? "text-lime-400" : "text-emerald-400";

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-white font-sans">
      {/* Hero */}
      <section className={`flex flex-col items-center justify-center px-6 ${data ? "py-16" : "min-h-screen"}`}>
        <div className="w-full max-w-lg mx-auto text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-3">Cuxm<span className="text-violet-400">Tier</span></h1>
          <p className="text-white/25 text-sm mb-8">Analyze your slip. Remove the noise. Get a tighter code.</p>
          <div className="flex gap-2">
            <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && analyze()}
              placeholder="S9C3D6" spellCheck={false}
              className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-xl px-5 py-3.5 text-lg font-mono tracking-[0.12em] text-white placeholder:text-white/[0.10] focus:outline-none focus:border-violet-500/40 transition-all" />
            <button onClick={analyze} disabled={loading || !code.trim()}
              className="shrink-0 px-6 py-3.5 bg-violet-600 text-white font-semibold rounded-xl hover:bg-violet-500 disabled:opacity-20 disabled:cursor-not-allowed transition-all text-sm">Analyze</button>
            {data && <button onClick={reset} className="shrink-0 px-4 py-3.5 bg-white/[0.04] border border-white/[0.08] text-white/40 text-sm rounded-xl hover:bg-white/[0.08] hover:text-white/70 transition-all">Reset</button>}
          </div>
          {error && <p className="mt-3 text-red-400/70 text-sm">{error}</p>}
        </div>
      </section>

      <AnimatePresence>
        {data && (
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="max-w-2xl mx-auto px-6 pb-40">
            {/* ── PORTFOLIO GAUGE ── */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div className="bg-white/[0.02] border border-white/[0.05] rounded-2xl p-5">
                <p className="text-[10px] uppercase tracking-[0.15em] text-white/20 mb-2">Portfolio Volatility</p>
                <div className="flex items-end gap-2">
                  <span className={`text-2xl font-bold ${volColor(portfolioAfter || portfolioBefore)}`}>
                    {portfolioAfter || portfolioBefore}%
                  </span>
                  {portfolioAfter > 0 && portfolioBefore > 0 && (
                    <span className="text-sm text-emerald-400/70 mb-0.5">
                      ↓ {portfolioBefore - portfolioAfter}%
                    </span>
                  )}
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${volColor(portfolioAfter || portfolioBefore)}`}
                    style={{ width: `${Math.min(100, (portfolioAfter || portfolioBefore) / 3)}%`, opacity: 0.6 }} />
                </div>
              </div>
              <div className="bg-white/[0.02] border border-white/[0.05] rounded-2xl p-5">
                <p className="text-[10px] uppercase tracking-[0.15em] text-white/20 mb-2">Failure Probability</p>
                <div className="flex items-end gap-2">
                  <span className={`text-2xl font-bold ${failColor(failAfter || failBefore)}`}>
                    {failAfter || failBefore}%
                  </span>
                  {failAfter > 0 && failBefore > 0 && (
                    <span className="text-sm text-emerald-400/70 mb-0.5">
                      ↓ {failBefore - failAfter}%
                    </span>
                  )}
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className={`h-full rounded-full transition-all duration-500 ${failColor(failAfter || failBefore)}`}
                    style={{ width: `${failAfter || failBefore}%`, opacity: 0.6 }} />
                </div>
              </div>
            </div>

            {/* Correlation warnings */}
            {data.correlationWarnings?.length > 0 && (
              <div className="mb-6 p-4 rounded-xl bg-amber-500/[0.05] border border-amber-500/15">
                {data.correlationWarnings.map((w: string, i: number) => (
                  <p key={i} className="text-[11px] text-amber-400/70">⚠ {w}</p>
                ))}
              </div>
            )}

            {/* Result code */}
            {resultCode && (
              <div className="mb-6 p-5 rounded-2xl bg-emerald-500/[0.04] border border-emerald-500/15">
                <p className="text-[11px] uppercase tracking-[0.15em] text-white/20 mb-1">New Code — {keptList.length} of {all.length} kept</p>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xl font-mono tracking-[0.1em] text-white/70">{resultCode}</p>
                  <button onClick={() => copy(resultCode)}
                    className={`shrink-0 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                      copied === resultCode ? "bg-emerald-500/15 text-emerald-300" : "bg-white/[0.04] border border-white/[0.08] text-white/40 hover:text-white hover:bg-white/[0.06]"
                    }`}>{copied === resultCode ? "Copied" : "Copy"}</button>
                </div>
              </div>
            )}

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-2 mb-8">
              <span className="text-[10px] text-white/15 uppercase tracking-wider mr-1">Auto-remove:</span>
              {[2, 3, 4, 5, 6].map(n => (
                <button key={n} onClick={() => doShrink(n)}
                  className={`w-9 h-9 rounded-lg text-xs font-semibold transition-all ${
                    shrinkN === n ? "bg-violet-600 text-white" : "bg-white/[0.03] border border-white/[0.06] text-white/30 hover:text-white/70"
                  }`}>-{n}</button>
              ))}
              <div className="w-px h-6 bg-white/[0.06] mx-1" />
              <button onClick={addSafe} disabled={loading}
                className="px-3 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-wider bg-emerald-500/8 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/15 transition-all disabled:opacity-30">+ Add Safe</button>
              {removedIds.size > 0 && !resultCode && (
                <button onClick={regenerateCode} disabled={loading}
                  className="px-3 py-2 rounded-xl text-[11px] font-semibold uppercase tracking-wider bg-violet-500/10 border border-violet-500/25 text-violet-300 hover:bg-violet-500/20 transition-all">Get Code</button>
              )}
              <span className="text-[10px] text-white/10 ml-auto">Tap × to remove individually</span>
            </div>

            {/* Keeping */}
            <div className="mb-8">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/30 mb-3">Keeping · {keptList.length} games</h2>
              <div className="space-y-2">
                {keptList.length === 0 && <p className="text-white/[0.04] text-sm py-4">None kept</p>}
                {keptList.map((s, i) => <Card key={selKey(s)} s={s} i={i} onRemove={() => toggleRemove(s)} />)}
              </div>
            </div>

            {/* Removed */}
            {removedList.length > 0 && (
              <div>
                <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-red-400/40 mb-3">Removed · {removedList.length} games</h2>
                <div className="space-y-2 opacity-55">
                  {removedList.map((s, i) => <Card key={selKey(s)} s={s} i={i} removed />)}
                </div>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

function Card({ s, i, removed, onRemove }: { s: Selection; i: number; removed?: boolean; onRemove?: () => void }) {
  const rl = riskLevel(s.riskScore);
  const m = riskMeta[rl];
  const kel = s.kellyLabel === "strong bet" ? "text-emerald-400" : s.kellyLabel === "bet" ? "text-lime-400" : "text-red-400/60";

  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.012 }}
      className={`relative group border rounded-xl px-5 py-4 transition-colors ${
        removed ? "bg-red-500/[0.02] border-red-500/[0.08]" : "bg-white/[0.01] border-white/[0.04] hover:border-white/[0.10]"
      }`}
    >
      {/* Remove button */}
      {onRemove && (
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-white/[0.06] border border-white/[0.08] flex items-center justify-center text-white/30 hover:bg-red-500/20 hover:border-red-500/30 hover:text-red-400 transition-all opacity-0 group-hover:opacity-100 text-xs">×</button>
      )}

      <div className="flex items-start gap-4">
        <div className="shrink-0 pt-1"><div className={`w-1.5 h-1.5 rounded-full ${m.dot}`} /></div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] uppercase tracking-[0.1em] text-white/12 truncate">{s.tournament}</span>
            {s.matchStatus !== "Not start" && <span className="text-[9px] font-bold text-amber-500/50">LIVE</span>}
          </div>
          <h3 className="text-[14px] font-medium tracking-tight text-white/75 truncate">{s.homeTeam} <span className="text-white/8 mx-1">vs</span> {s.awayTeam}</h3>
          <p className="text-[12px] text-white/20 mt-0.5">{s.marketDesc} — {s.pickDesc} <span className="ml-1.5 text-white/12">@{s.odds}</span></p>
          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {s.safeReasons?.map((r, j) => <span key={"s"+j} className="text-[9px] px-1.5 py-[2px] rounded bg-emerald-500/[0.06] text-emerald-400/70">{r}</span>)}
            {s.riskReasons?.map((r, j) => <span key={"r"+j} className={`text-[9px] px-1.5 py-[2px] rounded ${removed ? "bg-white/[0.02] text-white/15" : "bg-red-500/[0.05] text-red-400/60"}`}>{r}</span>)}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${removed ? "text-white/15" : m.text}`}>{m.label}</span>
          <span className={`text-lg font-bold ${removed ? "text-white/15" : m.text}`}>{s.riskScore}</span>
          <span className={`text-[9px] font-medium ${removed ? "text-white/10" : kel}`}>{s.kellyLabel}</span>
        </div>
      </div>
    </motion.div>
  );
}
