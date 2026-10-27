import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { requestHuman } from "../src/human-handoff.js";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(process.env.HOME, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();
const FIXTURE_HTML = readFileSync(fileURLToPath(new URL("./fixtures/human-ready.html", import.meta.url)), "utf8");

function createFakePage({ url = "https://example.test/waiting", bringToFrontError } = {}) {
  const page = {
    currentUrl: url,
    bringToFrontCalls: 0,
    evaluateCalls: [],
    bannerPresent: false,
    bannerInjected: 0,
    bannerRemoved: 0,
    doneFlag: false,
    selectors: new Set(),
    url() {
      return page.currentUrl;
    },
    async bringToFront() {
      page.bringToFrontCalls += 1;
      if (bringToFrontError) throw bringToFrontError;
    },
    async evaluate(fnOrExpr, arg) {
      const source = typeof fnOrExpr === "function" ? fnOrExpr.toString() : String(fnOrExpr);
      page.evaluateCalls.push({ source, arg });
      return dispatchFakeEvaluate(page, source, arg);
    },
  };
  return page;
}

function dispatchFakeEvaluate(page, source, arg) {
  const hasAttr = source.includes("data-omowright-human");
  const hasRemove = /\.remove\s*\(/.test(source) || source.includes("removeChild");
  const hasCreate = source.includes("createElement") || source.includes("attachShadow") || source.includes("2147483647");
  const hasDone = source.includes("__omowrightHumanDone");
  if (hasAttr && hasRemove && !hasCreate) {
    page.bannerRemoved += 1;
    page.bannerPresent = false;
    page.doneFlag = false;
    return;
  }
  if (hasCreate || (hasAttr && source.includes("Done"))) {
    page.bannerInjected += 1;
    page.bannerPresent = true;
    return true;
  }
  if (hasAttr && source.includes("querySelector")) return Boolean(page.bannerPresent);
  if (hasDone) return page.doneFlag === true;
  if (source.includes("querySelector") && typeof arg === "string") return page.selectors.has(arg);
  return undefined;
}

function assertBannerRemoved(page) {
  assert.ok(page.bannerRemoved > 0, "banner removal evaluate call happened");
  assert.ok(
    page.evaluateCalls.some(({ source }) => source.includes("data-omowright-human") && (/\.remove\s*\(/.test(source) || source.includes("removeChild"))),
    "banner removal evaluate source removes [data-omowright-human]",
  );
}

async function launch() {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-human-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
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

function startFixtureServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE_HTML);
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

test("requestHuman continues when until url matches and removes the banner", async () => {
  const page = createFakePage({ url: "https://example.test/done", bringToFrontError: new Error("focus denied") });
  const result = await requestHuman(page, { prompt: "Finish login", until: { url: "/done" }, pollMs: 5, timeoutMs: 30 });
  assert.equal(result.outcome, "continued");
  assert.equal(result.reason, "until");
  assert.equal(typeof result.elapsedMs, "number");
  assert.ok(result.elapsedMs >= 0);
  assert.equal(page.bringToFrontCalls, 1);
  assert.ok(page.bannerInjected > 0);
  assertBannerRemoved(page);
});

test("requestHuman continues when until url regex or selector or predicate holds", async () => {
  const regexPage = createFakePage({ url: "https://example.test/next" });
  const regexResult = await requestHuman(regexPage, { prompt: "go", until: { url: /example\.test\/next/ }, pollMs: 5, timeoutMs: 30 });
  assert.equal(regexResult.outcome, "continued");
  assert.equal(regexResult.reason, "until");
  assertBannerRemoved(regexPage);

  const selectorPage = createFakePage();
  selectorPage.selectors.add("#ready");
  const selectorResult = await requestHuman(selectorPage, { prompt: "go", until: { selector: "#ready" }, pollMs: 5, timeoutMs: 30 });
  assert.equal(selectorResult.outcome, "continued");
  assert.equal(selectorResult.reason, "until");
  assertBannerRemoved(selectorPage);

  const predPage = createFakePage();
  let seen = null;
  const predResult = await requestHuman(predPage, {
    prompt: "go",
    pollMs: 5,
    timeoutMs: 30,
    until: async pageArg => {
      seen = pageArg;
      return true;
    },
  });
  assert.equal(seen, predPage);
  assert.equal(predResult.outcome, "continued");
  assert.equal(predResult.reason, "until");
  assertBannerRemoved(predPage);
});

test("requestHuman continues when the Done flag is set", async () => {
  const page = createFakePage();
  page.doneFlag = true;
  const result = await requestHuman(page, { prompt: "Click Done", pollMs: 5, timeoutMs: 30 });
  assert.equal(result.outcome, "continued");
  assert.equal(result.reason, "done-button");
  assertBannerRemoved(page);
});

test("requestHuman times out when until never holds", async () => {
  const page = createFakePage();
  const result = await requestHuman(page, { prompt: "wait", until: { selector: "#never" }, pollMs: 5, timeoutMs: 30 });
  assert.equal(result.outcome, "timed_out");
  assert.ok(result.elapsedMs >= 30);
  assertBannerRemoved(page);
});

test("requestHuman cancels when the signal aborts", async () => {
  const page = createFakePage();
  const ac = new AbortController();
  ac.abort();
  const result = await requestHuman(page, { prompt: "wait", until: { selector: "#never" }, pollMs: 5, timeoutMs: 30, signal: ac.signal });
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.reason, "signal");
  assertBannerRemoved(page);
});

test("live: until selector #ready continues and removes the banner", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const { server, url } = await startFixtureServer();
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(url);
    const result = await requestHuman(page, { prompt: "Wait for ready", until: { selector: "#ready" }, pollMs: 50, timeoutMs: 5000 });
    assert.equal(result.outcome, "continued");
    assert.equal(result.reason, "until");
    assert.equal(await page.evaluate("document.querySelector('[data-omowright-human]')"), null);
  } finally {
    await cleanup();
    await new Promise(resolve => server.close(resolve));
  }
});

test("live: timeoutMs 200 with until that never holds", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const { server, url } = await startFixtureServer();
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(url);
    const result = await requestHuman(page, { prompt: "This will time out", until: { selector: "#never" }, pollMs: 50, timeoutMs: 200 });
    assert.equal(result.outcome, "timed_out");
  } finally {
    await cleanup();
    await new Promise(resolve => server.close(resolve));
  }
});

test("live: AbortController aborted after 100ms cancels", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const { server, url } = await startFixtureServer();
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(url);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const result = await requestHuman(page, {
      prompt: "This will cancel",
      until: { selector: "#never" },
      pollMs: 50,
      timeoutMs: 5000,
      signal: ac.signal,
    });
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.reason, "signal");
  } finally {
    await cleanup();
    await new Promise(resolve => server.close(resolve));
  }
});
