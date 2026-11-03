// The cleaned sound as a file: 16-bit PCM WAV, every channel, at the rate it was opened at. Written
// a slice at a time into a Blob, so a long recording never needs a second buffer of its full size.
// Levels are kept as they were (only clipped at full scale): the sound lines up with the video's
// own mix when it goes back in.

const SLICE = 1 << 18;

export function wavBlob(channels: Float32Array[], sampleRate: number): Blob {
  const nc = Math.max(1, channels.length);
  const n = channels[0]?.length ?? 0;
  const data = n * nc * 2;
  const header = new DataView(new ArrayBuffer(44));
  const text = (o: number, s: string) => [...s].forEach((ch, i) => header.setUint8(o + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, nc, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * nc * 2, true);
  header.setUint16(32, nc * 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, data, true);
  const parts: BlobPart[] = [header.buffer];
  for (let i = 0; i < n; i += SLICE) {
    const m = Math.min(SLICE, n - i);
    const slice = new DataView(new ArrayBuffer(m * nc * 2));
    for (let j = 0; j < m; j++) {
      for (let c = 0; c < nc; c++) {
        const v = Math.max(-1, Math.min(1, channels[c]?.[i + j] ?? 0));
        slice.setInt16((j * nc + c) * 2, Math.round(v * 32767), true);
      }
    }
    parts.push(slice.buffer);
  }
  return new Blob(parts, { type: "audio/wav" });
}
