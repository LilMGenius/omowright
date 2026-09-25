import { test } from "node:test";
import assert from "node:assert/strict";
import { createCaptcha } from "../src/captcha.js";

const bounds = { x: 20, y: 40, width: 300, height: 80 };

function fixture() {
  const events = [];
  const page = {
    mouse: {
      click: async (x, y) => events.push(["click", x, y]),
      move: async (x, y, options) => events.push(["move", x, y, options]),
      down: async () => events.push(["down"]),
      up: async () => events.push(["up"]),
    },
    snapshot: async () => ({ tree: "observed page", refs: {} }),
    screenshot: async options => { events.push(["screenshot", options]); return Buffer.from("image"); },
  };
  return { page, events, captcha: createCaptcha(page, { ocr: async png => png.toString() }) };
}

test("legacy click keeps geometric center and returns the snapshot string", async () => {
  const { captcha, events } = fixture();
  assert.equal(await captcha.click(bounds, { settleMs: 0 }), "observed page");
  assert.deepEqual(events, [["click", 170, 80]]);
});

test("legacy drag releases on movement failure", async () => {
  const { captcha, page, events } = fixture();
  const failure = new Error("movement failed");
  page.mouse.move = async (_x, _y, options) => { if (options) throw failure; };
  await assert.rejects(captcha.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { settleMs: 0 }), error => error === failure);
  assert.deepEqual(events, [["down"], ["up"]]);
});

test("legacy OCR receives the requested image crop", async () => {
  const { captcha, events } = fixture();
  assert.equal(await captcha.readText(bounds), "image");
  assert.deepEqual(events, [["screenshot", { type: "png", clip: bounds }]]);
});

test("explicit point targets the checkbox rather than the full widget center", async () => {
  const { captcha, events } = fixture();
  await captcha.click(bounds, { point: { x: 35, y: 80 }, approachSteps: 12, settleMs: 0 });
  assert.deepEqual(events, [["move", 35, 80, { steps: 12 }], ["click", 35, 80]]);
});

test("invalid click geometry and options reject before dispatching input", async () => {
  const cases = [
    [{ ...bounds, x: NaN }, {}],
    [{ ...bounds, width: 0 }, {}],
    [{ ...bounds, height: -1 }, {}],
    [{ ...bounds, x: Number.MAX_VALUE, width: Number.MAX_VALUE }, {}],
    [bounds, { point: { x: 320, y: 80 } }],
    [bounds, { point: { x: 35, y: 120 } }],
    [bounds, { point: { x: "35", y: 80 } }],
    [bounds, { point: { x: 19, y: 80 } }],
    [bounds, { approachSteps: 0 }],
    [bounds, { approachSteps: 1.5 }],
    [bounds, { settleMs: -1 }],
    [bounds, { settleMs: Infinity }],
  ];
  for (const [rectangle, options] of cases) {
    const { captcha, events } = fixture();
    await assert.rejects(captcha.click(rectangle, { settleMs: 0, ...options }));
    assert.deepEqual(events, []);
  }
});

test("invalid drag endpoints and steps reject before dispatching input", async () => {
  for (const options of [{ steps: 0 }, { steps: 1.5 }, { steps: Infinity }, { settleMs: -1 }]) {
    const { captcha, events } = fixture();
    await assert.rejects(captcha.drag({ x: 1, y: 2 }, { x: 3, y: 4 }, { settleMs: 0, ...options }));
    assert.deepEqual(events, []);
  }
  const { captcha, events } = fixture();
  await assert.rejects(captcha.drag({ x: NaN, y: 2 }, { x: 3, y: 4 }, { settleMs: 0 }));
  assert.deepEqual(events, []);
});
