"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";

interface PickInfo {
  marketDesc: string;
  pickDesc: string;
  odds: number;
  probability: number;
  winProb: number;
  evPercent: number;
}

interface Leg {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  tournament: string;
  category: string;
  sportId: string;
  changed: boolean;
  original: PickInfo;
  altered: PickInfo | null;
  reason: string;
}

interface AlterResult {
  originalCode: string;
  newCode: string;
  totalOriginalOdds: number;
  totalNewOdds: number;
  changedCount: number;
  legs: Leg[];
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
const emoji = (id: string) => SPORT_EMOJI[id] || "";

function evColor(ev: number) {
  if (ev > 15) return "text-emerald-400";
  if (ev > 5) return "text-lime-400";
  if (ev > 0) return "text-lime-400/60";
  if (ev > -10) return "text-amber-400";
  return "text-red-400";
}

export default function AlterPage() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AlterResult | null>(null);
  const [copied, setCopied] = useState("");

  const alter = async () => {
    if (!code.trim() || loading) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), action: "alter" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to alter");
      setResult(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const copy = (t: string) => {
    navigator.clipboard.writeText(t);
    setCopied(t);
    setTimeout(() => setCopied(""), 2000);
  };

  return (
    <div className="min-h-screen bg-[#07070a] text-white font-sans relative overflow-x-hidden">
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[500px] rounded-full bg-violet-600/[0.13] blur-[130px]" />
        <div className="absolute top-1/3 -left-40 w-[450px] h-[450px] rounded-full bg-emerald-500/[0.07] blur-[120px]" />
        <div className="absolute bottom-0 -right-40 w-[500px] h-[500px] rounded-full bg-amber-500/[0.06] blur-[130px]" />
      </div>

      <div className="relative z-10 max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
        {/* Header */}
        <div className="text-center mb-8">
          <Link href="/" className="inline-block text-[11px] font-semibold uppercase tracking-[0.25em] text-white/30 hover:text-white/60 transition-all mb-6">
            ← Back to CuxmTier
          </Link>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-3">
            Alter<span className="text-emerald-400">Me</span>
          </h1>
          <p className="text-sm text-white/35 max-w-md mx-auto leading-relaxed">
            Paste a ticket and every leg is auto-swapped to its best option — highest win probability + edge, powered by match history.
          </p>
        </div>

        {/* Input */}
        <div className="flex gap-2 mb-4">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && alter()}
            placeholder="sportybet code"
            spellCheck={false}
            className="flex-1 bg-white/[0.03] border border-white/[0.08] rounded-2xl px-5 py-4 text-base font-mono tracking-[0.12em] text-white placeholder:text-white/20 focus:outline-none focus:border-emerald-500/50 focus:bg-white/[0.05] transition-all backdrop-blur"
          />
          <button
            onClick={alter}
            disabled={loading || !code.trim()}
            className="shrink-0 px-7 py-4 bg-emerald-600 text-white font-semibold rounded-2xl hover:bg-emerald-500 disabled:opacity-25 disabled:cursor-not-allowed transition-all text-sm shadow-lg shadow-emerald-600/20"
          >
            {loading ? "..." : "Alter"}
          </button>
        </div>
        {error && <p className="mb-4 text-red-400/70 text-sm text-center">{error}</p>}

        {/* Results */}
        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-4"
            >
              {/* Summary card */}
              <div className="p-5 rounded-2xl bg-white/[0.03] border border-white/[0.08] backdrop-blur">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[11px] uppercase tracking-[0.15em] text-white/35">Altered slip</span>
                  <span className="text-sm font-semibold text-emerald-400">
                    {result.changedCount} of {result.legs.length} legs swapped
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                    <div className="text-[10px] uppercase tracking-wider text-white/30 mb-1">Original odds</div>
                    <div className="text-2xl font-bold text-white/70">{result.totalOriginalOdds}x</div>
                  </div>
                  <div className="p-3 rounded-xl bg-emerald-500/[0.06] border border-emerald-500/20">
                    <div className="text-[10px] uppercase tracking-wider text-emerald-300/50 mb-1">Altered odds</div>
                    <div className="text-2xl font-bold text-emerald-300">{result.totalNewOdds}x</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-4 py-3 rounded-xl bg-black/30 border border-white/[0.08] font-mono text-sm tracking-[0.1em] text-emerald-300 truncate">
                    {result.newCode}
                  </code>
                  <button
                    onClick={() => copy(result.newCode)}
                    className="shrink-0 px-4 py-3 bg-white/[0.05] border border-white/[0.08] rounded-xl text-xs text-white/50 hover:text-white hover:bg-white/[0.1] transition-all"
                  >
                    {copied === result.newCode ? "✓" : "Copy"}
                  </button>
                </div>
              </div>

              {/* Leg-by-leg */}
              {result.legs.map((leg, i) => (
                <div
                  key={i}
                  className={`p-4 rounded-2xl border backdrop-blur transition-all ${
                    leg.changed
                      ? "bg-emerald-500/[0.04] border-emerald-500/25"
                      : "bg-white/[0.02] border-white/[0.06]"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm">{emoji(leg.sportId)}</span>
                    <span className="text-sm font-semibold text-white/85 truncate">
                      {leg.homeTeam} <span className="text-white/25">vs</span> {leg.awayTeam}
                    </span>
                    <span className="ml-auto text-[10px] text-white/25 truncate">{leg.tournament}</span>
                  </div>

                  <div className="flex items-center gap-3 mt-2 text-sm">
                    <div className={`flex-1 min-w-0 ${leg.changed ? "line-through text-white/30" : "text-white/70"}`}>
                      <span className="text-white/35">{leg.original.marketDesc}: </span>
                      <span className="font-medium">{leg.original.pickDesc}</span>
                      <span className="text-white/30"> @ {leg.original.odds}</span>
                      <span className={`ml-2 text-[11px] font-semibold ${evColor(leg.original.evPercent)}`}>
                        {leg.original.evPercent > 0 ? "+" : ""}{leg.original.evPercent}%
                      </span>
                    </div>
                    {leg.changed && leg.altered && (
                      <>
                        <span className="text-emerald-400">→</span>
                        <div className="flex-1 min-w-0 text-emerald-300">
                          <span className="text-emerald-200/50">{leg.altered.marketDesc}: </span>
                          <span className="font-medium">{leg.altered.pickDesc}</span>
                          <span className="text-emerald-200/50"> @ {leg.altered.odds}</span>
                          <span className={`ml-2 text-[11px] font-semibold ${evColor(leg.altered.evPercent)}`}>
                            {leg.altered.evPercent > 0 ? "+" : ""}{leg.altered.evPercent}%
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  <p className={`mt-2 text-[11px] leading-relaxed ${leg.changed ? "text-emerald-300/60" : "text-white/25"}`}>
                    {leg.reason}
                  </p>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Empty state */}
        {!result && !loading && (
          <div className="text-center py-10 text-white/20 text-sm">
            Paste a SportyBet booking code and hit <span className="text-emerald-400/60 font-mono">Alter</span>.
          </div>
        )}
      </div>
    </div>
  );
}
