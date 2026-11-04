// What the page can tell of the device, and a worker cannot.

/** Shorter side of a phone's screen, in CSS pixels: the largest are around 480. */
const SMALL_SCREEN = 600;

/**
 * A touch screen that is small, or that says nothing of its memory: iOS and iPadOS have no
 * `navigator.deviceMemory`, and Safari there closes a tab that takes too much, without warning.
 */
export function isPhone(): boolean {
  if (typeof matchMedia === "undefined" || !matchMedia("(pointer: coarse)").matches) return false;
  return Math.min(screen.width, screen.height) < SMALL_SCREEN || !("deviceMemory" in navigator);
}
