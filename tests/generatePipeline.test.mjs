#!/usr/bin/env node
/**
 * End-to-End Pipeline Test -- "vertical-only catalog" regression
 *
 * Reproduces the original failure: displays [1080x1920 V] [2560x1600 H] [1080x1920 V],
 * a catalog containing ONLY vertical images, and verifies that:
 *   - every display gets a real image (no "undefined" sources),
 *   - NCNN iterative upscaling runs when configured (skipped gracefully if unavailable),
 *   - each per-display tile is cropped to EXACT slot dimensions before compositing,
 *   - the final composite has the expected total size,
 *   - upscale intermediates are cleaned up.
 *
 * Requires ImageMagick v7+ (`magick`). NCNN binary/models are used when present at the
 * paths below; otherwise the ImageMagick-only path is exercised instead.
 *
 * Exit codes: 0 = pass/skip-ok, 1 = fail.
 *
 * Usage:
 *   node tests/generatePipeline.test.mjs
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import DatabaseService from "../src/services/databaseService.js"
import ImageProcessor from "../src/lib/imageProcessor.js"
import ImageSelector from "../src/lib/imageSelector.js"
import DisplayAssignment from "../src/lib/displayAssignment.js"
import WallpaperGenerator from "../src/lib/wallpaperGenerator.js"

// ---------------------------------------------------------------------------
// Environment probes -- skip gracefully where tooling is missing
// ---------------------------------------------------------------------------
const MAGICK = "/usr/bin/magick"
const NCNN_BIN = process.env.WALLPAPERINHO_TEST_NCNN || "/usr/local/esrgan-ncnn/bin/realesrgan-ncnn-vulkan"
const NCNN_MODEL_DIR = process.env.WALLPAPERINHO_TEST_NCNN_MODELS || "/home/kyeno/AI/models/ncnn/"
const NCNN_MODEL = "4xNomos8kSC"

let magickOk = false
try {
    const v = execFileSync(MAGICK, ["--version"]).toString().split("\n")[0]
    magickOk = /ImageMagic[k]?s?\s+7\./i.test(v)
} catch {}

if (!magickOk) {
    console.log("[generatePipeline] SKIP — ImageMagick v7+ not found at", MAGICK)
    process.exit(0)
}

let ncnnAvailable = false
try {
    fs.accessSync(NCNN_BIN, fs.constants.X_OK)
    fs.accessSync(path.join(NCNN_MODEL_DIR, `${NCNN_MODEL}.param`), fs.constants.R_OK)
    ncnnAvailable = true
} catch {}

// ---------------------------------------------------------------------------
// Logger + config stubs (mirror the ConfigService surface used by the pipeline)
// ---------------------------------------------------------------------------
const messages = []
const logger = {
    log: (...a) => messages.push(a.join(" ")),
    debug: () => {},
    info: (...a) => messages.push(a.join(" ")),
    warn: (...a) => messages.push(`WARN ${a.join(" ")}`),
    error: (...a) => messages.push(`ERROR ${a.join(" ")}`),
}

const DISPLAYS = [[1080, 1920], [2560, 1600], [1080, 1920]]
const EXPECTED_TOTAL_W = DISPLAYS.reduce((sum, d) => sum + d[0], 0) // 4720
const EXPECTED_MAX_H = Math.max(...DISPLAYS.map((d) => d[1]))       // 1920

function makeConfig(settings) {
    return {
        settings,
        isNcnnConfigured() {
            const bin = this.settings.ncnnUpscalerBin
            return typeof bin === "string" && bin.trim() !== ""
        },
        getNcnnUpscalerArgs() {
            if (!this.isNcnnConfigured()) return []
            const s = this.settings
            const args = []
            if (s.ncnnUpscalerModelDir) args.push("-m", s.ncnnUpscalerModelDir)
            if (s.ncnnUpscalerModel) args.push("-n", s.ncnnUpscalerModel)
            if (s.ncnnUpscalerScale) args.push("-s", s.ncnnUpscalerScale)
            if (s.ncnnUpscalerFlags?.trim()) args.push(...s.ncnnUpscalerFlags.trim().split(/\s+/))
            return args
        },
        getNcnnUpscalerCommand(inputPath, outputPath) {
            const base = this.getNcnnUpscalerArgs()
            return base.length ? [...base, "-i", inputPath, "-o", outputPath] : []
        },
    }
}

function identify(filePath) {
    const out = execFileSync(MAGICK, ["identify", "-format", "%w %h", filePath]).toString().trim()
    const [w, h] = out.split(/\s+/).map((n) => parseInt(n, 10))
    return { width: w, height: h }
}

// ---------------------------------------------------------------------------
// Main -- build a vertical-only catalog and run the full generation pipeline
// ---------------------------------------------------------------------------
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallpaperinho-e2e-"))
const srcDir = path.join(workDir, "sources")
const outDir = path.join(workDir, "output")
const tmpDir = path.join(workDir, "tmp")
fs.mkdirSync(srcDir, { recursive: true })

let failures = 0
try {
    // Three synthetic VERTICAL images (the original failure condition)
    const sources = [
        { name: "v1.jpg", spec: "gradient:#234-#87a" },
        { name: "v2.jpg", spec: "plasma:#123-#abc" },
        { name: "v3.jpg", spec: "radial-gradient:#456-#def" },
    ]
    for (const s of sources) {
        execFileSync(MAGICK, ["-size", "1024x1536", s.spec, "-quality", "90", path.join(srcDir, s.name)])
    }

    const settings = {
        debugOverlay: false,
        displays: DISPLAYS,
        monitorAlignment: "bottom",
        wallpaperOutputDirectory: outDir,
        tempDirectory: tmpDir,
        wallpaperOutputJpegQuality: 90,
        imagickBin: MAGICK,
        ncnnUpscalerBin: ncnnAvailable ? NCNN_BIN : "",
        ncnnUpscalerModelDir: NCNN_MODEL_DIR,
        ncnnUpscalerModel: NCNN_MODEL,
        ncnnUpscalerScale: "4",
        ncnnUpscalerFlags: "-g 0",
        ncnnUpscaleTolerance: "0.95",
        ncnnMaxUpscalePasses: 3,
        // Use the real default strategy so seed + harmony picks + cross-orientation fallback are exercised
        imageMatchingStrategy: "gemini",
    }
    const config = makeConfig(settings)

    // Catalog DB with ONLY vertical rows
    const dbPath = path.join(workDir, "images.sqlite3")
    const db = new DatabaseService(dbPath, logger)
    await db.initialize()
    // Distinct metric values per image so gemini's harmony ranking has something to work with
    const metrics = [
        { hue: 210, saturation: 30, lightness: 40, contrast: 40, canny: 8, entropy: 5.1 },
        { hue: 220, saturation: 25, lightness: 45, contrast: 45, canny: 9, entropy: 5.2 },
        { hue: 230, saturation: 20, lightness: 50, contrast: 50, canny: 7, entropy: 5.3 },
    ]
    for (let i = 0; i < sources.length; i++) {
        const p = path.join(srcDir, sources[i].name)
        await db.insertImage({
            path: p, width: 1024, height: 1536, filesize: fs.statSync(p).size, ...metrics[i],
        })
    }

    const processor = new ImageProcessor(config, logger)
    const selector = new ImageSelector(db, config, processor, logger)
    const assignment = new DisplayAssignment(DISPLAYS, logger)
    // Stub setter: pretend to be Hyprland so per-display tiles are kept in outDir for inspection
    const setterStub = {
        system: { desktop: { environment: "hyprland" } },
        set: async () => true,
    }
    const generator = new WallpaperGenerator(
        config, db, processor, selector, assignment, setterStub, logger
    )

    console.log(`[generatePipeline] running pipeline (${ncnnAvailable ? "NCNN enabled" : "IM-only mode"}) ...`)
    const compositePath = await generator.generate(null)

    assert.ok(typeof compositePath === "string", `expected a composite path, got ${compositePath}`)
    assert.ok(fs.existsSync(compositePath), "composite file must exist")

    // Composite must be exactly the full virtual-desktop size
    const compDims = identify(compositePath)
    assert.equal(compDims.width, EXPECTED_TOTAL_W, `composite width ${compDims.width} != ${EXPECTED_TOTAL_W}`)
    assert.equal(compDims.height, EXPECTED_MAX_H, `composite height ${compDims.height} != ${EXPECTED_MAX_H}`)
    console.log(`  ✓ composite is exactly ${compDims.width}x${compDims.height}`)

    // Every per-display tile must exist at EXACT slot dimensions (crop-to-screen proof).
    // Hyprland stub keeps tiles in outDir; find them by their -displayN.jpg suffix.
    const outFiles = fs.readdirSync(outDir)
    for (let i = 0; i < DISPLAYS.length; i++) {
        const [tw, th] = DISPLAYS[i]
        const match = outFiles.find((f) => f.endsWith(`-display${i}.jpg`))
        assert.ok(match, `per-display tile for display ${i} not found in output dir`)
        const dims = identify(path.join(outDir, match))
        assert.equal(dims.width, tw, `tile ${i}: width ${dims.width} != slot ${tw}`)
        assert.equal(dims.height, th, `tile ${i}: height ${dims.height} != slot ${th}`)
    }
    console.log("  ✓ all per-display tiles cropped to exact slot dimensions")

    // The original crash signature must be gone: no "undefined" sources/dimensions anywhere
    const badLines = messages.filter(
        (m) => m.includes("Source: undefined") || m.includes("undefinedxundefined")
    )
    assert.equal(badLines.length, 0, `found undefined-source log lines: ${badLines.join(" | ")}`)
    console.log("  ✓ no 'undefined' image references in pipeline logs")

    // The reported bug: under gemini strategy the same image was assigned twice when a slot
    // fell back cross-orientation. With exactly N sources and N slots, all must be distinct.
    const sourceLines = messages.filter((m) => m.startsWith("Source: "))
    assert.equal(sourceLines.length, DISPLAYS.length, `expected ${DISPLAYS.length} "Source:" lines, got ${sourceLines.length}`)
    const srcNames = sourceLines.map((l) => l.replace(/^Source: /, "").split("/").pop())
    assert.equal(new Set(srcNames).size, DISPLAYS.length,
        `duplicate source images assigned to displays: ${srcNames.join(", ")}`)
    console.log(`  ✓ all ${DISPLAYS.length} displays received distinct source images (gemini strategy)` )

    if (ncnnAvailable) {
        // Upscale intermediates must have been cleaned up from the temp dir
        const leftovers = fs.existsSync(tmpDir)
            ? fs.readdirSync(tmpDir).filter((f) => f.includes("-upscale")) : []
        assert.equal(leftovers.length, 0, `uncleaned upscale intermediates: ${leftovers.join(", ")}`)
        console.log("  ✓ NCNN upscale intermediates cleaned up")
    }

    await db.close()
    console.log("\n[generatePipeline] All assertions passed")
} catch (err) {
    failures++
    console.error(`\n[generatePipeline] FAILED — ${err.message}`)
    if (process.env.DEBUG_TESTS) {
        console.error("--- captured log ---")
        messages.slice(-60).forEach((m) => console.error("  " + m))
    }
} finally {
    fs.rmSync(workDir, { recursive: true, force: true })
}

process.exit(failures > 0 ? 1 : 0)