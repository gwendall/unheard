// A file's sound, decoded in the page: Web Audio takes the audio of most video containers, and
// resamples it to the rate asked. Nothing of it is ever sent.

export type Decoded = { channels: Float32Array[]; sampleRate: number };

export async function decode(file: File, rate: number): Promise<Decoded> {
  const bytes = await file.arrayBuffer();
  const buffer = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes);
  // Two channels at most: the check puts its cleaned file back under a video, left and right.
  const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c).slice());
  return { channels, sampleRate: buffer.sampleRate };
}
