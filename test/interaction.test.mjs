import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connectPipe, createAgentTabs, createCua, createCaptcha } from "../src/index.js";

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

const FIXTURE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html>
<html><body style="margin:0;font-family:monospace">
<div id="captcha-box" style="position:absolute;left:40px;top:40px;width:200px;height:60px;border:2px solid #888;display:flex;align-items:center;gap:8px;padding:4px">
  <input type="checkbox" id="cb" style="width:24px;height:24px"><span>I'm not a robot</span>
</div>
<button id="btn" style="position:absolute;left:40px;top:140px;width:120px;height:40px">Click me</button>
<input id="name" style="position:absolute;left:40px;top:200px;width:200px;height:30px" type="text">
<div id="slider" style="position:absolute;left:40px;top:280px;width:300px;height:20px;background:#ddd">
  <div id="handle" style="position:absolute;left:0;top:0;width:20px;height:20px;background:#36c"></div>
</div>
<div id="captcha-text" style="position:absolute;left:40px;top:340px;width:220px;height:70px;font-size:44px;font-weight:bold;letter-spacing:8px;background:#fff;color:#000">XK7M2</div>
<div style="height:2000px"></div>
<div>bottom marker with enough text to pass the readiness probe</div>
<script>
window.__log = [];
document.getElementById('btn').addEventListener('click', () => window.__log.push('btn-clicked'));
document.getElementById('cb').addEventListener('change', e => window.__log.push('cb-' + e.target.checked));
const handle = document.getElementById('handle');
let dragging = false;
handle.addEventListener('mousedown', () => { dragging = true; window.__log.push('drag-start'); });
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  const track = document.getElementById('slider').getBoundingClientRect();
  const x = Math.max(0, Math.min(280, e.clientX - track.left - 10));
  handle.style.left = x + 'px';
  window.__log.push('drag-x-' + Math.round(x));
});
window.addEventListener('mouseup', () => { if (dragging) window.__log.push('drag-end'); dragging = false; });
</script></body></html>`)}`;

async function launch() {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-cua-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  return { connection, cleanup: async () => { await connection.close(); rmSync(ud, { recursive: true, force: true, maxRetries: 10 }); } };
}

async function boundsOf(page, selector) {
  return page.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
}

