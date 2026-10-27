// Shared launcher/fixture plumbing for the OOPIF snapshot tests.
// Parent documents are served from http://localhost:<portA>, the child document from
// http://127.0.0.1:<portB>: same host, different *site*, which is what makes the iframe
// an out-of-process frame under --site-per-process.
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, globSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPipe } from "../../src/index.js";
import { targetCreationCapability } from "../../src/internal-capability.js";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(process.env.HOME, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

export const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();
const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())),
    }));
    server.on("error", reject);
  });
}

function sendFixture(res, name, childUrl) {
  try {
    const body = readFileSync(path.join(FIXTURE_DIR, name), "utf8").replaceAll("__CHILD_URL__", childUrl);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

export async function startFixtureServers() {
  const child = await listen((req, res) => sendFixture(res, "oopif-child.html", ""));
  const childUrl = `http://127.0.0.1:${child.port}/child`;
  const parent = await listen((req, res) => {
    const name = path.basename((req.url ?? "/").split("?")[0]);
    if (!/^oopif-[a-z-]+\.html$/.test(name)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    sendFixture(res, name, childUrl);
  });
  return {
    childUrl,
    urlFor: name => `http://localhost:${parent.port}/${name}`,
    close: async () => { await parent.close(); await child.close(); },
  };
}

export async function launch() {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-oopif-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", "--site-per-process", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  return {
    connection,
    cleanup: async () => {
      await connection.close();
      rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
    },
  };
}

// State-driven wait: every attempt re-reads live state (most predicates make a CDP round
// trip, which paces the loop); it resolves the moment the state holds, never on a timer.
export async function waitUntil(predicate, { timeoutMs = 20_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    const value = await predicate().catch(error => { lastError = error; return null; });
    if (value) return value;
    if (Date.now() >= deadline) throw Error(`timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ""}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

export async function createRawTab(connection, url) {
  const { targetId } = await connection.cdp.send("Target.createTarget", { url }, undefined, { capability: targetCreationCapability });
  await connection.cdp.send("Target.activateTarget", { targetId }).catch(() => {});
  return targetId;
}

export async function listIframeTargets(connection) {
  const { targetInfos } = await connection.cdp.send("Target.getTargets");
  return targetInfos.filter(info => info.type === "iframe");
}

export function waitForChildTarget(connection, { label = "child iframe target" } = {}) {
  return waitUntil(async () => (await listIframeTargets(connection)).find(info => info.url.endsWith("/child")) ?? null, { label });
}

export function childFrameOf(page) {
  return page.frames().find(frame => frame.url().endsWith("/child")) ?? null;
}

// The frame is usable once its isolated world answers a DOM query from inside the child
// document; that is exactly the precondition core's per-frame snapshot needs.
export function waitForChildContent(page, selector = "#inside") {
  return waitUntil(async () => {
    const frame = childFrameOf(page);
    if (!frame) return null;
    const found = await page.evaluateInFrame(frame.frameId, `document.querySelector(${JSON.stringify(selector)}) ? 1 : 0`);
    return found === 1 ? frame : null;
  }, { label: `child frame content ${selector}` });
}

// Reproduces the state a missed Target.attachedToTarget leaves behind: the frame is gone
// from FrameManager and the page holds no session for it. Auto-attach is switched off on
// the page session first, otherwise the browser re-attaches the target and core onboards
// it again on its own, which would hide whether reconcileFrames did the recovery.
export async function forgetFrame(page, frameId) {
  const sessionId = page.frameManager.getFrame(frameId)?.sessionId;
  await page.cdp.send(
    "Target.setAutoAttach",
    { autoAttach: false, waitForDebuggerOnStart: false, flatten: true },
    await page.resolveSessionId(),
  );
  page.frameManager.frames.delete(frameId);
  if (sessionId) await page.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  return waitUntil(async () => {
    page.frameManager.frames.delete(frameId);
    await page.cdp.send("Target.getTargetInfo", { targetId: page.targetId });
    return page.frameManager.frames.has(frameId) ? null : true;
  }, { label: `frame ${frameId} forgotten`, timeoutMs: 10_000 });
}

export function readChildAttribute(page, frameId, attribute) {
  return page.evaluateInFrame(frameId, `document.body.getAttribute(${JSON.stringify(attribute)})`);
}

// Clicks a snapshot ref and returns once the child document itself recorded the click.
// Until Chromium's hit-test data includes the surface of a freshly adopted out-of-process
// frame, the browser hands the event to the embedder instead - the parent fixture records
// that - so the click is re-dispatched, bounded, until the child observes it.
export async function clickUntilChildObserves(page, ref, frameId, attribute, { attempts = 5 } = {}) {
  let parentClick = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.locator(ref).click();
    const value = await waitUntil(
      () => readChildAttribute(page, frameId, attribute),
      { label: `child body[${attribute}]`, timeoutMs: 2_000 },
    ).catch(() => null);
    if (value) return value;
    parentClick = await page.evaluate(() => document.body.getAttribute("data-parent-click")).catch(() => null);
  }
  throw Error(`child never observed the click on ${ref}; last click seen by the parent frame: ${parentClick}`);
}
