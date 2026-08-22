#!/usr/bin/env node
/**
 * RandomSelector Cross-Orientation Fallback Regression Test
 *
 * Reproduces the "vertical-only catalog + horizontal slot" scenario that used to leak
 * double-wrapped `{image: <row>}` objects out of #fallbackAcrossOrientations(), causing
 * `undefined` dimensions/paths downstream and a hard failure during ncnn/ImageMagick work.
 *
 * Uses a real DatabaseService backed by a throwaway SQLite file plus fake image rows --
 * no ImageMagick or NCNN required.
 *
 * Exit codes: 0 = pass, 1 = fail.
 *
 * Usage:
 *   node tests/randomFallback.test.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import DatabaseService from "../src/services/databaseService.js"
import RandomSelector from "../src/lib/selectors/randomSelector.js"

// Quiet logger stub (collects messages for diagnostics on failure)
const messages = []
const quietLogger = {
    log: (...a) => messages.push(a.join(" ")),
    debug: () => {},
    info: (...a) => messages.push(a.join(" ")),
    warn: (...a) => messages.push(`WARN ${a.join(" ")}`),
    error: (...a) => messages.push(`ERROR ${a.join(" ")}`),
}

const configStub = { settings: {} }

/** Assert that one selection entry is a well-formed `{image, orientation}` record. */
function assertValidEntry(entry, label) {
    assert.ok(entry && typeof entry === "object", `${label}: entry must be an object`)
    assert.equal(typeof entry.orientation, "string", `${label}: orientation missing`)
    const img = entry.image
    assert.ok(img && typeof img === "object", `${label}: image missing`)
    assert.equal(typeof img.path, "string", `${label}: image.path not a string (got ${typeof img.path})`)
    assert.ok(Number.isFinite(img.id), `${label}: image.id not finite`)
    assert.ok(Number.isFinite(img.width) && img.width > 0, `${label}: image.width invalid`)
    assert.ok(Number.isFinite(img.height) && img.height > 0, `${label}: image.height invalid`)
    // The classic bug signature: a nested wrapper instead of the raw DB row
    assert.equal(img.image, undefined, `${label}: double-wrapped {image:{...}} detected -- regression!`)
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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallpaperinho-test-"))
const dbPath = path.join(workDir, "images.sqlite3")

try {
    const db = new DatabaseService(dbPath, quietLogger)
    await db.initialize()

    const verticals = [
        { path: "/fake/v1.jpg", width: 1024, height: 1536 },
        { path: "/fake/v2.jpg", width: 768, height: 1365 },
        { path: "/fake/v3.jpg", width: 900, height: 1600 },
    ]
    for (const v of verticals) {
        await db.insertImage({ ...v, filesize: 1234 })
    }

    // Case A -- the exact regression scenario: all-vertical catalog, one horizontal slot.
    // Before the fix this produced `{image:{image:<row>}}` entries with undefined dims.
    await runCase("all-vertical catalog fills a horizontal slot with valid records", async () => {
        const selector = new RandomSelector(db, configStub, quietLogger)
        const picked = selector.selectSync({ vertical: 0, horizontal: 1, square: 0 })
        assert.equal(picked.length, 1, `expected 1 selection, got ${picked.length}`)
        assertValidEntry(picked[0], "horizontal fallback")
        assert.ok(verticals.some((v) => v.path === picked[0].image.path),
            "fallback image should come from the existing catalog")
    })

    // Case B -- mixed catalog, matched-orientation pool still returns raw rows.
    await runCase("mixed catalog picks directly from the matching pool", async () => {
        await db.insertImage({ path: "/fake/h1.jpg", width: 2560, height: 1600, filesize: 999 })
        try {
            const selector = new RandomSelector(db, configStub, quietLogger)
            const picked = selector.selectSync({ vertical: 0, horizontal: 1, square: 0 })
            assert.equal(picked.length, 1)
            assertValidEntry(picked[0], "matched horizontal")
            assert.equal(picked[0].image.path, "/fake/h1.jpg", "should pick from the horizontal pool first")
        } finally {
            await db.removeImage("/fake/h1.jpg")
        }
    })

    // Case C -- request more images than exist in ANY orientation: forces both fallback
    // branches (cross-orientation + duplicate fill) and checks every entry stays well-formed.
    await runCase("over-requested counts keep all entries valid (dup-fill branch)", async () => {
        const selector = new RandomSelector(db, configStub, quietLogger)
        const picked = selector.selectSync({ vertical: 5, horizontal: 0, square: 0 })
        assert.ok(picked.length >= 3, `expected at least 3 selections, got ${picked.length}`)
        for (const [i, entry] of picked.entries()) {
            assertValidEntry(entry, `vertical[${i}]`)
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
    console.error(`\n[randomFallback] FAILED — ${failures} case(s)`)
    if (process.env.DEBUG_TESTS) {
        console.error("\n--- captured log ---")
        messages.slice(-40).forEach((m) => console.error("  " + m))
    }
    process.exit(1)
}

console.log("\n[randomFallback] All cases passed")