# OmOWright tools — agent-facing reference

Drive a browser with Playwright-shaped JS. Two transports: `connectPipe`
(launch a browser, zero TCP port) and `connect(cdpHttpUrl)` (attach to a
running Chromium DevTools endpoint).

## Core loop

1. Open or attach a tab: `connection.newTab(url)` / `connection.attachPage(targetId)`.
2. Read the page with `page.snapshot()` — never `page.content()` for reading.
3. Act through `page.locator(refOrCss)` using `[ref=eN]` ids from the snapshot.

## Tools

- `newTab(url)` — open a tab, waits for interactivity, returns page.
- `listTargets()` — list open tabs (id, type, url, title).
- `attachPage(targetId)` — attach an existing tab.
- `page.goto(url)` — navigate; resolves when interactive.
- `page.snapshot(options?)` — PRIMARY read. Returns `{tree, refs}`; tree lines
  look like `- link "Learn more" [ref=e1]`. Options: `maxDepth` (50),
  `maxChars`, `interactive`, `showHidden`, `selector`, `ref`.
- `compactSnapshot(snapshot)` — returns the raw tree without the refs map
  (refs resolve in-page; the map is ~54% of bytes on real pages). Use before
  sending snapshots to a model.
- `page.locator(refOrCss)` — `click`, `fill`, `press`, `pressSequentially`,
  `hover`, `check`, `selectOption`, `dragTo`, `setInputFiles`, `textContent`,
  `innerText`, `isVisible`, `waitFor`, `first/nth/last`, `filter`.
- `page.evaluate(expression)` — run JS in the page.
- `page.screenshot(options?)` — image bytes (path, fullPage, clip, type, quality).
- `page.pdf(options?)` — PDF bytes (path, format, margin, printBackground).
- `page.keyboard` / `page.mouse` — press, type, insertText / move, click, wheel.
- `createCua(page)` — coordinate fallback (visual-browse equivalent): `click`,
  `doubleClick`, `drag({path})`, `move`, `scroll`, `type`, `keypress`,
  `getVisibleScreenshot()` (base64 PNG). Use only when refs/locators cannot
  target the UI (canvas, custom controls, stale refs).
- `createCaptcha(page, { ocr? })` — input, OCR, and explicit condition helpers,
  not a general CAPTCHA solver. `click(bounds, opts?)` defaults to the center;
  optional `opts.point` is an absolute top-level viewport CSS-pixel point inside
  the bounds. Positive integer `opts.approachSteps` adds intermediate movement,
  not a human-likeness guarantee. Re-measure after scrolling/resizing; iframe
  bounds alone do not locate a checkbox. `drag(from, to, {steps?, settleMs?})`
  defaults to 20 steps. Both return a compact snapshot tree string after
  settling (`settleMs` defaults to 3000ms, allows 0), not proof of acceptance.
  `waitFor({until, timeoutMs = 10000, pollMs = 100, signal?})` separately returns
  `{outcome: "matched" | "timed_out" | "cancelled", elapsedMs}`, with no tree.
  Use `click(bounds, {settleMs: 0})`, then an application-specific acceptance
  predicate: only literal `true` matches. Checks are serial under one deadline;
  abort takes priority over timeout, then match. Predicate errors propagate;
  cancellation cannot retract dispatched input/requests or interrupt blocking
  synchronous code. Take `page.screenshot()` separately for visual evidence.
  `readText(bounds?)` OCRs a screenshot region and returns text or `null`, never
  a tree. It defaults to macOS Vision (`macOSVisionOcr`); pass
  `ocr: async (pngBuffer) => string` on other platforms or to use a vision model.
  Full bounds, timing, cancellation, and acceptance examples:
  [CAPTCHA skill](presets/captcha/SKILL.md).
