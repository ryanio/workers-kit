/**
 * Batches and bounded concurrency, for work that would otherwise open a
 * hundred subrequests at once or send a list too long for one API call.
 */

/** `items` in runs of at most `size`, in order: `chunks([1, 2, 3], 2)` is `[[1, 2], [3]]`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  if (!(Number.isInteger(size) && size >= 1)) {
    throw new RangeError(
      `chunk size must be a whole number from 1, not ${size}`,
    );
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * `fn` over `items` with at most `limit` running at once, the results in
 * input order. The first rejection rejects the whole call, and no item starts
 * after it; work already running finishes unobserved. A Worker caps how many
 * subrequests are open at once, so this is how a fan-out stays under it.
 */
export function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!(Number.isInteger(limit) && limit >= 1)) {
    throw new RangeError(`limit must be a whole number from 1, not ${limit}`);
  }
  return new Promise<R[]>((resolve, reject) => {
    const results = new Array<R>(items.length);
    let next = 0;
    let done = 0;
    let failed = false;
    if (items.length === 0) {
      resolve(results);
      return;
    }
    const start = (): void => {
      if (failed || next >= items.length) return;
      const index = next++;
      let run: Promise<R>;
      try {
        run = fn(items[index] as T, index);
      } catch (error) {
        run = Promise.reject(error);
      }
      run.then(
        (value) => {
          results[index] = value;
          done++;
          if (done === items.length) resolve(results);
          else start();
        },
        (error: unknown) => {
          failed = true;
          reject(error);
        },
      );
    };
    for (let i = 0; i < Math.min(limit, items.length); i++) start();
  });
}
