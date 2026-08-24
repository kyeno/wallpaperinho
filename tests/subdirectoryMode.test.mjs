#!/usr/bin/env node
/**
 * Subdirectory Driving Modes (imageSubdirectoryMode) Test
 *
 * Covers src/lib/poolScope.js resolution rules plus their application through
 * DatabaseService selection queries, RandomSelector fallbacks and strategy SQL builders:
 *   - include / flat / subdirsOnly pool shapes across multiple roots
 *   - exclusiveFlat vs exclusiveDeep random pick semantics (deterministic via injected rng)
 *   - LIKE metacharacter escaping (_ , spaces) in root/subdir names
 *   - fallback-to-include when no eligible subdirectories exist
 *   - invalid mode values failing fast with a helpful message
 *
 * Uses a real DatabaseService backed by a throwaway SQLite file plus fake image rows --
 * no ImageMagick or NCNN required.
 *
 * Exit codes: 0 = pass, 1 = fail.
 *
 * Usage:
 *   node tests/subdirectoryMode.test.mjs
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import DatabaseService from "../src/services/databaseService.js"
import { resolvePoolScope } from "../src/lib/poolScope.js"
import RandomSelector from "../src/lib/selectors/randomSelector.js"
import EntropySelector from "../src/lib/selectors/entropySelector.js"

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

/** Union of all orientation pools as sorted paths -- the effective selection pool. */
function allPoolPaths(d) {
    return [...d.findAllVerticalSync(), ...d.findAllHorizontalSync(), ...d.findAllSquareSync()]
        .map((r) => r.path).sort()
}

// --- Fake library tree ------------------------------------------------------
// rootA has a SPACE in its name; rootB an UNDERSCORE -- both are LIKE metacharacter
// traps that must be escaped when building path predicates.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wallpaperinho-test-"))
const rootA = path.join(workDir, "library A")
const rootB = path.join(workDir, "library_B")
const emptyRoot = path.join(workDir, "flat_lib")   // no subdirectories at all
fs.mkdirSync(path.join(rootA, "alpha", "nested"), { recursive: true })
fs.mkdirSync(path.join(rootA, "beta"), { recursive: true })
fs.mkdirSync(path.join(rootA, "gamma"), { recursive: true })   // excluded via config below
fs.mkdirSync(path.join(rootB, "under_score"), { recursive: true })
fs.mkdirSync(path.join(rootB, "undrZscore"), { recursive: true })  // would match unescaped `_`
fs.mkdirSync(emptyRoot, { recursive: true })

const rows = [
    { path: `${rootA}/top.jpg`,             width: 2560, height: 1600, entropy: 4.1 },
    { path: `${rootA}/alpha/a1.jpg`,        width: 1080, height: 1920, entropy: 4.7 },
    { path: `${rootA}/alpha/nested/n1.jpg`, width: 1080, height: 1920, entropy: 5.3 },
    { path: `${rootA}/beta/b1.jpg`,         width: 2560, height: 1440, entropy: 5.9 },
    { path: `${rootB}/loose.jpg`,           width: 2560, height: 1440, entropy: 6.2 },
    { path: `${rootB}/under_score/u1.jpg`,  width: 1080, height: 1920, entropy: 6.8 },
    { path: `${rootB}/undrZscore/z1.jpg`,   width: 1080, height: 1920, entropy: 7.3 },
]

const ALL = rows.map((r) => r.path).sort()
const TOP_LEVEL = [`${rootA}/top.jpg`, `${rootB}/loose.jpg`].sort()
const SUBDIR_ROWS = ALL.filter((p) => !TOP_LEVEL.includes(p))

/** Resolve a mode and apply it to the shared DB (no-op scope for "include"). */
function applyMode(mode, { roots = [rootA, rootB], exclusions = ["gamma"], rng } = {}) {
    const scope = resolvePoolScope(
        { imageDirectories: roots, imageSubdirectoryMode: mode, imageDirectoryExclusions: exclusions },
        { logger: quietLogger, rng }
    )
    db.setScope(scope.condition ? { condition: scope.condition, params: scope.params } : null)
    return scope
}