- `createChromeApi(connection, { profilePath?, downloadDir? })` — Chrome
  MV3-shaped APIs: `tabs.query/get`, `windows.get/getCurrent/getLastFocused/
  getAll`, `bookmarks.*` (read-only), `history.search/getVisits`,
  `downloads.search/download`, `topSites.get`. Profile-backed methods need
  `profilePath`. Write methods throw `UnsupportedOperationError` (extension
  bridge required). Full reference: presets/chrome/.
- `injectCookies(page, cookies)` — inject raw cookie exports (e.g. from a
  real browser profile) with CDP sanitization handled: negative `expires`
  dropped, `__Host-` cookies forced secure + root path + url-scoped,
  `SameSite=None` dropped when not secure, name+domain deduped.
  `sanitizeCookies(cookies)` is the pure transform if you need it.

Every tool below is exported from `src/index.js`, the same import as the core
loop; the module files next to it are implementation detail.

- `createNetworkSnoop(page, { match?, bodies=true, maxEntries=500, maxBodyBytes? })`:
  buffer finished network entries for one page. `match` is a predicate or
  `{ url: string|RegExp, method, mimeType, resourceType }`. Methods: `pop()`
  (drain), `peek()` (copy), `popJson()` (drain and parse JSON bodies),
  `waitFor(match, { timeoutMs })` (resolves with the next matching entry),
  `summary({ max })` (one line per entry: method status mime bytes url),
  `dispose()`. Entries carry `requestId, url, method, resourceType, status,
  statusText, mimeType, requestHeaders, responseHeaders, postData,
  encodedDataLength, body, base64Encoded, bodySkipped, failed, errorText,
  startedAt, finishedAt`.
- `collectWhileScrolling(page, snoop, { minItems, maxScrolls=10, extract, scroll:
  "wheel"|"end", settleMs=800 })`: async generator. Each round scrolls, settles, drains
  `snoop.popJson()` through `extract(json) => items[]`, yield each item. Returns
  `{ rounds, total, stoppedBecause: "minItems"|"maxScrolls"|"noGrowth" }`.
- `createTrace(page, { dir, screenshots=true, network=true, console=true,
  maxBodyBytes?, events? })`: flight recorder. `step(name, fn)` runs `fn` with
  before/after screenshots and timing, `mark(name, data)` drops a marker,
  `stop()` flushes and returns the summary. Writes `dir/trace.jsonl` (kinds:
  step, network, console, dialog, navigation, download, mark, warning),
  `dir/trace.har` (HAR 1.2), `dir/summary.json`, and
  `dir/screenshots/<seq>-<slug>-before|after.png`. `trace.dir` is the resolved
  directory. Never sends `Runtime.enable`.
- `toHar(entries, { creator?, pages? })`: pure HAR 1.2 builder over snoop entries.
- `reconcileFrames(page)`: re-links OOPIF child frames that lost their parent;
  returns the frames it added. `snapshotWithFrames(page, opts?)`: snapshot that
  runs the repair first and adds `missingFrames` only when a frame could not be
  entered at all. Details in "Frames (OOPIF) and shadow DOM" below.
- `requestHuman(page, { prompt, until?, timeoutMs=300000, pollMs=500, signal? })`:
  bring the window to front, show a shadow-DOM banner with a Done button, and
  wait. `until` is `{ url: string|RegExp }`, `{ selector }`, or
  `async (page) => boolean`. Resolves `{ outcome: "continued"|"timed_out"|
  "cancelled", elapsedMs, reason: "until"|"done-button"|"timed_out"|"signal" }`.
  The banner is removed on every path.
- `describeLayers(page, { grid=5 })`: hit-test a grid over the viewport and
  report `{ blocking: null | { tagName, role, name, coverage, position,
  selectorHint, ariaModal }, candidates, viewport }`. `layersHeader(result)`
  renders `@layers none` or `@layers blocking=<role|tag> "<name>" coverage=NN%
  hint=<sel>`. `snapshotWithLayers(page, opts?)` prepends that header to
  `tree` and adds a `layers` field.
