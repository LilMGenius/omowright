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

test("waitFor matches strict application acceptance without input or snapshots", async () => {
  const { captcha, page, events } = fixture();
  page.snapshot = () => { throw Error("waitFor must not snapshot"); };
  let operationSignal;
  assert.equal(typeof captcha.waitFor, "function", "captcha must support explicit completion waiting");
  const result = await captcha.waitFor({ until: (actualPage, { signal }) => {
    assert.equal(actualPage, page);
    operationSignal = signal;
    return true;
  } });
  assert.deepEqual(Object.keys(result).sort(), ["elapsedMs", "outcome"]);
  assert.equal(result.outcome, "matched");
  assert.ok(result.elapsedMs >= 0);
  assert.equal(operationSignal.aborted, true);
  assert.deepEqual(events, []);
});

test("waitFor rejects truthy non-boolean acceptance", async () => {
  const { captcha } = fixture();
  for (const value of ["true", {}, 1]) {
    const result = await captcha.waitFor({ until: () => value, timeoutMs: 5, pollMs: 1 });
    assert.equal(result.outcome, "timed_out");
  }
});

test("waitFor pre-abort takes priority over zero timeout without invoking a predicate", async () => {
  const { captcha } = fixture();
  const controller = new AbortController();
  controller.abort();
  const until = () => { throw Error("must not run"); };
  assert.equal((await captcha.waitFor({ until, signal: controller.signal, timeoutMs: 0 })).outcome, "cancelled");
  assert.equal((await captcha.waitFor({ until, timeoutMs: 0 })).outcome, "timed_out");
});

test("waitFor validates options before invoking a predicate", async () => {
  const { captcha } = fixture();
  let called = false;
  const until = () => { called = true; return true; };
  for (const options of [
    { until: "not a predicate" }, { timeoutMs: -1 }, { timeoutMs: Infinity },
    { timeoutMs: 2147483648 }, { timeoutMs: "10" }, { pollMs: 0 },
    { pollMs: NaN }, { pollMs: 2147483648 }, { signal: {} },
  ]) {
    await assert.rejects(captcha.waitFor({ until, ...options }));
  }
  assert.equal(called, false);
});

test("waitFor bounds a never-settling predicate and aborts its operation signal", async () => {
  const { captcha } = fixture();
  let signal;
  let calls = 0;
  const result = await captcha.waitFor({ until: (_page, context) => {
    signal = context.signal;
    calls++;
    return new Promise(() => {});
  }, timeoutMs: 10, pollMs: 1 });
  assert.equal(result.outcome, "timed_out");
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
});

test("waitFor cancels pending work and observes its late rejection", async () => {
  const { captcha } = fixture();
  const controller = new AbortController();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let rejectPredicate;
  const predicate = new Promise((_resolve, reject) => { rejectPredicate = reject; });
  const pending = captcha.waitFor({ signal: controller.signal, until: () => { entered(); return predicate; } });
  await started;
  controller.abort();
  assert.equal((await pending).outcome, "cancelled");
  rejectPredicate(Error("late rejection"));
  // One event-loop turn delivers unhandled rejections if the wait abandoned one.
  await new Promise(setImmediate);
});

test("waitFor propagates predicate errors and cleans its abort listener", async () => {
  const { captcha } = fixture();
  const controller = new AbortController();
  const listeners = new Set();
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(type, fn, options) { listeners.add(fn); controller.signal.addEventListener(type, fn, options); },
    removeEventListener(type, fn) { listeners.delete(fn); controller.signal.removeEventListener(type, fn); },
  };
  const failure = Error("application check failed");
  let operationSignal;
  await assert.rejects(captcha.waitFor({ signal, until: (_page, context) => {
    operationSignal = context.signal;
    throw failure;
  } }), error => error === failure);
  assert.equal(listeners.size, 0);
  assert.equal(operationSignal.aborted, true);
});

test("waitFor cancellation wins over a same-turn successful predicate", async () => {
  const { captcha } = fixture();
  const controller = new AbortController();
  const result = await captcha.waitFor({ signal: controller.signal, until: () => {
    controller.abort();
    return true;
  } });
  assert.equal(result.outcome, "cancelled");
});

test("waitFor keeps checks serial until an application gate permits acceptance", async () => {
  const { captcha } = fixture();
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0;
  let calls = 0;
  const pending = captcha.waitFor({ pollMs: 1, until: async () => {
    assert.equal(active++, 0, "predicates must never overlap");
    calls++;
    if (calls === 1) { enter(); await gate; }
    active--;
    return calls > 1;
  } });
  await entered;
  assert.equal(calls, 1);
  release();
  assert.equal((await pending).outcome, "matched");
  assert.equal(calls, 2);
});
