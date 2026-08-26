#!/usr/bin/env node
/**
 * Cross-Orientation Scored Fallback Test
 *
 * Verifies that when an orientation pool cannot cover its slots, strategies continue
 * their OWN ranking logic across all orientations ("any") instead of dropping straight
 * to uniform random. Random remains only as last resort.
 *
 * Cases are built so exactly ONE candidate is scoreable after exclusions, making the
 * expected winner deterministic regardless of internal shuffles/ordering.
 * Uses a real DatabaseService backed by a throwaway SQLite file plus fake image rows.
 * Exit codes: 0 = pass, 1 = fail.
 *
 * Usage:
 *   node tests/crossOrientation.test.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import DatabaseService from "../src/services/databaseService.js"
import EntropySelector from "../src/lib/selectors/entropySelector.js"
import GeminiQwenSelector from "../src/lib/selectors/geminiSelector.js"
import ImageSelector from "../src/lib/imageSelector.js"

// Quiet logger stub (collects messages for diagnostics + [CROSS] marker assertions)
const messages = []
const quietLogger = {
    log: (...a) => messages.push(a.join(" ")),
    debug: () => {},
    info: (...a) => messages.push(a.join(" ")),
    warn: (...a) => messages.push(`WARN ${a.join(" ")}`),
    error: (...a) => messages.push(`ERROR ${a.join(" ")}`),
}

function makeConfig(overrides = {}) {
    return { settings: { contrastInitialTolerance: 1, contrastMaxTolerance: 1000, ...overrides } }
}

let failures = 0
async function runCase(name, fn) {
    try {
        await fn()
        console.log(`  ✓ ${name}`)
    } catch (err) {
        failures++
        console.error(`  ✗ ${name}`)
        console.error(`    ${err.message}`)
    }
}

/** Force Math.random() === 0 so seed selection deterministically takes the first valid row in DB order. */
function withForcedSeed(fn) {
    const orig = Math.random
    Math.random = () => 0
    try {
        return fn()
    } finally {
        Math.random = orig
    }
}

