---
name: captcha
description: Interact with challenge widgets in an authorized automation flow using checkbox clicks, slider drags, text OCR, and image-grid input. Verify completion with an application-specific condition.
---

# Captcha

`createCaptcha(page, { ocr? })` provides input and OCR helpers, not a general
CAPTCHA solver. `click` and `drag` return a compact snapshot tree string after
settling. `readText` returns text or `null`. A snapshot, token, or disappearing
widget alone does not prove that the application accepted the challenge.

This is rung 4 of the ladder in `presets/visual-browse/SKILL.md`. Pin the viewport
before measuring coordinates (`Emulation.setDeviceMetricsOverride` and
`refreshViewportSize`), and measure again after scrolling, resizing, or reflow.

```js
import { createCaptcha } from "omowright";
const captcha = createCaptcha(page);
```

## Checkbox widgets

`click(bounds)` clicks the **center**, not the left-center. Measure the actual
checkbox bounds, or provide an explicit point within a measured widget rectangle.
All bounds and points use absolute top-level viewport CSS pixels. Coordinates
can target a visible control inside a frame without switching frames, but a
cross-origin iframe's outer bounds do not locate its checkbox. Account for frame
geometry; an opaque or missing frame in a snapshot is not evidence of no challenge.

For an application-owned widget with a DOM-accessible checkbox:

```js
const bounds = await page.evaluate(`(() => {
  const el = document.querySelector("#captcha-checkbox");
  if (!el) throw new Error("Checkbox not found");
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);

await captcha.click(bounds, {
  point: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
  approachSteps: 12,
  settleMs: 0,
});
const result = await captcha.waitFor({
  // Replace with your application's authoritative acceptance condition.
  until: page => page.evaluate(
    `document.querySelector("#application-status")?.dataset.accepted === "true"`
  ),
  timeoutMs: 10000,
  pollMs: 100,
});
if (result.outcome !== "matched") {
  throw new Error(`Acceptance not confirmed: ${result.outcome}`);
}
// Capture visual evidence separately; waitFor never returns a tree or image.
const image = await page.screenshot({ type: "png" });
```

`point` is optional; omit it to retain center targeting. `approachSteps` is an
optional positive integer for intermediate pointer movement before clicking.
Omitting it retains the direct click. Interpolation is not a human-likeness or
acceptance guarantee. Bounds must have finite coordinates and positive finite
dimensions; the point must be inside `[x, x + width)` and `[y, y + height)`.
Invalid geometry is rejected before input, not clamped or coerced.

## Completion is separate from input

`captcha.waitFor({ until, timeoutMs = 10000, pollMs = 100, signal } = {})`
returns exactly `{ outcome: "matched" | "timed_out" | "cancelled", elapsedMs }`.
It never clicks, takes a snapshot, or infers server acceptance. You can check an
already-accepted application without sending input.

`until` is required and called as `until(page, { signal: operationSignal })`;
one-argument predicates also work. Only literal `true` matches, not a truthy
string or object. The first check runs immediately; subsequent checks are serial,
after `pollMs`, bounded by one monotonic deadline. Predicate errors before
termination propagate unchanged. `timeoutMs` must be finite in `[0, 2147483647]`;
`pollMs` must be finite in `(0, 2147483647]`. A supplied `signal` must be
AbortSignal-compatible. Invalid arguments throw TypeError or RangeError without
running the predicate; values are not coerced.

At completion boundaries, cancellation takes priority over the deadline, and
the deadline over a match. A pre-aborted signal runs no predicate and returns
`cancelled`; a zero timeout runs no predicate and returns `timed_out` unless
already aborted. Async predicates and delays are bounded by abort/deadline,
without overlapping checks. The owned operation signal is aborted on every
terminal exit; owned timers and external abort listeners are cleaned up.
A non-cooperative predicate can remain pending after return; late rejection does
not change the result or become an unhandled rejection. Cancellation cannot
retract dispatched input or requests, or interrupt blocking synchronous code.

## Slider and puzzle drags

```js
const tree = await captcha.drag({ x: 150, y: 300 }, { x: 450, y: 300 }, { steps: 40 });
```

Endpoints must be finite viewport points. `steps` is a positive integer (default
20); it controls intermediate movement, not whether the application accepts the
result. Mouse release is attempted even if movement fails.

## Text and number captchas

```js
const text = await captcha.readText({ x: 100, y: 200, width: 200, height: 60 });
if (text !== null) await page.locator("input[name=captcha]").fill(text);
```

The built-in `macOSVisionOcr` uses macOS Vision via Swift. Elsewhere, inject an
OCR function: `createCaptcha(page, { ocr: async (pngBuffer) => "recognized text" })`.
`readText(bounds?)` screenshots a cropped region, or the whole viewport when
bounds are absent, and returns OCR text or `null`, never a snapshot tree.
Recognizing text is not proof of submission or acceptance.

## Image-grid challenges and diagnosis

`page.annotatedScreenshot()` overlays numbered boxes on interactive elements.
Use the image to identify targets and `createCua(page)` for coordinate input;
verify the application's result separately after submission.

`click` and `drag` accept finite supported timer milliseconds as `settleMs`
(default 3000, including 0 to disable the settling delay). They still take a
snapshot with `settleMs: 0`; that delay is not a completion check or an overall
timeout. If targeting fails, re-measure geometry. If input lands but acceptance
does not follow, inspect the application state rather than assuming extra steps,
a longer delay, or a different engine will solve it. See
[CAPTCHA quality and comparison](../../docs/captcha-quality.md) for the limits.
