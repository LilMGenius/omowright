# CAPTCHA input quality and completion

The CAPTCHA helper separates input, recognition, and application verification.
It is not a general solver and makes no provider bypass or success-rate claim.
See the [CAPTCHA skill](../presets/captcha/SKILL.md) for the complete API sequence.

## Input is not acceptance

- **Prevention:** browser identity and engine behavior affect observable session
  properties. They do not establish that a challenge was solved.
- **Detection:** a visible widget or application state can indicate a challenge.
  A snapshot that omits a cross-origin frame cannot prove no challenge exists.
  These helpers do not add a provider detector.
- **Solving:** clicks, drags, OCR, and caller-selected image targets support an
  interaction. They do not fetch a valid token or guarantee a correct answer.
- **Verification:** the caller supplies an application-specific acceptance
  predicate. A screenshot, input event, elapsed delay, token, or hidden widget
  alone is not evidence of server acceptance.

`click(bounds)` retains center targeting and a compact snapshot tree string
return. Optional `point` targets a specific location inside the bounds; optional
positive integer `approachSteps` moves there through intermediate pointer events
before clicking. That interpolation is not a human-likeness guarantee. All
coordinates are top-level viewport CSS pixels. Re-measure after scroll, resize,
or reflow, and account for frame geometry: the center of an iframe need not be
its checkbox. `drag` retains 20 default steps and release in `finally`.
`click` and `drag` retain `settleMs: 3000` by default; `settleMs: 0` removes the
settling delay but not the snapshot. Their returned tree is observation, not a
completion verdict. OCR retains its text-or-`null` contract.

Use `await captcha.click(bounds, { point, approachSteps: 12, settleMs: 0 })`
with freshly measured bounds and point, then wait for an explicit application
condition. For an application-owned status element that reflects acceptance:

```js
const result = await captcha.waitFor({
  until: page => page.evaluate(
    `document.querySelector("#application-status")?.dataset.accepted === "true"`
  ),
  timeoutMs: 10000,
  pollMs: 100,
});
if (result.outcome !== "matched") {
  throw new Error(`Acceptance not confirmed: ${result.outcome}`);
}
const image = await page.screenshot({ type: "png" });
```

This selector is an example, not a provider convention. Replace it with a signal
that actually means your application accepted the result.

`waitFor({until, timeoutMs = 10000, pollMs = 100, signal} = {})` returns exactly
`{ outcome: "matched" | "timed_out" | "cancelled", elapsedMs }`, with **no tree**.
It performs no input or screenshot. `until(page, {signal: operationSignal})` must
return literal `true` to match. Checks start immediately and remain serial,
under one monotonic deadline; only after a non-true result does polling wait.
Errors before termination propagate unchanged. Cancellation wins over an
expired deadline, which wins over a match. Pre-abort and a zero timeout invoke
no predicate. Timing arguments are finite milliseconds: timeout in
`[0, 2147483647]`, polling in `(0, 2147483647]`, without coercion.

Deadline and abort also bound pending async checks. Owned timers/listeners are
cleaned up and the operation signal is aborted on every terminal exit. A
non-cooperative predicate may remain pending, with late rejections handled;
blocking synchronous code cannot be interrupted. Already-dispatched browser
input or requests cannot be retracted. Take screenshots or snapshots separately
so they cannot hold up `waitFor` termination. The wait does not bound a preceding
click, drag, or its snapshot.

## Pinned source comparison

The comparison baseline is OmOWright
`293ca5002cbd4c8b0c104c5934683385ef7e0d3a` and invisible_playwright_mcp
`f70bfecf14efa60797aed499afc9390331875ebd`. These file links pin the observations;
the optional targeting and completion API above are additions to that baseline.

| Observation | Source and implication |
|---|---|
| The reference explicitly says it does not solve CAPTCHAs or promise non-detection. | [Reference disclaimer, lines 59-62](https://github.com/feder-cr/invisible_playwright_mcp/blob/f70bfecf14efa60797aed499afc9390331875ebd/docs/playwright-mcp-and-captchas.md#L59-L62). Its documented engine is Firefox patched at the C++ source; this is not a challenge-answering service. |
| Reference coordinate clicks use browser mouse input. | [Reference `click_at`, lines 552-571](https://github.com/feder-cr/invisible_playwright_mcp/blob/f70bfecf14efa60797aed499afc9390331875ebd/src/invisible_playwright_mcp/mcp/actions.py#L552-L571) moves with 12 steps, presses/releases, optionally holds, then waits 400ms and returns a screenshot. Neither movement nor that screenshot proves acceptance. |
| Target already delegates input to its browser mouse API. | [Baseline CAPTCHA helper](https://github.com/code-yeongyu/omowright/blob/293ca5002cbd4c8b0c104c5934683385ef7e0d3a/src/captcha.js#L58-L95) clicks the center, drags with 20 default steps, and returns a compact snapshot after 3000ms. The active-tab fixture verifies trusted events; this is not a guarantee about background-tab fallback behavior or proof of human origin. |
| Persistent identity is not missing from the target. | [Reference identity module](https://github.com/feder-cr/invisible_playwright_mcp/blob/f70bfecf14efa60797aed499afc9390331875ebd/src/invisible_playwright_mcp/mcp/identity.py) remembers a profile's seed. [Target Cloak profile](https://github.com/code-yeongyu/omowright/blob/293ca5002cbd4c8b0c104c5934683385ef7e0d3a/src/cloak-profile.js#L108-L147) already persists its seed, rejects an explicit mismatch, and supplies browser arguments. This is existing identity support, not a reason to duplicate fingerprint logic. |
| The reference wrapper delegates the browser engine to a dependency. | [Reference dependency declaration](https://github.com/feder-cr/invisible_playwright_mcp/blob/f70bfecf14efa60797aed499afc9390331875ebd/pyproject.toml#L50-L65) declares `invisible-playwright>=0.25.6`: a version floor, not an exact pin. The wrapper dependency declarations use floors; the comment about a transitive engine pin is not an exact wrapper dependency lock. Pinning this repository comparison does not pin the resolved engine. |

The useful change here is precise input plus bounded observation of a caller's
condition, not an engine port. No third-party implementation is copied. Cookie
seeding, proxy changes, duplicate fingerprint machinery, and engine replacement
are outside this change. Local fixture evidence can establish input coordinates,
trusted events, and wait semantics; it cannot establish a real-provider bypass
rate. No such rate has been measured or claimed here.
