---
name: omowright
description: "The default code-driven browser path for interactive browsing work: drives any browser from code with token-efficient a11y snapshots (57% smaller via compactSnapshot), ref-based clicks, coordinate control (CUA), viewport pinning, CAPTCHA solving (reCAPTCHA, Turnstile, hCaptcha, slider, OCR), Chrome MV3 APIs (tabs/bookmarks/history/downloads/topSites), network snoop (read API JSON instead of DOM), flight-recorder trace (jsonl + HAR + screenshots), OOPIF-aware snapshots, dialog policy, human handoff for login/OTP, device emulation, request routes, stealth via CloakBrowser as the default owned engine with zero exposed CDP ports, and an attached engine that drives the user's own signed-in browser through BrowserSkill (connectBrowserSkill, bskSnapshot, one-click onboarding via bskOnboard). MUST USE for interactive browser work: scraping, blocked/WAF/JS-rendered pages, logins, the user's logged-in sites and open tabs, extension popups, form filling, screenshots, web QA, CAPTCHAs. The ulw-research browsing lane runs on ultimate-browsing, not this skill."
---

# OmOWright

Browser automation as a code library. Install it with
`bun add github:code-yeongyu/omowright` (or import it by the path of a local
checkout). Bun >= 1.4 recommended, Node >= 22 supported.

Two engines, one library:

| Engine | Use when | Entry point |
|---|---|---|
| **Owned** (default) | scraping, WAF/bot-scored targets, headless, anything that must not touch the user's profile | `connectPipe` / `connectCloakProfile` — no CLI, no daemon, no open CDP port |
| **Attached** | the task needs the user's logged-in sessions, cookies, or open tabs | `connectBrowserSkill` — stock BrowserSkill daemon + extension; `references/browserskill.md` |

Never substitute one for the other silently: if the attached engine is not set
up, run `bskOnboard()` and tell the user its single remaining step. It installs
the extension only into the browser the user actually uses; when it returns
`needsChoice`, ask which browser that is and pass `{ browser: "<id>" }`.

## Core loop (owned engine)

```js
const { connectPipe, compactSnapshot } = await import("omowright");
const browser = await connectPipe({
  browserPath: "<CloakBrowser binary>",           // DEFAULT engine
  browserArgs: ["--no-first-run", `--user-data-dir=${profileDir}`],
  storageRoot: profileDir,
});
const page = await browser.newTab("https://example.com");
const tree = compactSnapshot(await page.snapshot());  // ALWAYS compact before reading
await page.locator("e1").click();                     // refs come from the snapshot
await browser.close();                                // then rm -rf the profile dir
```

## Default engine: CloakBrowser

Use the CloakBrowser binary by default, not a plain headless shell — most real
targets sit behind WAFs or bot scoring, and CloakBrowser's source-level
fingerprint patches (Cloudflare Turnstile, FingerprintJS, BrowserScan) make it
the safe default. Plain headless shell is the speed fallback for trivially open
pages: any Chrome/Chromium or
`~/Library/Caches/ms-playwright/chromium_headless_shell-*/.../chrome-headless-shell`.

```bash
python3 -c "import cloakbrowser; print(cloakbrowser.binary_info()['binary_path'])"
# -> ~/.cloakbrowser/chromium-<ver>/Chromium.app/Contents/MacOS/Chromium
```

For a reused authenticated profile, use `connectCloakProfile({ profileDir, fingerprintSeed })` from the package (or the `omowright-cloak --profile "$HOME/.local/share/omowright-cloak" --url <url> --once --snapshot` launcher). First use pins a fingerprint seed in a mode-`0600` metadata file inside the mode-`0700` profile; later runs reuse it and **REJECT a conflicting seed** instead of silently changing identity. It passes the fixed `--fingerprint=<seed>` plus the platform flag on every `connectPipe()` launch. The seed is an identity pin, not a credential store.

**CLOAKBROWSER ALLOWS ONE INSTANCE.** Probe before launching
(`curl -s -m 2 http://127.0.0.1:9242/json/version`). If one answers, `connectPipe`
HANGS during early init — attach with `connect()` instead. Full pattern:
`references/stealth.md`.

## Getting past obstacles

A blocked page is a rung to climb, not a reason to stop and report.

| Rung | Use | Advance when |
|---|---|---|
| 1. `snapshot()` + `locator(ref)` | Anything with a usable ref | Ref absent, stale, obscured, or the click hits the wrong node twice |
| 1b. `snapshotWithLayers` / `describeLayers` | A blocking overlay explains two identical misses; dismiss it first | `@layers none`, or the overlay is gone and the click still misses |
| 2. `createCua(page)` coordinates | Canvas, extension popups, custom controls | Click misses, or screenshot and coordinates disagree |
| 3. Pin the viewport, retry rung 2 | Coordinate drift after a resize, DPI scale, or foreign tab | Coordinates land right but the widget still refuses input |
| 4. `createCaptcha(page)` | A challenge widget is the blocker | Widget solved, flow still stalls |
| 5. Read the browser log | Browser-level failure | The log names a cause outside the page |

**TWO IDENTICAL FAILURES SELECT THE NEXT RUNG — A THIRD IDENTICAL ATTEMPT IS A
DEFECT.** Verify after every page-changing action: fresh snapshot for DOM state,
fresh screenshot for visual state. Report a stop only when all rungs are
exhausted, naming which rung failed with what evidence.

**RUNG 5 ENDS IN A WRITTEN DIAGNOSIS, NEVER A SPECULATIVE CODE CHANGE.** A browser
process problem (missing entitlement, extension service-worker failure, FIDO
unavailable) is not fixed by editing automation code; editing it only burns a
debugging cycle.

