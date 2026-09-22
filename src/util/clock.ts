/** Injectable time source so scheduling / state logic is testable without real waiting. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