- `DEVICE_PRESETS` (`"iphone-14"` 390x844 @3x touch, `"pixel-7"` 412x915,
  `"ipad-air"` 820x1180, `"desktop-1440"` 1440x900) and
  `emulate(page, nameOrPreset)`: set metrics, touch, and UA together;
  `emulate(page, null)` clears the override and restores the UA captured on the
  first call.
- `createRoutes(page)`: request interception. `route(match, handler)`,
  `unroute(match?)`, `dispose()`, `enabled`. `match` is a glob string (`*` and
  `?`; plain substring otherwise), a RegExp, or a predicate over
  `{ url, method, resourceType, headers }`. The handler receives `{ request,
  continue(overrides), fulfill({ status, headers, contentType, body }),
  abort(reason) }`. `Fetch.enable` is sent on the first `route()` only.
- Dialog policy: `connectPipe({ dialogPolicy })`, `new PipeCdpClient({
  dialogPolicy })`, `client.setDialogPolicy(policy)`, `client.dialogPolicy`,
  `BrowserConnection.setDialogPolicy(policy)`. Pure helpers in
  `src/dialog-policy.js`: `normalizeDialogPolicy(policy)`,
  `resolveDialogAction(policy, dialogParams)`. See "Dialogs" below.

## Attached engine (BrowserSkill)

- `connectBrowserSkill({ name, browser, width, height, focused, home, sockPath,
  autoStart, timeoutMs })`: starts a session in the user's own browser through
  the BrowserSkill daemon's IPC socket and returns a `BskSession`. Throws
  `BskRpcError` `no_browser_connected` when no extension is attached; never
  launches a browser of its own.
- `BskSession`: `navigate`, `back`, `forward`, `reload`, `observe`, `snapshot`,
  `getHtml`, `screenshot({ ref, fullPage })`, `click`, `hover`, `fill`,
  `press`, `select`, `focus`, `blur`, `scrollTo`, `wheel`, `evaluate`,
  `tabList`, `tabCreate`, `tabClose`, `tabSelect`, `tabBorrow`, `tabReturn`,
  `waitForNavigation`, `requestHelp`, `console`, `network`, `resize`,
  `emulate`, `stop()`. Targets: `"e3"` / `"@e3"` (daemon refs), a CSS
  selector, or `{ captureId, x, y }`.
- `bskSnapshot(session, options)`: OmOWright `{ tree, refs, css }` from an
  attached tab with no page global and no DOM mutation; `css[ref]` is `null`
  inside shadow roots.
- `bskDoctor({ browser })` / `bskOnboard({ browser, onHumanStep })`: CLI install
  (official installer, rc-file changes reverted), daemon start, then Web Store
  extension registration through Chrome's External Extensions
  (`registerExternalExtension` / `unregisterExternalExtension`) for the one
  browser the user actually uses, then a wait on
  `system.status{wait_for_browser_ms}`. The one human step is returned as
  `humanStep`; `needsChoice: true` means nothing was registered and the user
  has to name the browser.
- `identifyBrowser({ catalog, signals, explicit })` / `probeBrowserSignals()` /
  `catalogBrowsers()` / `detectBrowsers()`: the browser choice on its own —
  default browser, running process and recent-use signals, ranked; ambiguity
  returns `needsChoice` instead of a guess.
- `BskIpcClient` / `BskRpcError` / `readDaemonInfo` / `resolveBskHome`: the
  raw JSON Lines IPC client (`call`, `callWithHandle`, `cancel`) for daemon
  methods the session does not wrap.

## Rules

- Ref ids are virtual: pass them straight to `page.locator('e1')`, never into
  CSS selectors. Every new snapshot invalidates earlier ref ids. Attached-engine
  refs from `session.observe()` are `@eN` strings for `session.click("@e3")`;
  `bskSnapshot` refs are clicked through `css[ref]`.
- `page.context()` and raw CDP `_sendToTarget` exist but are escape hatches;
  prefer the tools above.

