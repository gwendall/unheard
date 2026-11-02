"use client";

import { useEffect, useRef } from "react";
import { colorOf } from "@/lib/client/colormap";

/**
 * The live spectrum, 0 to `maxHz`, scrolling left. Each frequency is drawn against its own slowly
 * moving average, so a steady hum fades out and a faint changing line shows up.
 */
export function Waterfall({ analyser, maxHz = 800 }: { analyser: AnalyserNode; maxHz?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const rows = Math.min(analyser.frequencyBinCount, Math.floor(maxHz / binHz));
    el.width = 480;
    el.height = rows;
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, el.width, el.height);
    const data = new Float32Array(analyser.frequencyBinCount);
    const baseline = new Float32Array(rows).fill(NaN);
    const column = ctx.createImageData(1, rows);
    let last = 0;
    let frame = 0;
    const draw = (t: number) => {
      frame = requestAnimationFrame(draw);
      if (t - last < 100) return;
      last = t;
      analyser.getFloatFrequencyData(data);
      for (let b = 0; b < rows; b++) {
        const v = Number.isFinite(data[b]) ? data[b] : -160;
        baseline[b] = Number.isNaN(baseline[b]) ? v : baseline[b] * 0.97 + v * 0.03;
        const [r, g, bl] = colorOf((v - baseline[b] + 1) / 12);
        const y = rows - 1 - b;
        column.data[y * 4] = r;
        column.data[y * 4 + 1] = g;
        column.data[y * 4 + 2] = bl;
        column.data[y * 4 + 3] = 255;
      }
      ctx.drawImage(el, -1, 0);
      ctx.putImageData(column, el.width - 1, 0);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser, maxHz]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-night">
      <canvas ref={canvas} className="block h-44 w-full sm:h-56" aria-label="Live spectrum of what the microphone hears" />
      <div className="pointer-events-none absolute inset-y-2 left-3 flex flex-col justify-between font-mono text-[10px] text-faint">
        <span>{maxHz} Hz</span>
        <span>0 Hz</span>
      </div>
    </div>
  );
}