/** Assert that one selection entry is a well-formed `{image, orientation}` record. */
function assertValidEntry(entry, label) {
    assert.ok(entry && typeof entry === "object", `${label}: entry must be an object`)
    assert.equal(typeof entry.orientation, "string", `${label}: orientation missing`)
    const img = entry.image
    assert.ok(img && typeof img === "object", `${label}: image missing`)
    assert.equal(typeof img.path, "string", `${label}: image.path not a string`)
    assert.ok(Number.isFinite(img.id), `${label}: image.id not finite`)
    assert.ok(Number.isFinite(img.width) && img.width > 0, `${label}: image.width invalid`)
    assert.ok(Number.isFinite(img.height) && img.height > 0, `${label}: image.height invalid`)
    assert.equal(img.image, undefined, `${label}: double-wrapped {image:{...}} detected -- regression!`)
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallpaperinho-test-"))
const dbPath = path.join(workDir, "images.sqlite3")

try {
    const db = new DatabaseService(dbPath, quietLogger)
    await db.initialize()

    // ------------------------------------------------------------------
    // Case A -- EntropySelector: horizontal row exists but has no entropy data.
    // The cross-orientation scored pick (ORDER BY ABS distance) must return the
    // single remaining scoreable vertical exactly.
    // ------------------------------------------------------------------
    await runCase("entropy strategy scores across orientations instead of random fallback", async () => {
        messages.length = 0
        await db.insertImage({ path: "/fake/a-v1.jpg", width: 800, height: 1200, filesize: 100, entropy: 5 })
        await db.insertImage({ path: "/fake/a-v2.jpg", width: 900, height: 1400, filesize: 100, entropy: 9 })
        await db.insertImage({ path: "/fake/a-h1.jpg", width: 2560, height: 1600, filesize: 100 /* no entropy */ })
        try {
            const selector = new EntropySelector(db, makeConfig(), quietLogger)
            const pickPromise = withForcedSeed(() => selector.select({ vertical: 1, horizontal: 1, square: 0 }))
            const picked = await pickPromise

            const expectedSeedPath = db.findAllVerticalSync().find((r) => r.entropy != null).path
            const winnerPath = ["/fake/a-v1.jpg", "/fake/a-v2.jpg"].find((p) => p !== expectedSeedPath)

            assert.equal(picked.length, 2, `expected 2 selections, got ${picked.length}`)
            for (const entry of picked) assertValidEntry(entry, "case A")
            const paths = picked.map((e) => e.image.path)
            assert.equal(new Set(paths).size, 2, `duplicate selection detected: ${paths.join(", ")}`)

            const hEntry = picked.find((e) => e.orientation === "horizontal")
            assert.ok(hEntry, "no horizontal-tagged entry produced")
            assert.equal(hEntry.image.path, winnerPath,
                `cross-orientation scored pick must return the only scoreable candidate (${winnerPath})`)
            assert.ok(messages.some((m) => m.includes("[CROSS]")), "expected a [CROSS] log marker proving scored path ran")
        } finally {
            await db.removeImage("/fake/a-v1.jpg")
            await db.removeImage("/fake/a-v2.jpg")
            await db.removeImage("/fake/a-h1.jpg")
        }
    })

    // ------------------------------------------------------------------
    // Case B -- GeminiQwenSelector: portrait-only catalog, one row lacks gemini data.
    // Exactly one valid cross-candidate remains -> pairwise harmony must return it exactly.
    // ------------------------------------------------------------------
    await runCase("gemini strategy harmony-scores across orientations instead of random fallback", async () => {
        messages.length = 0
        const fullMetrics = { hue: 205, saturation: 32, lightness: 47, contrast: 41, canny: 8, entropy: 5.2 }
        await db.insertImage({ path: "/fake/b-v1.jpg", width: 800, height: 1200, filesize: 100, ...fullMetrics })
        await db.insertImage({ path: "/fake/b-v2.jpg", width: 900, height: 1400, filesize: 100, ...fullMetrics })
        await db.insertImage({ path: "/fake/b-v3.jpg", width: 700, height: 1100, filesize: 100, ...fullMetrics, entropy: null })
        try {
            const selector = new GeminiQwenSelector(db, makeConfig(), quietLogger)
            const pickPromise = withForcedSeed(() => selector.select({ vertical: 1, horizontal: 1, square: 0 }))
            const picked = await pickPromise

            // Seed is the first gemini-valid row in DB order; winner must be the other valid one
            const expectedSeedPath = ["/fake/b-v1.jpg", "/fake/b-v2.jpg"].find(
                (p) => p === db.findAllVerticalSync().find((r) => r.entropy != null).path
            )
            const winnerPath = ["/fake/b-v1.jpg", "/fake/b-v2.jpg"].find((p) => p !== expectedSeedPath)

            assert.equal(picked.length, 2, `expected 2 selections, got ${picked.length}`)
            for (const entry of picked) assertValidEntry(entry, "case B")
            const paths = picked.map((e) => e.image.path)
            assert.equal(new Set(paths).size, 2, `duplicate selection detected: ${paths.join(", ")}`)

            const hEntry = picked.find((e) => e.orientation === "horizontal")
            assert.ok(hEntry, "no horizontal-tagged entry produced")
            assert.equal(hEntry.image.path, winnerPath,
                `harmony cross-pick must return the only scoreable candidate (${winnerPath})`)
            assert.ok(messages.some((m) => m.includes("[CROSS]")), "expected a [CROSS] log marker proving scored path ran")
        } finally {
            await db.removeImage("/fake/b-v1.jpg")
            await db.removeImage("/fake/b-v2.jpg")
            await db.removeImage("/fake/b-v3.jpg")
        }
    })

    // ------------------------------------------------------------------
    // Case C -- Chain ["contrast","entropy"] through ImageSelector on a portrait-only catalog.
    // v3 has entropy data but NO contrast data: invisible to chain scoring yet visible to
    // plain random fallback. The scored cross-path must therefore never return v3.
    // ------------------------------------------------------------------
    await runCase("chain mode re-runs its steps across orientations (decoy row loses)", async () => {
        messages.length = 0
        await db.insertImage({ path: "/fake/c-v1.jpg", width: 800, height: 1200, filesize: 100, contrast: 50, entropy: 5 })
        await db.insertImage({ path: "/fake/c-v2.jpg", width: 900, height: 1400, filesize: 100, contrast: 50, entropy: 6 })
        await db.insertImage({ path: "/fake/c-v3.jpg", width: 700, height: 1100, filesize: 100 /* no contrast */, entropy: 40 })
        try {
            const router = new ImageSelector(db, makeConfig({ imageMatchingStrategy: ["contrast", "entropy"] }), null, quietLogger)
            const pickPromise = withForcedSeed(() => router.select({ vertical: 1, horizontal: 1, square: 0 }))
            const picked = await pickPromise

            // Chain seed candidates are the contrast-valid rows; forced seed is the first in DB order
            const expectedSeedPath = ["/fake/c-v1.jpg", "/fake/c-v2.jpg"].find(
                (p) => p === db.findAllVerticalSync().find((r) => r.contrast != null).path
            )
            const winnerPath = ["/fake/c-v1.jpg", "/fake/c-v2.jpg"].find((p) => p !== expectedSeedPath)

            assert.equal(picked.length, 2, `expected 2 selections, got ${picked.length}`)
            for (const entry of picked) assertValidEntry(entry, "case C")
            const paths = picked.map((e) => e.image.path)
            assert.equal(new Set(paths).size, 2, `duplicate selection detected: ${paths.join(", ")}`)

            const hEntry = picked.find((e) => e.orientation === "horizontal")
            assert.ok(hEntry, "no horizontal-tagged entry produced")
            assert.notEqual(hEntry.image.path, "/fake/c-v3.jpg",
                "decoy row (contrast-less) must not be reachable via chain scoring -- random fallback leaked?")
            assert.equal(hEntry.image.path, winnerPath,
                `chain cross-pick must return the contrast+entropy scoreable candidate (${winnerPath})`)
            assert.ok(messages.some((m) => m.includes("[CROSS]")), "expected a [CROSS]/[CHAIN][CROSS] log marker proving scored path ran")
        } finally {
            await db.removeImage("/fake/c-v1.jpg")
            await db.removeImage("/fake/c-v2.jpg")
            await db.removeImage("/fake/c-v3.jpg")
        }
    })

    await db.close()
} catch (err) {
    failures++
    console.error(`  ✗ unexpected error: ${err.stack || err.message}`)
} finally {
    fs.rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
    console.error(`\n[crossOrientation] FAILED - ${failures} case(s)`)
    if (process.env.DEBUG_TESTS) {
        console.error("\n--- captured log ---")
        messages.slice(-60).forEach((m) => console.error("  " + m))
    }
    process.exit(1)
}

console.log("\n[crossOrientation] All cases passed")