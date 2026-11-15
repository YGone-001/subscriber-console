/** Runs a bounded number of tasks concurrently while preserving input order in
 *  the settled results. Existing single-entry endpoints are reused so batch
 *  operations do not add new API routes. */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  const size = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: size }, worker));
  return results;
}