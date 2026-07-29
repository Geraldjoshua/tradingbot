import { useEffect, useRef } from "react";
import {
  createChart, ColorType, LineStyle,
  type IChartApi, type Time, type SeriesMarker, type UTCTimestamp,
} from "lightweight-charts";

export interface LineDef {
  color: string;
  data: { date: string; value: number }[];
  lineWidth?: number;
}

// Simple multi-line chart (price+SMA, or two equity curves) with optional markers.
export default function LineChart({
  lines, markers, height = 320,
}: { lines: LineDef[]; markers?: SeriesMarker<Time>[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: "#181c22" }, textColor: "#8a93a0" },
      grid: { vertLines: { color: "#22272f" }, horzLines: { color: "#22272f" } },
      timeScale: { timeVisible: false, borderColor: "#2a3038" },
      rightPriceScale: { borderColor: "#2a3038" },
      autoSize: true,
    });
    chartRef.current = chart;
    const toTs = (d: string) => (Date.parse(d) / 1000) as UTCTimestamp;

    lines.forEach((ln, idx) => {
      const s = chart.addLineSeries({
        color: ln.color, lineWidth: (ln.lineWidth || 2) as any,
        lineStyle: idx === 1 && lines.length === 2 && ln.color.includes("8a93") ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false, lastValueVisible: true,
      });
      const seen = new Set<number>();
      const data = [];
      for (const p of ln.data) {
        const t = toTs(p.date);
        if (seen.has(t)) continue;
        seen.add(t);
        data.push({ time: t as Time, value: p.value });
      }
      s.setData(data);
      if (idx === 0 && markers?.length) s.setMarkers([...markers].sort((a, b) => (a.time as number) - (b.time as number)));
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [lines, markers, height]);

  return <div style={{ height }} ref={ref} />;
}