async function waitForState(page, expression, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(expression)) return;
    if (Date.now() > deadline) throw new Error(`waitForState timed out: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("cua drives coordinate click, type, keypress, and scroll", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(FIXTURE);
    const cua = createCua(page);

    const btn = await boundsOf(page, "#btn");
    await cua.click({ x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 });
    assert.ok((await page.evaluate("window.__log")).includes("btn-clicked"), "coordinate click hits the button");

    await page.locator("#name").click();
    await cua.type({ text: "hello cua" });
    assert.equal(await page.evaluate("document.getElementById('name').value"), "hello cua");

    await cua.keypress({ keys: ["ControlOrMeta", "a"] });
    const selected = await page.evaluate("window.getSelection().toString()");
    assert.equal(selected, "hello cua", "ControlOrMeta+a selects the input text");

    await cua.scroll({ x: 200, y: 200, scrollX: 0, scrollY: 400 });
    await waitForState(page, "window.scrollY > 100");

    const shot = await cua.getVisibleScreenshot();
    assert.ok(shot.length > 1000, "base64 screenshot returned");
    assert.doesNotThrow(() => Buffer.from(shot, "base64"));
  } finally {
    await cleanup();
  }
});

// Public page API: locator.screenshot() crops to the element plus its margin (#56: it threw "Invalid parameters" because
// the margin argument received the element).
test("locator.screenshot crops to the element and its margin", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(FIXTURE);
    const size = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
    const tight = size(await page.locator("#btn").screenshot({ type: "png", margin: 0 }));
    const scale = tight.width / 120;
    assert.ok(scale > 0, "the element screenshot has a width");
    assert.ok(Math.abs(tight.height / scale - 40) <= 1, `the crop is the 120x40 button (${tight.width}x${tight.height})`);
    const padded = size(await page.locator("#btn").screenshot({ type: "png", margin: 10 }));
    assert.ok(Math.abs(padded.width / scale - 140) <= 1 && Math.abs(padded.height / scale - 60) <= 1, `a 10px margin pads every side (${padded.width}x${padded.height})`);
  } finally {
    await cleanup();
  }
});

test("captcha clicks checkbox, drags slider, and OCRs text region", { skip: !SHELL && "no chromium binary found", timeout: 90000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(FIXTURE);
    // macOS runs the real Vision OCR; elsewhere a recording OCR proves readText hands over the cropped PNG.
    const ocrCalls = [];
    const ocr = process.platform === "darwin" ? undefined : async (png) => { ocrCalls.push(png); return ""; };
    const captcha = createCaptcha(page, { ocr });

    const box = await boundsOf(page, "#captcha-box");
    const tree = await captcha.click({ x: box.x, y: box.y, width: 30, height: box.height }, { settleMs: 100 });
    assert.ok((await page.evaluate("window.__log")).includes("cb-true"), "checkbox captcha becomes checked");
    assert.equal(typeof tree, "string");
    assert.ok(tree.includes("I'm not a robot"), "post-click snapshot tree returned");

    const handle = await boundsOf(page, "#handle");
    const track = await boundsOf(page, "#slider");
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const to = { x: track.x + track.width - 20, y: from.y };
    await captcha.drag(from, to, { steps: 10, settleMs: 100 });
    const log = await page.evaluate("window.__log");
    assert.ok(log.includes("drag-start") && log.includes("drag-end"), "drag lifecycle events fired");
    const lastX = Math.max(...log.filter(e => e.startsWith("drag-x-")).map(e => Number(e.slice(7))));
    assert.ok(lastX > 150, `slider handle moved right (x=${lastX})`);

    const textBounds = await boundsOf(page, "#captcha-text");
    const ocrText = await captcha.readText(textBounds);
    if (ocr) {
      assert.equal(ocrCalls.length, 1, "readText calls the OCR once");
      const png = ocrCalls[0];
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "OCR receives a PNG");
      const scale = png.readUInt32BE(16) / textBounds.width;
      assert.ok(Math.abs(png.readUInt32BE(20) / textBounds.height - scale) < 0.05, "PNG is cropped to the text bounds");
      const full = await page.screenshot({ type: "png" });
      assert.ok(png.readUInt32BE(16) < full.readUInt32BE(16), "PNG is a crop, not the full viewport");
    } else {
      assert.ok(ocrText, "OCR returned text");
      assert.equal(ocrText.replace(/[^A-Z0-9]/gi, "").toUpperCase(), "XK7M2");
    }
  } finally {
    await cleanup();
  }
});

// Public page API: clicking a target="_blank" link opens the new tab the way the browser does, so a QA script can attach
// it from listTargets() (#56: the click threw "Popup tab control requires the extension bridge" on every transport).
// Served over http: Chromium refuses a page-initiated top-level navigation to a data: URL.
test("clicking a target=_blank link opens the linked page in a new tab", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const site = createServer((req, res) => {
    const body = req.url === "/linked"
      ? "<title>Linked page</title><p>the linked page body text</p>"
      : '<p>a page with one link and enough text</p><a id="blank" href="/linked" target="_blank">Open in a new tab</a>';
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(`${origin}/`);
    const opened = page.waitForEvent("popup", { timeout: 10000 });
    await page.locator("#blank").click();
    assert.equal((await opened).url, `${origin}/linked`, "the browser opened the linked URL");
    const target = (await connection.listTargets()).find(t => t.url === `${origin}/linked`);
    assert.ok(target, "the new tab is listed");
    const tab = await connection.attachPage(target.id ?? target.targetId);
    assert.equal(await tab.title(), "Linked page");
  } finally {
    await cleanup();
    site.close();
  }
});
