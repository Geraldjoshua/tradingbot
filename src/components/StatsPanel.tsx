import type { Stats } from "../types";

function Stat({ k, v, tone }: { k: string; v: string; tone?: "pos" | "neg" }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${tone || ""}`}>{v}</div>
    </div>
  );
}

export default function StatsPanel({ stats, title }: { stats: Stats; title: string }) {
  const tone = (x: number) => (x > 0 ? "pos" : x < 0 ? "neg" : undefined);
  return (
    <div className="panel">
      <div className="spread" style={{ marginBottom: 12 }}>
        <strong>{title}</strong>
        <span className="hint">{stats.n} trades</span>
      </div>
      <div className="stats-grid">
        <Stat k="Win rate" v={`${(stats.winRate * 100).toFixed(1)}%`} />
        <Stat k="Expectancy" v={`${stats.expectancyR >= 0 ? "+" : ""}${stats.expectancyR.toFixed(2)}R`} tone={tone(stats.expectancyR)} />
        <Stat k="Total P/L" v={`$${stats.totalPnl.toFixed(0)}`} tone={tone(stats.totalPnl)} />
        <Stat k="Total R" v={`${stats.totalR >= 0 ? "+" : ""}${stats.totalR.toFixed(1)}R`} tone={tone(stats.totalR)} />
        <Stat k="Avg win" v={`+${stats.avgWinR.toFixed(2)}R`} />
        <Stat k="Avg loss" v={`${stats.avgLossR.toFixed(2)}R`} />
        <Stat k="Profit factor" v={Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞"} tone={tone(stats.profitFactor - 1)} />
        <Stat k="Max drawdown" v={`-${stats.maxDrawdownR.toFixed(1)}R`} tone="neg" />
        <Stat k="Wins / Losses" v={`${stats.wins} / ${stats.losses}`} />
      </div>
      {stats.n < 30 && (
        <p className="hint" style={{ marginTop: 12 }}>
          ⚠ Only {stats.n} trades — too few to be statistically meaningful. Treat as a hint, not proof. Widen the date range / add symbols.
        </p>
      )}
    </div>
  );
}
