// A file dropped on the home, handed to the flow across the move to /where. In memory only, and
// taken once.

let held: File | null = null;

export function holdFile(file: File) {
  held = file;
}

export const hasHeld = () => held !== null;

export function takeFile(): File | null {
  const file = held;
  held = null;
  return file;
}