let db
try {
    db = new DatabaseService(path.join(workDir, "images.sqlite3"), quietLogger)
    await db.initialize()
    for (const r of rows) await db.insertImage({ ...r, filesize: 1234 })

    // Case 1 -- include (default): unrestricted pool
    await runCase("include leaves the whole catalog visible", async () => {
        const scope = applyMode("include")
        assert.equal(scope.effectiveMode, "include")
        assert.equal(scope.condition, "")
        assert.deepEqual(allPoolPaths(db), ALL)
    })

    // Case 2 -- flat: only files directly inside a root (both roots; space in name OK)
    await runCase("flat keeps only loose top-level files from every root", async () => {
        applyMode("flat")
        assert.deepEqual(allPoolPaths(db), TOP_LEVEL)
    })

    // Case 3 -- subdirsOnly: everything below roots, no top-level files
    await runCase("subdirsOnly drops loose root-level files, keeps all nested rows", async () => {
        applyMode("subdirsOnly")
        assert.deepEqual(allPoolPaths(db), SUBDIR_ROWS)
    })

    // Case 4 -- exclusiveFlat rng=0 -> first sorted candidate (rootA/alpha); own files only
    await runCase("exclusiveFlat picks one subdir and uses ONLY its direct files", async () => {
        const scope = applyMode("exclusiveFlat", { rng: () => 0 })
        assert.equal(scope.chosenDir, path.join(rootA, "alpha"))
        assert.deepEqual(allPoolPaths(db), [`${rootA}/alpha/a1.jpg`])   // n1 is deeper -> out of pool
    })

    // Case 5 -- exclusiveDeep with the same pick -> whole subtree of the chosen child
    await runCase("exclusiveDeep keeps the entire subtree of the picked subdir", async () => {
        applyMode("exclusiveDeep", { rng: () => 0 })
        assert.deepEqual(
            allPoolPaths(db),
            [`${rootA}/alpha/a1.jpg`, `${rootA}/alpha/nested/n1.jpg`].sort()
        )
    })

    // Case 6 -- LIKE escaping regression: `_` in under_score must NOT match undrZscore
    await runCase("underscore in dir names is escaped (no cross-match with sibling)", async () => {
        const scope = applyMode("exclusiveDeep", { roots: [rootB], rng: () => 0 })
        assert.equal(scope.chosenDir, path.join(rootB, "under_score"))
        assert.deepEqual(allPoolPaths(db), [`${rootB}/under_score/u1.jpg`])
    })

    // Case 7 -- fallback when no eligible subdirectories exist anywhere
    await runCase("subdir-dependent modes fall back to include when nothing qualifies", async () => {
        for (const mode of ["exclusiveFlat", "exclusiveDeep", "subdirsOnly"]) {
            const before = messages.length
            const scope = applyMode(mode, { roots: [emptyRoot] })
            assert.equal(scope.effectiveMode, "include", `${mode} should have fallen back`)
            assert.equal(scope.condition, "", `${mode}: condition must be empty after fallback`)
            assert.ok(
                messages.slice(before).some((m) => m.includes("falling back")),
                `${mode}: expected a fallback warning in logs`
            )
        }
        db.setScope(null)   // cleared by the last no-op setScope; full catalog visible again
        assert.deepEqual(allPoolPaths(db), ALL)
    })

    // Case 8 -- invalid modes fail fast with a helpful message
    await runCase("invalid imageSubdirectoryMode values throw listing valid ones", async () => {
        for (const bad of ["recursive", "EXCLUSIVE", 42]) {
            assert.throws(
                () => resolvePoolScope(
                    { imageDirectories: [rootA], imageSubdirectoryMode: bad },
                    { logger: quietLogger }
                ),
                /Valid values: include, flat, subdirsOnly, exclusiveFlat, exclusiveDeep/
            )
        }
    })

    // Case 9 -- random-fallback SQL + availability counts honor scope
    await runCase("findRandomByOrientation results AND totalAvailable respect scope", async () => {
        applyMode("flat")
        const scoped = db.findRandomByOrientation("horizontal", [], 10)
        assert.equal(scoped.totalAvailable, 2, "only top-level horizontals exist in flat mode")
        for (const r of scoped.results) assert.ok(TOP_LEVEL.includes(r.path))

        db.setScope(null)
        const unscoped = db.findRandomByOrientation("horizontal", [], 10)
        assert.equal(unscoped.totalAvailable, 3, "full catalog has three horizontals")
    })

    // Case 10 -- RandomSelector end-to-end stays inside an exclusive pool
    await runCase("RandomSelector picks only from the exclusive-deep pool", async () => {
        applyMode("exclusiveDeep", { rng: () => 0 })   // rootA/alpha -> a1,n1 (both vertical)
        const selector = new RandomSelector(db, { settings: {} }, quietLogger)
        const picked = selector.selectSync({ vertical: 2, horizontal: 0, square: 0 })
        assert.deepEqual(
            picked.map((e) => e.image.path).sort(),
            [`${rootA}/alpha/a1.jpg`, `${rootA}/alpha/nested/n1.jpg`].sort()
        )
    })

    // Case 11 -- strategy SQL builders carry the scope clause through raw execute()
    await runCase("strategy builder SQL applies scope via buildScopeFilterClause", async () => {
        applyMode("subdirsOnly")
        const sel = new EntropySelector(db, { settings: {} }, quietLogger)
        const { sql, params } = sel.buildOrderByDistanceQuery(5.0, "vertical", [], 10)
        const results = db.execute(sql, params).map((r) => r.path).sort()
        const expected = [
            `${rootA}/alpha/a1.jpg`, `${rootA}/alpha/nested/n1.jpg`,
            `${rootB}/under_score/u1.jpg`, `${rootB}/undrZscore/z1.jpg`,
        ].sort()
        assert.deepEqual(results, expected, "builder query must be restricted to scoped verticals")
    })
} catch (err) {
    failures++
    console.error(`  ✗ unexpected error: ${err.stack || err.message}`)
} finally {
    try { if (db) await db.close() } catch { /* already closed */ }
    fs.rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
    console.error(`\n[subdirectoryMode] FAILED — ${failures} case(s)`)
    if (process.env.DEBUG_TESTS) {
        console.error("\n--- captured log ---")
        messages.slice(-40).forEach((m) => console.error("  " + m))
    }
    process.exit(1)
}

console.log("\n[subdirectoryMode] All cases passed")