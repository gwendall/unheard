// The app's icon, drawn by next/og: a plane's tone bending down as it passes, amber on night blue,
// the site's whole idea in one stroke. Thick enough to read at 32 px, inside the middle 60 % that
// home-screen masks keep.

export function AppIcon({ size }: { size: number }) {
  const pts: string[] = [];
  for (let x = 22; x <= 78; x += 2) pts.push(`${x},${(50 + 13 * Math.tanh((x - 50) / 8)).toFixed(1)}`);
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: "#05070d" }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <path d={`M${pts.join(" L")}`} stroke="#ffb547" strokeOpacity={0.16} strokeWidth={20} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <path d={`M${pts.join(" L")}`} stroke="#ffb547" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </div>
  );
}
