/** Requests at a time: what a browser holds open per host anyway; more only queues inside it. */
export const MAX_FETCHES = 6;

/** `f` over every item, at most `cap` at a time, the results in the items' order. */
export async function inParallel<A, B>(items: A[], cap: number, f: (item: A, index: number) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, lane));
  return out;
}

/**
 * `start` over items as they come, at most `cap` running (and one more just read), the results in
 * the items' order. An item is taken before the result of the one ahead of it is handed out, so what
 * it reads never holds what the ones ahead of it wrote: that is what makes the order of the work
 * not matter.
 */
export async function* inOrder<A, B>(items: Iterable<A> | AsyncIterable<A>, cap: number, start: (item: A) => Promise<B>): AsyncGenerator<B> {
  const running: Promise<B>[] = [];
  for await (const item of items) {
    const result = start(item);
    // It may fail before its turn: it says so then, not as a rejection nobody heard.
    result.catch(() => {});
    running.push(result);
    if (running.length > cap) yield await running.shift()!;
  }
  while (running.length) yield await running.shift()!;
}
