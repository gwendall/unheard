// The microphone, raw. Echo cancellation, noise suppression and automatic gain are all off:
// each of them is built to erase exactly the faint steady hum we are looking for.

export async function openMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    video: false,
  });
}

export type Captured = {
  /** Mono samples at the device rate. */
  samples: Float32Array;
  sampleRate: number;
  /** UTC seconds of the first sample. */
  start: number;
};

export class Capture {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly settings: MediaTrackSettings;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private length = 0;
  private firstFrame = -1;
  private startUtc: number | null = null;
  private recording = false;

  private constructor(
    private readonly stream: MediaStream,
    ctx: AudioContext,
  ) {
    this.ctx = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 16384;
    this.analyser.smoothingTimeConstant = 0;
    this.settings = stream.getAudioTracks()[0]?.getSettings() ?? {};
  }

  /** An audio context, made synchronously inside the tap: iOS only lets audio start from one. */
  static context(): AudioContext {
    return new AudioContext({ latencyHint: "playback" });
  }

  /** Opens the audio graph on a stream, in a context from Capture.context(). */
  static async open(stream: MediaStream, ctx: AudioContext): Promise<Capture> {
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule("/capture-worklet.js");
    const c = new Capture(stream, ctx);
    c.source = ctx.createMediaStreamSource(stream);
    // Nothing is ever played: the graph ends in a silent gain so the browser keeps pulling it.
    c.sink = ctx.createGain();
    c.sink.gain.value = 0;
    c.sink.connect(ctx.destination);
    c.source.connect(c.analyser);
    c.analyser.connect(c.sink);
    c.node = new AudioWorkletNode(ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    c.node.port.onmessage = (e: MessageEvent<{ frame: number; data: Float32Array }>) => c.take(e.data.frame, e.data.data);
    c.source.connect(c.node);
    c.node.connect(c.sink);
    return c;
  }

  get inputSampleRate() {
    return this.ctx.sampleRate;
  }

  /** Seconds recorded so far. */
  get seconds() {
    return this.length / this.ctx.sampleRate;
  }

  begin() {
    this.chunks = [];
    this.length = 0;
    this.firstFrame = -1;
    this.startUtc = null;
    this.recording = true;
  }

  private take(frame: number, data: Float32Array) {
    if (!this.recording) return;
    if (this.firstFrame < 0) {
      this.firstFrame = frame;
      this.startUtc = utcOfFrame(this.ctx, frame);
    } else {
      // A gap (the tab was starved): keep the timeline straight with silence.
      const expected = this.firstFrame + this.length;
      if (frame > expected) {
        const gap = new Float32Array(frame - expected);
        this.chunks.push(gap);
        this.length += gap.length;
      }
    }
    this.chunks.push(data);
    this.length += data.length;
  }

  end(): Captured | null {
    this.recording = false;
    if (this.startUtc === null || !this.length) return null;
    const samples = new Float32Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      samples.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    return { samples, sampleRate: this.ctx.sampleRate, start: this.startUtc };
  }

  async close() {
    this.recording = false;
    this.node?.port.close();
    this.source?.disconnect();
    this.node?.disconnect();
    this.analyser.disconnect();
    this.sink?.disconnect();
    for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx.state !== "closed") await this.ctx.close();
  }
}

/** UTC seconds of an audio frame, through the context's clock and the page's high-resolution one. */
function utcOfFrame(ctx: AudioContext, frame: number): number {
  const contextTime = frame / ctx.sampleRate;
  if (typeof ctx.getOutputTimestamp === "function") {
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return (performance.timeOrigin + ts.performanceTime - (ts.contextTime - contextTime) * 1000) / 1000;
    }
  }
  return Date.now() / 1000 - (ctx.currentTime - contextTime);
}

/** Resamples to `rate` with the browser's own resampler, or a windowed-sinc one where it refuses. */
export async function resample(samples: Float32Array, from: number, rate: number): Promise<Float32Array> {
  if (from === rate) return samples;
  try {
    const length = Math.floor((samples.length * rate) / from);
    const offline = new OfflineAudioContext(1, length, rate);
    const buffer = offline.createBuffer(1, samples.length, from);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start();
    const out = await offline.startRendering();
    return out.getChannelData(0).slice();
  } catch {
    return resampleSinc(samples, from, rate);
  }
}

function resampleSinc(samples: Float32Array, from: number, rate: number): Float32Array {
  const ratio = from / rate;
  const cutoff = (0.45 * rate) / from;
  const half = 32;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const center = i * ratio;
    const c = Math.floor(center);
    let sum = 0;
    let wsum = 0;
    for (let k = c - half + 1; k <= c + half; k++) {
      if (k < 0 || k >= samples.length) continue;
      const x = k - center;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
      sum += samples[k] * sinc * w;
      wsum += sinc * w;
    }
    out[i] = wsum ? sum / wsum : 0;
  }
  return out;
}

/** Keeps the screen on while recording, where the browser allows it. Returns the release. */
export async function keepAwake(): Promise<() => void> {
  try {
    const lock = await navigator.wakeLock?.request("screen");
    return () => void lock?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
