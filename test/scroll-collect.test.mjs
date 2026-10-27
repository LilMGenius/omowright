import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { createNetworkSnoop } from "../src/network-snoop.js";
import { collectWhileScrolling } from "../src/scroll-collect.js";
import { startSnoopServer } from "./fixtures/snoop-server.mjs";

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

test(
  "snoop captures live traffic and collectWhileScrolling harvests paged items",
  { skip: !SHELL && "no chromium binary found", timeout: 120_000 },
  async () => {
    const server = await startSnoopServer();
    const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-snoop-test-"));
    let connection = null;
    let snoop = null;
    try {
      connection = await connectPipe({
        browserPath: SHELL,
        browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${userDataDir}`],
        storageRoot: userDataDir,
      });
      const page = (await createAgentTabs(connection).create("about:blank")).page;
      snoop = createNetworkSnoop(page);
      await page.goto(server.url);

      const clicked = snoop.waitFor({ url: "/api/click" }, { timeoutMs: 20_000 });
      await page.locator("#ping").click();
      const entry = await clicked;
      assert.equal(entry.status, 200);
      assert.equal(entry.method, "GET");
      assert.equal(entry.mimeType, "application/json");
      assert.deepEqual(JSON.parse(entry.body), { ok: true });

      const items = [];
      const generator = collectWhileScrolling(page, snoop, { minItems: 15, maxScrolls: 10, settleMs: 500 });
      let result;
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        items.push(next.value);
      }
      assert.ok(items.length >= 15, `collected ${items.length} items while scrolling`);
      assert.equal(result.stoppedBecause, "minItems");
      assert.equal(result.total, items.length);
      assert.ok(result.rounds >= 1);
      assert.ok(items.every(item => Number.isInteger(item.id)));
    } finally {
      snoop?.dispose();
      await connection?.close();
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10 });
      await server.close();
    }
  },
);
