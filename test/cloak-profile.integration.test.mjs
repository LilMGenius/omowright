import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  connectCloakProfile,
  findCloakBrowserPath,
} from "../src/index.js";

async function withSmokeServer(run) {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-e2e-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>profile smoke</title><main>ready</main>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ profileDir, url: `http://127.0.0.1:${server.address().port}/` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(profileDir, { recursive: true, force: true });
  }
}

let cloakBrowser;
try { cloakBrowser = findCloakBrowserPath(); } catch { cloakBrowser = undefined; }
const BROWSER = process.env.CLOAKBROWSER_BIN ?? cloakBrowser;

const probe = `(() => ({ webdriver: navigator.webdriver, value: localStorage.getItem("omowright-profile-smoke") }))()`;

// connectCloakProfile resolves CLOAKBROWSER_BIN first, so this contract runs on any Chromium (CI uses chrome-headless-shell).
test("a cloak profile reuses site state and its fingerprint seed across reloads", { skip: !BROWSER && "no Chromium binary found", timeout: 60000 }, async () => {
  await withSmokeServer(async ({ profileDir, url }) => {
    const first = await connectCloakProfile({ profileDir, fingerprintSeed: 31415 });
    const firstPage = await first.newTab(url);
    await firstPage.evaluate(`localStorage.setItem("omowright-profile-smoke", "persisted")`);
    await first.close();

    const second = await connectCloakProfile({ profileDir });
    const secondState = await (await second.newTab(url)).evaluate(probe);
    await second.close();

    const metadata = JSON.parse(readFileSync(path.join(profileDir, ".omowright-cloak.json"), "utf8"));
    assert.equal(secondState.value, "persisted");
    assert.equal(metadata.fingerprintSeed, 31415);
  });
});

// navigator.webdriver === false is CloakBrowser's own patch; a stock Chromium reports true, so this needs the real binary.
test("CloakBrowser hides navigator.webdriver on a reused profile", { skip: !cloakBrowser && "no CloakBrowser binary installed", timeout: 60000 }, async () => {
  await withSmokeServer(async ({ profileDir, url }) => {
    const first = await connectCloakProfile({ browserPath: cloakBrowser, profileDir, fingerprintSeed: 31415 });
    const firstState = await (await first.newTab(url)).evaluate(`(() => { localStorage.setItem("omowright-profile-smoke", "persisted"); return ${probe}; })()`);
    await first.close();

    const second = await connectCloakProfile({ browserPath: cloakBrowser, profileDir });
    const secondState = await (await second.newTab(url)).evaluate(probe);
    await second.close();

    assert.deepEqual(firstState, { webdriver: false, value: "persisted" });
    assert.deepEqual(secondState, { webdriver: false, value: "persisted" });
  });
});
