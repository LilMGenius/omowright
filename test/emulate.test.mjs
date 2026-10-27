import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { DEVICE_PRESETS, emulate } from "../src/emulate.js";

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

// FakeCdp pattern from events.test.mjs
class FakeEmitter {
  #listeners = new Map();
  on(method, listener) {
    const set = this.#listeners.get(method) ?? new Set();
    set.add(listener);
    this.#listeners.set(method, set);
    return () => set.delete(listener);
  }
  emit(method, params, meta = {}) {
    for (const listener of [...(this.#listeners.get(method) ?? [])]) {
      listener(params, meta);
    }
  }
}

class FakeCdp {
  constructor() {
    this.calls = [];
    this.events = new FakeEmitter();
  }
  async send(method, params, sessionId, options) {
    this.calls.push({ method, params, sessionId, options });
    return {};
  }
  on(method, listener) {
    return this.events.on(method, listener);
  }
}

// Unit tests with fake page
test("DEVICE_PRESETS has required keys", () => {
  assert(DEVICE_PRESETS["iphone-14"], "iphone-14 preset missing");
  assert(DEVICE_PRESETS["pixel-7"], "pixel-7 preset missing");
  assert(DEVICE_PRESETS["ipad-air"], "ipad-air preset missing");
  assert(DEVICE_PRESETS["desktop-1440"], "desktop-1440 preset missing");
  
  const ip14 = DEVICE_PRESETS["iphone-14"];
  assert.equal(ip14.width, 390);
  assert.equal(ip14.height, 844);
  assert.equal(ip14.deviceScaleFactor, 3);
  assert.equal(ip14.mobile, true);
  assert.equal(ip14.hasTouch, true);
  assert(ip14.userAgent && ip14.userAgent.includes("iPhone"));
  assert.equal(ip14.platform, "iPhone");

  const px7 = DEVICE_PRESETS["pixel-7"];
  assert.equal(px7.width, 412);
  assert.equal(px7.height, 915);
  assert.equal(px7.deviceScaleFactor, 2.625);
  assert.equal(px7.mobile, true);
  assert.equal(px7.hasTouch, true);
  assert(px7.userAgent && px7.userAgent.includes("Android"));
  assert.equal(px7.platform, "Linux armv8l");

  const ipad = DEVICE_PRESETS["ipad-air"];
  assert.equal(ipad.width, 820);
  assert.equal(ipad.height, 1180);
  assert.equal(ipad.deviceScaleFactor, 2);
  assert.equal(ipad.mobile, true);
  assert.equal(ipad.hasTouch, true);
  assert(ipad.userAgent && ipad.userAgent.includes("iPad"));
  assert.equal(ipad.platform, "MacIntel");

  const desktop = DEVICE_PRESETS["desktop-1440"];
  assert.equal(desktop.width, 1440);
  assert.equal(desktop.height, 900);
  assert.equal(desktop.deviceScaleFactor, 1);
  assert.equal(desktop.mobile, false);
  assert.equal(desktop.hasTouch, false);
  assert.equal(desktop.userAgent, undefined);
});

test("emulate(page, 'iphone-14') sends correct CDP calls", async () => {
  const cdp = new FakeCdp();
  const page = {
    cdp,
    resolveSessionId: async () => "s1",
    evaluate: async () => "OrigUA",
    refreshViewportSize: async () => {},
  };

  const preset = await emulate(page, "iphone-14");
  
  assert.equal(preset.width, 390);
  assert.equal(preset.height, 844);
  
  const metrics = cdp.calls.find(c => c.method === "Emulation.setDeviceMetricsOverride");
  assert(metrics, "setDeviceMetricsOverride not called");
  assert.deepEqual(metrics.params, {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  assert.equal(metrics.sessionId, "s1");

  const touch = cdp.calls.find(c => c.method === "Emulation.setTouchEmulationEnabled");
  assert(touch, "setTouchEmulationEnabled not called");
  assert.deepEqual(touch.params, { enabled: true, maxTouchPoints: 5 });
  assert.equal(touch.sessionId, "s1");

  const ua = cdp.calls.find(c => c.method === "Emulation.setUserAgentOverride");
  assert(ua, "setUserAgentOverride not called");
  assert(ua.params.userAgent.includes("iPhone"));
  assert.equal(ua.params.platform, "iPhone");
  assert.equal(ua.sessionId, "s1");
});

test("emulate(page, null) restores original UA", async () => {
  const cdp = new FakeCdp();
  const page = {
    cdp,
    resolveSessionId: async () => "s1",
    evaluate: async () => "OrigUA",
    refreshViewportSize: async () => {},
  };

  // First emulate to set up
  await emulate(page, "iphone-14");
  cdp.calls = []; // Clear calls

  // Now restore
  await emulate(page, null);

  const clearMetrics = cdp.calls.find(c => c.method === "Emulation.clearDeviceMetricsOverride");
  assert(clearMetrics, "clearDeviceMetricsOverride not called");
  assert.equal(clearMetrics.sessionId, "s1");

  const restoreTouchDisabled = cdp.calls.find(c => c.method === "Emulation.setTouchEmulationEnabled");
  assert(restoreTouchDisabled, "setTouchEmulationEnabled not called on restore");
  assert.deepEqual(restoreTouchDisabled.params, { enabled: false });
  assert.equal(restoreTouchDisabled.sessionId, "s1");

  const restoreUA = cdp.calls.find(c => c.method === "Emulation.setUserAgentOverride");
  assert(restoreUA, "setUserAgentOverride not called on restore");
  assert.equal(restoreUA.params.userAgent, "OrigUA");
  assert.equal(restoreUA.sessionId, "s1");
});

test("emulate() throws on unknown preset", async () => {
  const cdp = new FakeCdp();
  const page = {
    cdp,
    resolveSessionId: async () => "s1",
    evaluate: async () => "OrigUA",
    refreshViewportSize: async () => {},
  };

  await assert.rejects(
    emulate(page, "unknown-device"),
    /unknown device preset: unknown-device/
  );
});

// Integration tests with real headless shell
test("emulate(page, 'iphone-14') live test", { skip: !SHELL && "no chromium binary found", timeout: 60_000 }, async () => {

  let connection;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-emulate-test-"));
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
    
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    
    // Emulate iPhone-14
    const preset = await emulate(page, "iphone-14");
    
    // Verify preset was returned
    assert.equal(preset.width, 390, "preset should be iphone-14");
    
    // Check UA and touch points (UA should change regardless of navigation)
    const result = await page.evaluate(() => [
      navigator.userAgent,
      navigator.maxTouchPoints,
    ]);
    
    assert(result[0].includes("iPhone"), `UA should contain "iPhone", got: ${result[0]}`);
    assert.equal(result[1], 5, "maxTouchPoints should be 5");
    
    await page.close();
  } finally {
    if (connection) await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("emulate(page, null) live restore test", { skip: !SHELL && "no chromium binary found", timeout: 60_000 }, async () => {

  let connection;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-emulate-restore-test-"));
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
    
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    
    // First check the original UA
    const origUA = await page.evaluate(() => navigator.userAgent);
    
    // Emulate iPhone-14
    await emulate(page, "iphone-14");
    
    // Check that UA changed to iPhone
    const iphoneUA = await page.evaluate(() => navigator.userAgent);
    assert(iphoneUA.includes("iPhone"), `UA should contain "iPhone" after emulation`);
    
    // Restore
    await emulate(page, null);
    
    // Check that UA is back to original
    const restoredUA = await page.evaluate(() => navigator.userAgent);
    assert.equal(restoredUA, origUA, "UA should be restored to original");
    
    await page.close();
  } finally {
    if (connection) await connection.close();
    rmSync(ud, { recursive: true, force: true, maxRetries: 10 });
  }
});
