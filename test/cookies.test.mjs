import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs, injectCookies, sanitizeCookies } from "../src/index.js";

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

test("sanitizeCookies normalizes raw cookie exports for CDP", () => {
  const raw = [
    { name: "session", value: "abc", domain: "example.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-csrf", value: "xyz", domain: "example.com", path: "/", expires: 1790066399, secure: false, httpOnly: false, sameSite: "None" },
    { name: "pref", value: "1", domain: ".example.com", path: "/", expires: 1790066399, secure: false, httpOnly: false, sameSite: "None" },
    { name: "pref", value: "2", domain: ".example.com", path: "/", expires: 1890066399, secure: false, httpOnly: false },
  ];
  const out = sanitizeCookies(raw);

  const session = out.find(c => c.name === "session");
  assert.equal("expires" in session, false, "negative expires dropped");
  assert.equal(session.sameSite, "Lax");

  const host = out.find(c => c.name === "__Host-csrf");
  assert.equal(host.secure, true, "__Host- forces secure");
  assert.equal(host.path, "/", "__Host- forces root path");
  assert.equal("domain" in host, false, "__Host- uses url, not domain");
  assert.equal(host.url, "https://example.com");
  assert.equal(host.sameSite, "None", "SameSite=None valid once secure is forced");

  const prefs = out.filter(c => c.name === "pref");
  assert.equal(prefs.length, 1, "duplicate name+domain deduped");
  assert.equal(prefs[0].value, "2", "latest expiry wins");
  assert.equal(prefs[0].sameSite, undefined, "SameSite=None without secure dropped");
});

test("injectCookies sets cookies reachable on navigation", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-cookies-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await injectCookies(page, [
      { name: "omw_test", value: "works", domain: "example.com", expires: Math.floor(Date.now() / 1000) + 3600 },
      { name: "__Host-pinned", value: "yes", domain: "example.com", expires: Math.floor(Date.now() / 1000) + 3600 },
    ]);
    await page.goto("https://example.com");
    const cookieHeader = await page.evaluate("document.cookie");
    assert.ok(cookieHeader.includes("omw_test=works"), `injected cookie visible: ${cookieHeader}`);
    assert.ok(cookieHeader.includes("__Host-pinned=yes"), `host-pinned cookie visible: ${cookieHeader}`);
  } finally {
    await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
  }
});
