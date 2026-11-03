// The link preview: a plane's tone bending down as it passes, on a quiet night spectrogram, under
// the site's own line. Drawn by next/og (Satori): flexbox only, inline SVG, fonts passed in.

export const OG_SIZE = { width: 1200, height: 630 };

const W = OG_SIZE.width;
const H = OG_SIZE.height;
const NIGHT = "#05070d";
const INK = "#e9edf5";
const MUTE = "#8d97ab";
const AMBER = "#ffb547";
const AMBER_SOFT = "#ffd58f";

// The spectrogram's noise floor: indigo cells, louder toward the low frequencies at the bottom,
// as wind and traffic are in a real recording. Seeded, so every build draws the same card.
const CELL = 10;
function noiseCells() {
  let seed = 7;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cells: { x: number; y: number; a: number }[] = [];
  for (let y = 0; y < H; y += CELL) {
    const floor = Math.pow(y / H, 2.2);
    for (let x = 0; x < W; x += CELL) {
      const a = floor * (0.12 + 0.5 * rand() ** 3);
      if (a > 0.02) cells.push({ x, y, a: Number(a.toFixed(2)) });
    }
  }
  return cells;
}

// One tone, as a narrow band of a spectrogram shows it: higher while the plane comes toward you,
// lower once it leaves, loudest at the bend in the middle of the card, where it passes closest.
function doppler() {
  const pts: string[] = [];
  for (let x = -20; x <= W + 20; x += 8) pts.push(`${x},${(515 + 62 * Math.tanh((x - W / 2) / 110)).toFixed(1)}`);
  return `M${pts.join(" L")}`;
}

function Spectrogram() {
  const d = doppler();
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", top: 0, left: 0 }}>
      <defs>
        <linearGradient id="tone" x1="0" x2="1">
          <stop offset="0" stopColor={AMBER} stopOpacity="0.2" />
          <stop offset="0.5" stopColor={AMBER_SOFT} stopOpacity="1" />
          <stop offset="1" stopColor={AMBER} stopOpacity="0.2" />
        </linearGradient>
        <filter id="blur" x="-10%" y="-100%" width="120%" height="300%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
        <linearGradient id="glow" x1="0" x2="1">
          <stop offset="0" stopColor={AMBER} stopOpacity="0.08" />
          <stop offset="0.5" stopColor={AMBER} stopOpacity="0.6" />
          <stop offset="1" stopColor={AMBER} stopOpacity="0.08" />
        </linearGradient>
      </defs>
      {noiseCells().map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={CELL} height={CELL} fill="#1e285c" fillOpacity={c.a} />
      ))}
      <path d={d} stroke="url(#glow)" strokeWidth={30} fill="none" filter="url(#blur)" />
      <path d={d} stroke="url(#tone)" strokeWidth={7} fill="none" />
    </svg>
  );
}

export function OgCard() {
  return (
    <div style={{ width: W, height: H, display: "flex", position: "relative", backgroundColor: NIGHT, backgroundImage: "radial-gradient(120% 70% at 50% -10%, rgba(64, 88, 160, 0.28), transparent 60%)" }}>
      <Spectrogram />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", paddingTop: 52 }}>
        <div style={{ fontFamily: "GeistMono", fontSize: 40, letterSpacing: 8, color: AMBER }}>UNHEARD</div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: 26, fontFamily: "Geist", fontWeight: 600, fontSize: 100, lineHeight: 1.04, letterSpacing: -3, color: INK }}>
          <div style={{ whiteSpace: "nowrap" }}>There’s a plane</div>
          <div style={{ whiteSpace: "nowrap" }}>you can’t hear.</div>
        </div>
        <div style={{ marginTop: 26, fontFamily: "Geist", fontWeight: 500, fontSize: 42, color: MUTE, whiteSpace: "nowrap" }}>Your phone hears it. Unheard names it.</div>
      </div>
    </div>
  );
}