## Dialogs (alert / confirm / prompt / beforeunload)

Every JavaScript dialog is **answered at the transport layer** by a dialog
policy, so the page never hangs waiting for a human, including a click that
triggers `window.print()`. The default policy accepts everything, which keeps
the old behaviour: `alert()` returns immediately, `confirm()` returns `true`,
`prompt()` returns `""`, `beforeunload` never blocks navigation, and dialogs
during page load are handled the same way (`page.goto()` still completes because
readiness is content-probe based).

A policy is either an object or a function:

```js
const browser = await connectPipe({ browserPath, browserArgs, storageRoot,
  dialogPolicy: { accept: false } });              // confirm() -> false, prompt() -> null
browser.setDialogPolicy({ accept: true, promptText: "agent@example.com" }); // prompt() -> the text
browser.setDialogPolicy(dialog => {               // { type, message, defaultPrompt, url }
  if (dialog.type === "beforeunload") return true;
  return { accept: !/delete/i.test(dialog.message), promptText: dialog.defaultPrompt };
});
browser.cdp.dialogPolicy;                         // read the current policy (pipe client getter)
```

- `{ accept: false }` dismisses: `confirm()` returns `false`, `prompt()` returns
  `null`. `alert()` returns either way.
- `promptText` is the value `prompt()` resolves to when accepted.
- A function policy may return `boolean` or `{ accept, promptText }`, sync or
  async. A policy that throws falls back to accept, so a bug in the policy
  cannot hang the page.
- `connectPipe({ dialogPolicy })` sets it at launch; `browser.setDialogPolicy()`
  swaps it later (it forwards to the pipe client and throws for a transport
  without policy support). `connect()` over WebSocket keeps plain auto-accept.
- Subscribe to `page.on('dialog', d => ...)` for observability: the event
  carries `{type, message, defaultPrompt, url}` and fires after the policy runs.

## Frames (OOPIF) and shadow DOM

- Out-of-process iframes are stitched into the snapshot as child trees under
  the owning `- iframe [ref=eK]:` line. Child refs look like `f<N>e<M>` and go
  straight to `page.locator("f1e3")`; the page routes them to the right frame
  session. There is no separate frame object to hold.
- Plain `page.snapshot()` sees OOPIFs that existed before `attachPage()`; no
  extra call is needed for the common case.
- Closed shadow roots hide the host link, so a frame inside one lands in an
  orphan `- iframe:` block at the end of the tree. Its refs still work.
- `reconcileFrames(page)` re-links child frames whose parent link was lost (it
  returns the frames it added). `snapshotWithFrames(page)` runs that repair and
  reports `missingFrames` only when a frame could not be entered at all. Reach
  for these when a snapshot shows an `iframe` with no children you expected.
- Rough edge: the first click into a freshly adopted OOPIF can land on the
  embedder. Re-snapshot and click the ref again.

## Stealth notes

- The `Network` domain is already enabled for every page session, and pages
  cannot observe it. `createNetworkSnoop` and `createTrace` add no new signal.
- `Fetch` interception changes request timing and blocking patterns that bot
  defenses can fingerprint. It's off until the first `createRoutes().route()`
  call, and `dispose()` turns it off again. Keep routes out of stealth runs.
- None of these modules send `Runtime.enable`; `requestHuman` and
  `describeLayers` use `page.evaluate`, which shares the existing path.
- Device emulation swaps the UA and metrics; pair it with a matching
  fingerprint seed when the target scores consistency.

## Readiness probe

`page.goto()` waits for meaningful content, not just `document.readyState`:
the page is ready when `body` exists AND (interactive elements > 0 OR
landmarks > 0 OR visible text >= 20 chars). A near-empty page (e.g.
`<h1>ok</h1>`) never satisfies the probe and `goto` times out after 30s — use
`page.goto(url, { waitUntil: "commit" })` for content-free fixtures.
