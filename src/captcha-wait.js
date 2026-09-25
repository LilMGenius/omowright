const MAX_TIMER_MS = 2147483647;
const STOP = Symbol("wait stopped");

export async function waitForCaptcha(page, {
  until, timeoutMs = 10000, pollMs = 100, signal,
} = {}) {
  if (typeof until !== "function") throw new TypeError("until must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError("timeoutMs must be between 0 and 2147483647");
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0 || pollMs > MAX_TIMER_MS) {
    throw new RangeError("pollMs must be greater than 0 and at most 2147483647");
  }
  if (signal !== undefined && (typeof signal?.aborted !== "boolean"
    || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw new TypeError("signal must be AbortSignal-compatible");
  }

  const started = performance.now();
  const deadline = started + timeoutMs;
  const operation = new AbortController();
  let deadlineTimer;
  let pollTimer;
  let stop;
  const stopped = new Promise(resolve => { stop = () => resolve(STOP); });
  const terminal = () => signal?.aborted ? "cancelled"
    : performance.now() >= deadline ? "timed_out" : null;
  const result = outcome => ({ outcome, elapsedMs: performance.now() - started });
  const scheduleDeadline = () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) stop();
    else deadlineTimer = setTimeout(scheduleDeadline, Math.ceil(remaining));
  };

  try {
    const initial = terminal();
    if (initial) return result(initial);
    signal?.addEventListener("abort", stop, { once: true });
    scheduleDeadline();
    for (;;) {
      let accepted;
      try {
        // Promise.race keeps a rejection handler on a non-cooperative predicate
        // even after this wait has timed out or been cancelled.
        accepted = await Promise.race([
          Promise.resolve().then(() => terminal() ? STOP : until(page, { signal: operation.signal })),
          stopped,
        ]);
      } catch (error) {
        const outcome = terminal();
        if (outcome) return result(outcome);
        throw error;
      }
      const outcome = terminal();
      if (outcome) return result(outcome);
      if (accepted === true) return result("matched");
      await Promise.race([
        new Promise(resolve => {
          pollTimer = setTimeout(resolve, Math.ceil(Math.min(pollMs, deadline - performance.now())));
        }),
        stopped,
      ]);
      clearTimeout(pollTimer);
      const afterDelay = terminal();
      if (afterDelay) return result(afterDelay);
    }
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
    signal?.removeEventListener("abort", stop);
    operation.abort();
    stop();
  }
}
