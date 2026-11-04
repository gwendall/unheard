import { whereExampleWav } from "./where-example";

// Making the sound takes seconds on a phone: away from the page, which goes on moving meanwhile.

self.onmessage = () => {
  const bytes = whereExampleWav();
  self.postMessage(bytes, { transfer: [bytes.buffer as ArrayBuffer] });
};
