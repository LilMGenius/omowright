import assert from "node:assert/strict";
import { mkdtempSync, rmSync, globSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectPipe, createAgentTabs, createCaptcha } from "../../src/index.js";

const html = `<!doctype html><html><body style="font:20px sans-serif;margin:40px">
<h1>CAPTCHA interaction fixture</h1>
<div id="captcha-widget" style="width:300px;height:80px;border:1px solid;display:flex;align-items:center;gap:20px">
<input id="captcha-checkbox" type="checkbox" style="width:24px;height:24px;margin:12px"><span>Confirm input</span></div>
<p id="application-status" data-accepted="false">Application: pending</p>
<input id="slider-handle" type="range" min="0" max="100" value="0" style="width:300px">
<script>
window.events=[];
for(const type of ['mousemove','mousedown','mouseup','click','change','input']){
  document.addEventListener(type,e=>events.push({type,target:e.target.id,trusted:e.isTrusted,x:e.clientX,y:e.clientY,buttons:e.buttons}));
}
window.accept=()=>{const el=document.getElementById('application-status');el.dataset.accepted='true';el.textContent='Application: accepted';};
</script></body></html>`;

async function boundsOf(page, selector) {
  return page.evaluate(selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, selector);
}

async function arm(page, type) {
  await page.evaluate(type => {
    window.nextInput = new Promise((resolve, reject) => {
      const listener = e => { clearTimeout(timer); resolve({ type: e.type, trusted: e.isTrusted, buttons: e.buttons }); };
      const timer = setTimeout(() => { document.removeEventListener(type, listener); reject(Error("input event missing")); }, 5000);
      document.addEventListener(type, listener, { once: true });
    });
    window.nextInput.catch(() => {});
  }, type);
}

export async function runScenario(scenario, evidenceDir) {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  const profile = mkdtempSync(path.join(tmpdir(), "omowright-captcha-qa-"));
  const browserPath = process.env.SHELL_BIN ?? globSync(path.join(process.env.HOME,
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")).sort().at(-1);
  assert.ok(browserPath, "A real Chromium binary is required");
  let browser;
  const result = { scenario, passed: false };
  try {
    browser = await connectPipe({ browserPath, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`], storageRoot: profile });
    const { page } = await createAgentTabs(browser).create("about:blank");
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    await page._sendToTarget("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.refreshViewportSize();
    await page.bringToFront();
    result.foreground = await page.evaluate(() => ({ visible: document.visibilityState, focused: document.hasFocus() }));
    assert.deepEqual(result.foreground, { visible: "visible", focused: true });
    const captcha = createCaptcha(page);
    const box = await boundsOf(page, "#captcha-widget");
    const checkbox = await boundsOf(page, "#captcha-checkbox");
    const point = { x: checkbox.x + checkbox.width / 2, y: checkbox.y + checkbox.height / 2 };
    if (evidenceDir) writeFileSync(path.join(evidenceDir, "before.png"), await page.screenshot({ type: "png" }));
    if (scenario === "targeting") {
      await captcha.click(box, { settleMs: 0 });
      assert.equal(await page.evaluate(() => document.querySelector("#captcha-checkbox").checked), false, "legacy center is unchanged");
      await arm(page, "click");
      await captcha.click(box, { point, approachSteps: 12, settleMs: 0 });
      result.clickEvent = await page.evaluate(() => window.nextInput);
      result.checked = await page.evaluate(() => document.querySelector("#captcha-checkbox").checked);
      if (evidenceDir) writeFileSync(path.join(evidenceDir, "after.png"), await page.screenshot({ type: "png" }));
      assert.equal(result.checked, true, "explicit point must check the checkbox");
      assert.equal(result.clickEvent.trusted, true);
      const slider = await boundsOf(page, "#slider-handle");
      await arm(page, "mouseup");
      await captcha.drag({ x: slider.x + 8, y: slider.y + slider.height / 2 },
        { x: slider.x + slider.width - 8, y: slider.y + slider.height / 2 }, { steps: 12, settleMs: 0 });
      result.releaseEvent = await page.evaluate(() => window.nextInput);
      result.sliderValue = await page.evaluate(() => Number(document.querySelector("#slider-handle").value));
      assert.equal(result.releaseEvent.trusted, true);
      assert.equal(result.releaseEvent.buttons, 0);
      assert.ok(result.sliderValue > 80);
      const eventsBefore = await page.evaluate(() => window.events.length);
      await assert.rejects(captcha.click(box, { point: { x: box.x - 1, y: box.y }, settleMs: 0 }));
      assert.equal(await page.evaluate(() => window.events.length), eventsBefore);
    } else {
      throw new Error(`Unknown scenario: ${scenario}`);
    }
    result.events = await page.evaluate(() => window.events);
    result.passed = true;
    return result;
  } catch (error) {
    result.error = error.message;
    throw error;
  } finally {
    if (browser) await browser.close();
    rmSync(profile, { recursive: true, force: true });
    if (evidenceDir) {
      writeFileSync(path.join(evidenceDir, "surface.json"), JSON.stringify(result, null, 2));
      writeFileSync(path.join(evidenceDir, "cleanup.json"), JSON.stringify({ browserClosed: Boolean(browser), profileRemoved: !existsSync(profile), profile }, null, 2));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const scenario = process.argv[process.argv.indexOf("--scenario") + 1] ?? "targeting";
  await runScenario(scenario, process.env.CAPTCHA_EVIDENCE_DIR);
  console.log(`PASS ${scenario}`);
}
