import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compactSnapshot } from "./llm.js";

const DEFAULT_DRAG_STEPS = 20;
const POST_ACTION_SETTLE_MS = 3000;

function validatePoint(point) {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new TypeError("point coordinates must be finite numbers");
  }
}

function validateSteps(steps) {
  if (!Number.isSafeInteger(steps) || steps <= 0) {
    throw new RangeError("steps must be a positive safe integer");
  }
}

function validateSettleMs(value) {
  if (!Number.isFinite(value) || value < 0 || value > 2147483647) {
    throw new RangeError("settleMs must be between 0 and 2147483647");
  }
}

const MACOS_VISION_OCR_SWIFT = `
import Vision
import AppKit
let path = CommandLine.arguments[1]
guard let nsImage = NSImage(contentsOfFile: path),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do { try handler.perform([request]) } catch { exit(3) }
let text = (request.results ?? [])
  .compactMap { $0.topCandidates(1).first?.string }
  .joined(separator: " ")
print(text)
`;

export async function macOSVisionOcr(pngBuffer) {
  if (process.platform !== "darwin") {
    throw new Error("macOSVisionOcr is only available on macOS; pass a custom ocr(buffer) instead");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-ocr-"));
  try {
    const imagePath = path.join(dir, "region.png");
    const scriptPath = path.join(dir, "ocr.swift");
    writeFileSync(imagePath, pngBuffer);
    writeFileSync(scriptPath, MACOS_VISION_OCR_SWIFT);
    return await new Promise((resolve, reject) => {
      const child = spawn("swift", [scriptPath, imagePath], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) {
          const text = stdout.trim();
          resolve(text.length > 0 ? text : null);
        } else {
          reject(new Error(`Vision OCR failed (exit ${code}): ${stderr.trim()}`));
        }
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createCaptcha(page, options = {}) {
  const ocr = options.ocr ?? macOSVisionOcr;

  function centerOf(bounds) {
    validatePoint(bounds);
    if (!Number.isFinite(bounds.width) || bounds.width <= 0
      || !Number.isFinite(bounds.height) || bounds.height <= 0
      || !Number.isFinite(bounds.x + bounds.width) || !Number.isFinite(bounds.y + bounds.height)) {
      throw new RangeError("bounds must have positive finite dimensions and finite edges");
    }
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  async function settleAndSnapshot(settleMs) {
    await new Promise(resolve => setTimeout(resolve, settleMs));
    return compactSnapshot(await page.snapshot());
  }

  return {
    page,

    async click(bounds, opts = {}) {
      const center = centerOf(bounds);
      const point = opts.point === undefined ? center : opts.point;
      validatePoint(point);
      if (point.x < bounds.x || point.x >= bounds.x + bounds.width
        || point.y < bounds.y || point.y >= bounds.y + bounds.height) {
        throw new RangeError("point must be inside bounds");
      }
      const settleMs = opts.settleMs === undefined ? POST_ACTION_SETTLE_MS : opts.settleMs;
      validateSettleMs(settleMs);
      if (opts.approachSteps !== undefined) {
        validateSteps(opts.approachSteps);
        await page.mouse.move(point.x, point.y, { steps: opts.approachSteps });
      }
      await page.mouse.click(point.x, point.y);
      return settleAndSnapshot(settleMs);
    },

    async drag(from, to, opts = {}) {
      validatePoint(from);
      validatePoint(to);
      const steps = opts.steps === undefined ? DEFAULT_DRAG_STEPS : opts.steps;
      validateSteps(steps);
      const settleMs = opts.settleMs === undefined ? POST_ACTION_SETTLE_MS : opts.settleMs;
      validateSettleMs(settleMs);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      try {
        await page.mouse.move(to.x, to.y, { steps });
      } finally {
        await page.mouse.up();
      }
      return settleAndSnapshot(settleMs);
    },

    async readText(bounds) {
      const buffer = await page.screenshot(bounds ? { type: "png", clip: bounds } : { type: "png" });
      return ocr(buffer);
    },
  };
}
