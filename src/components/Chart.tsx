import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type CandlestickData,
  type Time,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar, Trade } from "../types";

// Candlestick chart of one symbol's bars with entry/exit markers per trade.
export default function Chart({ bars, trades }: { bars: Bar[]; trades: Trade[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#181c22" },
        textColor: "#8a93a0",
      },
      grid: {
        vertLines: { color: "#22272f" },
        horzLines: { color: "#22272f" },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a3038" },
      rightPriceScale: { borderColor: "#2a3038" },
      autoSize: true,
    });
    chartRef.current = chart;
    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    const toTs = (iso: string) => (Date.parse(iso) / 1000) as UTCTimestamp;

    // De-dupe by timestamp (lightweight-charts requires strictly ascending unique times)
    const seen = new Set<number>();
    const data: CandlestickData[] = [];
    for (const b of bars) {
      const t = toTs(b.t);
      if (seen.has(t)) continue;
      seen.add(t);
      data.push({ time: t as Time, open: b.o, high: b.h, low: b.l, close: b.c });
    }
    series.setData(data);

    const markers: SeriesMarker<Time>[] = [];
    for (const tr of trades) {
      markers.push({
        time: toTs(tr.entryTime) as Time,
        position: tr.side === "long" ? "belowBar" : "aboveBar",
        color: "#4c9aff",
        shape: tr.side === "long" ? "arrowUp" : "arrowDown",
        text: `${tr.side === "long" ? "L" : "S"} @${tr.entry.toFixed(2)}`,
      });
      markers.push({
        time: toTs(tr.exitTime) as Time,
        position: tr.side === "long" ? "aboveBar" : "belowBar",
        color: tr.r > 0 ? "#26a69a" : "#ef5350",
        shape: "circle",
        text: `${tr.outcome} ${tr.r > 0 ? "+" : ""}${tr.r.toFixed(1)}R`,
      });
    }
    // markers must be sorted ascending by time
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(markers);
    chart.timeScale().fitContent();

    return () => chart.remove();
  }, [bars, trades]);

  return <div className="chartbox" ref={ref} />;
}
