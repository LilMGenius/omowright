import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs, createEvents } from "../src/index.js";

function browserPath() {
  const pinned = path.join(process.env.HOME ?? "", ".cloakbrowser/chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium");
  if (existsSync(pinned)) return pinned;
  const candidates = globSync(path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"));
  return candidates.sort().at(-1) ?? null;
}
const BROWSER = process.env.CLOAKBROWSER_BIN ?? browserPath();

test("pipe event bridge creates and closes an owned background page", { skip: !BROWSER && "no Chromium binary found", timeout: 60000 }, async () => {
  const profile = mkdtempSync(path.join(tmpdir(), "omowright-events-live-"));
  const connection = await connectPipe({ browserPath: BROWSER, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`], storageRoot: profile, commandTimeoutMs: 60_000 });
  const events = createEvents(connection); const tabs = createAgentTabs(connection);
  try {
    await Promise.all([events.ready, tabs.ready]);
    const opened = events.waitForEvent("tabOpened", { timeout: 10000, predicate: value => value.type === "page" });
    const tab = await tabs.create();
    const openedPayload = await opened;
    assert.equal(openedPayload.targetId, tab.targetId);
    assert.ok(openedPayload.url === "about:blank" || openedPayload.url === "", `unexpected initial URL: ${openedPayload.url}`);
    const closed = events.waitForEvent("tabClosed", { timeout: 10000, predicate: value => value.targetId === tab.targetId });
    await tabs.close(tab); assert.equal((await closed).targetId, tab.targetId);
  } finally { await events.dispose(); await tabs.dispose({ closeOwned: false }); await connection.close(); rmSync(profile, { recursive: true, force: true, maxRetries: 10 }); }
});
