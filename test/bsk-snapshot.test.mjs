import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectPipe } from "../src/index.js";
import { buildSnapshotExpression, bskSnapshot } from "../src/bsk/snapshot.js";

function findHeadlessShell() {
  const home = process.env.HOME;
  const candidates = globSync(
    path.join(home, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();
const FIXTURE = pathToFileURL(fileURLToPath(new URL("./fixtures/bsk-snapshot-page.html", import.meta.url))).href;

test("buildSnapshotExpression embeds the page bundle under a shadowed globalThis and returns a plain object", () => {
  const expression = buildSnapshotExpression({ interactive: true, maxDepth: 3 });
  assert.match(expression, /^\(function \(\) \{\s*const globalThis = \{\};/);
  assert.ok(expression.includes("globalThis.__omowright = {"), "bundle text is embedded verbatim");
  assert.ok(expression.includes('"interactive":true'));
  assert.ok(expression.includes('"maxDepth":3'));
  assert.match(expression, /\}\)\(\)\s*$/);
});

async function withPage(fn) {
  assert.ok(SHELL, "no chrome-headless-shell found; set SHELL_BIN");
  const profile = mkdtempSync(path.join(tmpdir(), "omowright-bsk-snapshot-"));
  const browser = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
    storageRoot: profile,
  });
  try {
    const page = await browser.newTab(FIXTURE);
    const sessionId = await page.resolveSessionId();
    const mainWorldEvaluate = async (expression) => {
      const reply = await page.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (reply.exceptionDetails) return { ok: false, error: { text: reply.exceptionDetails.text } };
      return { ok: true, value: reply.result.value };
    };
    await fn({ page, mainWorldEvaluate });
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

test("bskSnapshot through a main-world Runtime.evaluate leaves no global and no DOM mutation, and its css paths resolve", { skip: !SHELL && "no chromium binary found", timeout: 60_000 }, async () => {
  await withPage(async ({ mainWorldEvaluate }) => {
    const settled = await mainWorldEvaluate("({ count: window.__fixtureMutations, log: window.__fixtureMutationLog })");
    assert.ok(Array.isArray(settled.value.log), "fixture observer is armed");
    await mainWorldEvaluate("window.__fixtureMutations = 0; window.__fixtureMutationLog.length = 0; true");

    const fakeSession = { evaluate: (expression, opts) => mainWorldEvaluate(expression, opts) };
    const snap = await bskSnapshot(fakeSession, { interactive: true });

    assert.equal(typeof snap.tree, "string");
    assert.match(snap.tree, /link "Home" \[ref=e\d+\]/);
    assert.match(snap.tree, /textbox "Search" \[ref=e\d+\]/);
    assert.ok(Object.keys(snap.refs).length >= 6, `expected refs, got ${Object.keys(snap.refs)}`);
    assert.deepEqual(Object.keys(snap.css).sort(), Object.keys(snap.refs).sort(), "one css entry per ref");

    const leak = await mainWorldEvaluate('({ global: "__omowright" in window, mutations: window.__fixtureMutations, log: window.__fixtureMutationLog })');
    assert.deepEqual(leak.value, { global: false, mutations: 0, log: [] });

    const checks = Object.entries(snap.css).map(([ref, css]) => ({ ref, css, meta: snap.refs[ref] }));
    const shadowRefs = checks.filter((c) => c.meta.name === "Inside shadow");
    assert.equal(shadowRefs.length, 1, "the shadow button is in the tree");
    assert.equal(shadowRefs[0].css, null, "shadow DOM elements have no light-DOM css path");

    const lightRefs = checks.filter((c) => c.css !== null);
    assert.ok(lightRefs.length >= 5);
    for (const { ref, css, meta } of lightRefs) {
      const probe = await mainWorldEvaluate(`(() => {
        const list = document.querySelectorAll(${JSON.stringify(css)});
        if (list.length !== 1) return { count: list.length };
        const el = list[0];
        return { count: 1, tag: el.tagName, text: (el.getAttribute("aria-label") || el.placeholder || el.textContent || "").trim() };
      })()`);
      assert.equal(probe.value.count, 1, `${ref} ${css} must match exactly one element`);
      assert.equal(probe.value.tag, meta.tagName, `${ref} ${css} resolves to the same tag`);
    }
    const duplicateGo = checks.filter((c) => c.meta.name === "Go").map((c) => c.css);
    assert.equal(duplicateGo.length, 2);
    assert.notEqual(duplicateGo[0], duplicateGo[1], "identical siblings get distinct paths");

    const goCss = duplicateGo[1];
    const clicked = await mainWorldEvaluate(`(() => { document.querySelector(${JSON.stringify(goCss)}).click(); return window.__fixtureClicks; })()`);
    assert.deepEqual(clicked.value, ["Go"]);
  });
});

test("bskSnapshot surfaces an in-page failure as an error instead of a partial result", async () => {
  const failing = { evaluate: async () => ({ ok: false, error: { text: "ReferenceError: document is not defined", line: 1, column: 1 } }) };
  await assert.rejects(bskSnapshot(failing), /document is not defined/);
});
