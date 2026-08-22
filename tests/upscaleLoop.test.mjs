#!/usr/bin/env node
/**
 * NCNN Iterative Upscale Loop Test
 *
 * Verifies upscaleToTarget() chains multiple fixed-factor passes until both dimensions
 * reach `ncnnUpscaleTolerance` of the target size, and skips upscaling entirely when
 * the source is already large enough.
 *
 * Requires ImageMagick v7+; uses the real NCNN binary/models when present, otherwise SKIPs.
 *
 * Usage:
 *   node tests/upscaleLoop.test.mjs
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import ImageProcessor from "../src/lib/imageProcessor.js"

const MAGICK = "/usr/bin/magick"
const NCNN_BIN = process.env.WALLPAPERINHO_TEST_NCNN || "/usr/local/esrgan-ncnn/bin/realesrgan-ncnn-vulkan"
const NCNN_MODEL_DIR = process.env.WALLPAPERINHO_TEST_NCNN_MODELS || "/home/kyeno/AI/models/ncnn/"
const NCNN_MODEL = "4xNomos8kSC"

let magickOk = false
try {
    magickOk = /ImageMagic[k]?s?\s+7\./i.test(execFileSync(MAGICK, ["--version"]).toString().split("\n")[0])
} catch {}
if (!magickOk) {
    console.log("[upscaleLoop] SKIP — ImageMagick v7+ not found")
    process.exit(0)
}

let ncnnAvailable = false
try {
    fs.accessSync(NCNN_BIN, fs.constants.X_OK)
    fs.accessSync(path.join(NCNN_MODEL_DIR, `${NCNN_MODEL}.param`), fs.constants.R_OK)
    ncnnAvailable = true
} catch {}
if (!ncnnAvailable) {
    console.log("[upscaleLoop] SKIP — NCNN binary/model not available (IM-only mode is covered by generatePipeline)")
    process.exit(0)
}

const logger = { log: () => {}, debug: () => {}, info: () => {}, warn: (...a) => console.warn("  WARN", ...a), error: (...a) => console.error("  ERROR", ...a) }

function makeConfig(settings) {
    return {
        settings,
        getNcnnUpscalerCommand(inputPath, outputPath) {
            const s = settings
            if (!s.ncnnUpscalerBin?.trim()) return []
            const args = ["-m", s.ncnnUpscalerModelDir, "-n", s.ncnnUpscalerModel, "-s", s.ncnnUpscalerScale]
            if (s.ncnnUpscalerFlags?.trim()) args.push(...s.ncnnUpscalerFlags.trim().split(/\s+/))
            return [...args, "-i", inputPath, "-o", outputPath]
        },
    }
}

function identify(p) {
    const [w, h] = execFileSync(MAGICK, ["identify", "-format", "%w %h", p]).toString().trim().split(/\s+/).map((n) => parseInt(n, 10))
    return { width: w, height: h }
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallpaperinho-loop-"))
try {
    const settings = {
        ncnnUpscalerBin: NCNN_BIN,
        ncnnUpscalerModelDir: NCNN_MODEL_DIR,
        ncnnUpscalerModel: NCNN_MODEL,
        ncnnUpscalerScale: "4",
        ncnnUpscalerFlags: "-g 0",
        ncnnUpscaleTolerance: "0.95",
        ncnnMaxUpscalePasses: 3,
    }
    const processor = new ImageProcessor(makeConfig(settings), logger)

    // Case A -- small source (512x768) for a 2560x1600 slot needs TWO x4 passes:
    //   pass 1 -> 2048x3072 (still < 2432 min-width) ; pass 2 -> 8192x12288 (done)
    const smallSrc = path.join(workDir, "small.jpg")
    execFileSync(MAGICK, ["-size", "512x768", "plasma:#123-#abc", "-quality", "90", smallSrc])
    const baseA = path.join(workDir, "loop-a")
    const resA = await processor.upscaleToTarget(smallSrc, baseA, 2560, 1600)
    assert.equal(resA.passes, 2, `expected exactly 2 chained passes, got ${resA.passes}`)
    assert.ok(resA.width >= Math.ceil(2560 * 0.95), `final width ${resA.width} below tolerance`)
    assert.ok(resA.height >= Math.ceil(1600 * 0.95), `final height ${resA.height} below tolerance`)
    assert.equal(resA.intermediates.length, 2, "two intermediates expected")
    for (const f of resA.intermediates) assert.ok(fs.existsSync(f), `intermediate missing: ${f}`)
    console.log(`  ✓ two-pass chain: 512x768 -> ${resA.width}x${resA.height} (passes=${resA.passes})`)

    // Case B -- source already within tolerance of target: zero GPU passes
    const bigSrc = path.join(workDir, "big.jpg")
    execFileSync(MAGICK, ["-size", "2600x1700", "gradient:#234-#87a", "-quality", "90", bigSrc])
    const baseB = path.join(workDir, "loop-b")
    const resB = await processor.upscaleToTarget(bigSrc, baseB, 2560, 1600)
    assert.equal(resB.passes, 0, `expected no passes, got ${resB.passes}`)
    assert.equal(resB.path, bigSrc, "input should be returned unchanged")
    assert.equal(resB.intermediates.length, 0)
    console.log("  ✓ already-large source skips NCNN entirely")

    for (const f of [...resA.intermediates]) fs.rmSync(f, { force: true })
    console.log("\n[upscaleLoop] All assertions passed")
} catch (err) {
    console.error(`\n[upscaleLoop] FAILED — ${err.message}`)
    process.exitCode = 1
} finally {
    fs.rmSync(workDir, { recursive: true, force: true })
}