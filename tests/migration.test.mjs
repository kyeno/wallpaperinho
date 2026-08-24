#!/usr/bin/env node
/**
 * Database Migration Regression Test (TODO known issue #1)
 *
 * The old migration pattern only backfilled `canny` and `palette`, so databases created
 * before earlier metric columns existed were never upgraded ("only works on fresh DB").
 * These cases prove initialize() now inspects the actual schema via PRAGMA table_info and
 * adds exactly the missing columns -- preserving existing row data -- plus that the
 * DatabaseService API is fully synchronous (known issue #2).
 *
 * Uses throwaway SQLite files; no ImageMagick or NCNN required.
 *
 * Exit codes: 0 = pass, 1 = fail.
 *
 * Usage:
 *   node tests/migration.test.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import DatabaseService from "../src/services/databaseService.js"

// Quiet logger stub (collects messages for diagnostics on failure)
const messages = []
const quietLogger = {
    log: (...a) => messages.push(a.join(" ")),
    debug: () => {},
    info: (...a) => messages.push(a.join(" ")),
    warn: (...a) => messages.push(`WARN ${a.join(" ")}`),
    error: (...a) => messages.push(`ERROR ${a.join(" ")}`),
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

/** Create a database file with the given CREATE TABLE statement and one legacy row. */
function createLegacyDb(dbPath, extraColumnsSql = "") {
    const raw = new DatabaseSync(dbPath)
    raw.exec(
        `CREATE TABLE images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            filesize INTEGER NOT NULL${extraColumnsSql}
         )`
    )
    raw.prepare("INSERT INTO images (path, width, height, filesize) VALUES (?, ?, ?, ?)").run("/old/img.jpg", 1920, 1080, 4242)
    raw.close()
}

const FULL_COLUMNS = ["id", "path", "width", "height", "filesize", "hue", "saturation", "lightness", "contrast", "entropy", "canny", "palette"]

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallpaperinho-migration-"))

try {
    // Case 1 -- pre-metrics schema: every metric column must be backfilled, data preserved
    await runCase("pre-metrics DB gains all missing columns with existing rows intact", async () => {
        const dbPath = path.join(workDir, "legacy-pre-metrics.sqlite3")
        createLegacyDb(dbPath)

        const db = new DatabaseService(dbPath, quietLogger)
        db.initialize()

        const cols = db.execute("PRAGMA table_info(images)").map((c) => c.name)
        for (const name of FULL_COLUMNS) assert.ok(cols.includes(name), `missing expected column: ${name}`)

        const row = db.executeOne("SELECT * FROM images WHERE path = ?", ["/old/img.jpg"])
        assert.ok(row, "legacy row disappeared during migration")
        assert.equal(row.width, 1920, "legacy width changed")
        assert.equal(row.height, 1080, "legacy height changed")
        assert.equal(row.filesize, 4242, "legacy filesize changed")
        for (const m of ["hue", "saturation", "lightness", "contrast", "entropy", "canny", "palette"]) {
            assert.equal(row[m], null, `${m} should default to NULL on migrated rows`)
        }

        // Migrated DB must be fully usable end-to-end
        db.insertImage({ path: "/new/full.jpg", width: 800, height: 1200, filesize: 7, hue: 205, saturation: 32, lightness: 47, contrast: 41, entropy: 5.2, canny: 8, palette: "#aabbcc" })
        const fresh = db.executeOne("SELECT * FROM images WHERE path = ?", ["/new/full.jpg"])
        assert.equal(fresh.hue, 205)
        assert.equal(fresh.palette, "#aabbcc")
        db.close()
    })

    // Case 2 -- mid-generation schema (only `palette` missing): exactly that column is added
    await runCase("mid-generation DB gains only the columns it lacks", async () => {
        const dbPath = path.join(workDir, "legacy-mid.sqlite3")
        createLegacyDb(dbPath, ",\n            hue INTEGER,\n            saturation INTEGER,\n            lightness INTEGER,\n            contrast INTEGER,\n            entropy REAL,\n            canny INTEGER")

        const before = new DatabaseSync(dbPath).prepare("PRAGMA table_info(images)").all().map((c) => c.name)
        for (const name of ["hue", "saturation", "lightness", "contrast", "entropy", "canny"]) assert.ok(before.includes(name), `fixture should already have ${name}`)
        assert.ok(!before.includes("palette"), "fixture must be missing palette")

        const db = new DatabaseService(dbPath, quietLogger)
        db.initialize()
        const after = db.execute("PRAGMA table_info(images)").map((c) => c.name)
        assert.deepEqual(after.sort(), [...FULL_COLUMNS].sort(), "final schema must match the full column set")
        db.close()
    })

    // Case 3 -- fresh database still initializes to the complete schema (no regression from #1 fix)
    await runCase("fresh DB still gets the complete schema on first initialize", async () => {
        const dbPath = path.join(workDir, "fresh.sqlite3")
        const db = new DatabaseService(dbPath, quietLogger)
        db.initialize()
        const cols = db.execute("PRAGMA table_info(images)").map((c) => c.name)
        assert.deepEqual(cols.sort(), [...FULL_COLUMNS].sort())
        assert.equal(db.isEmpty(), true, "fresh catalog should report empty")
        db.close()
    })

    // Case 4 -- known issue #2: service methods are synchronous, not Promise wrappers
    await runCase("DatabaseService methods return plain values, never Promises", async () => {
        const dbPath = path.join(workDir, "sync-api.sqlite3")
        const db = new DatabaseService(dbPath, quietLogger)
        const results = [
            db.initialize(),
            db.insertImage({ path: "/s/x.jpg", width: 100, height: 100, filesize: 1 }),
            db.queryImages({ minWidth: 50 }),
            db.findAllVertical(),
            db.findRandom(),
            db.removeImage("/s/x.jpg"),
            db.close(),
        ]
        // NOTE: node:sqlite returns PROTOTYPELESS row objects -- String()/template interpolation
        // of them throws "Cannot convert object to primitive value", so never stringify raw rows here.
        for (const r of results) {
            assert.ok(r === undefined || typeof r.then !== "function", `expected non-Promise result from sync API (got type ${typeof r})`)
        }
        // And the awaited form used across the codebase still works on sync returns
        const db2 = new DatabaseService(path.join(workDir, "sync-api-2.sqlite3"), quietLogger)
        await db2.initialize()
        await db2.insertImage({ path: "/s/y.jpg", width: 100, height: 200, filesize: 1 })
        assert.equal((await db2.findAllVertical()).length, 1)
        await db2.close()
    })

    console.log("")
    if (failures > 0) {
        console.error(`[migration] ${failures} case(s) FAILED`)
        process.exitCode = 1
    } else {
        console.log("[migration] All cases passed")
    }
} finally {
    fs.rmSync(workDir, { recursive: true, force: true })
}