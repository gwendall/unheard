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