### Pin the viewport before trusting coordinates

CUA acts in viewport pixels. When the render surface and coordinate space
disagree, every coordinate is off by a constant and retrying repeats the miss:

```js
await page._sendToTarget("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  screenWidth: 1440, screenHeight: 900,
  viewport: { x: 0, y: 0, width: 1440, height: 900, scale: 1 },
});
await page.refreshViewportSize();   // -> { width: 1440, height: 900 }
```

Pin every page you act on, including tabs you did not open, then take a fresh
screenshot — coordinates read off an unpinned screenshot are stale.

## Route by task

| Task | Read |
|---|---|
| The user's own signed-in browser and tabs, BrowserSkill sessions, trace-free `bskSnapshot`, one-click extension onboarding | `references/browserskill.md` |
| Visual browsing, coordinate UI, viewport pinning, extension popups | `presets/visual-browse/SKILL.md` — consider delegating, below |
| CAPTCHA (checkbox, slider, text OCR, image grid) | `presets/captcha/SKILL.md` — consider delegating, below |
| WAF/Cloudflare/bot-detection pages, CloakBrowser, cookie rules | `references/stealth.md` |
| First use, page API, snapshot options, locator rules | `references/quickstart.md`; dialogs and readiness in `TOOLS.md` |
| Driving a browser inside `eval` cells, kernel persistence, parallel lanes | `references/eval-kernel.md` |
| Tabs/windows/bookmarks/history/downloads/topSites (Chrome MV3) | `presets/chrome/SKILL.md` |
| API JSON instead of DOM scraping, wait for a request, infinite scroll, QA flight trace (jsonl/HAR), request routes | `presets/network/SKILL.md` |
| Cross-origin iframes and shadow DOM, overlays that swallow clicks, login/OTP handoff to a human, device emulation | `references/frames-layers-human.md` |
| Reading an item from the 1Password web vault (tab-scoped session, sign-in check, secret handling) | `references/1password.md` |

Preset and `TOOLS.md` paths are relative to the package root.

## Hard rules

- **NEVER extract and inject cookies for Google (any property) or 1Password.**
  Google's risk engine kills the session server-side and logs the user out of
  their own browser; 1Password sessions are device-bound and never work from
  cookies. Detail in `references/stealth.md`. Cookie reuse is fine for ordinary
  sessions (Grafana, internal tools).
- **Always `compactSnapshot()`** before sending a snapshot to a model — the refs
  map is ~54% of bytes and resolves in-page, so dropping it is free.
- **Refs die on every new snapshot.** Pass `page.locator("e1")` straight from the
  latest snapshot; never reuse a ref across snapshots, never put one in CSS.
- **Refs stay page-level.** Child-frame refs look like `f1e3` and still go to
  `page.locator("f1e3")`; never fetch a frame handle to click inside an iframe.
- Dialogs never block: `alert/confirm/prompt/beforeunload` are answered by the
  dialog policy (default accept: `confirm() -> true`, `prompt() -> ""`). Change
  it with `connectPipe({ dialogPolicy })` or `browser.setDialogPolicy()`;
  observe with `page.on('dialog')`. Details in `TOOLS.md`.
- `goto` waits for meaningful content, not `readyState`: body plus (interactive
  elements OR landmarks OR >= 20 text chars). Near-empty pages time out — use
  `page.goto(url, { waitUntil: "commit" })` for those.
- Cleanup is paired: `await browser.close()` then `rm -rf` the profile dir in the
  same `finally`.

## Delegating the pixel loop

CAPTCHA solving and pixel-level visual browsing are iterative (screenshot, reason,
act, verify). When that loop would consume your own context, delegate the blocked
page to a `deep` subagent that loads these references. Drive it yourself when the
flow is short or the state is already in your hands.

When every rung fails on a login, a one-time code, or a challenge the captcha
preset can't clear, the human is the fallback: `requestHuman(page, { prompt,
until })` brings the tab to front, shows a Done banner, and resumes when the
condition holds. Recipe in `references/frames-layers-human.md`.

```
task(category: "deep", run_in_background: true, prompt: `
TASK: Get past the CAPTCHA blocking <url> and return the post-solve state.
1. Read `presets/captcha/SKILL.md`, `presets/visual-browse/SKILL.md` (package
   root), and `references/stealth.md` (this skill).
2. connectPipe with the CloakBrowser binary (default engine).
3. Pin the viewport (setDeviceMetricsOverride 1440x900 + refreshViewportSize)
   before computing any coordinate.
4. createCaptcha(page) - click(bounds) for checkbox widgets, drag(from, to,
   {steps}) for sliders, readText(bounds) for text (macOS Vision OCR default).
   Image grids: page.annotatedScreenshot() + cua.click per cell.
5. VERIFY with captcha.waitFor({ until }) on an application acceptance condition;
   only outcome "matched" counts, a snapshot is not proof. Two failures of one
   strategy select the next strategy; do not repeat a third time.
STOP WHEN the page is past the challenge, or all strategies are exhausted -
then report which failed and the browser-log evidence.
DELIVERABLE: post-solve snapshot tree + screenshot path.`)
```

## Choosing this over everything else

Plain `webfetch`/`curl` is fine for one static page. The moment a page needs JS,
interaction, login, screenshots, CAPTCHAs, or WAF bypass, use this skill rather
than ultimate-browsing: one library covers tiers 1-2 with a persistent browser,
smaller snapshots, and no agent-browser/CloakBrowser CLI plumbing. For
ulw-research browsing lanes, spawn `deep` lanes that `import()` this package in
eval cells — the browser persists across cells via `globalThis`, and
`compactSnapshot` keeps dozens of pages inside the context budget.
