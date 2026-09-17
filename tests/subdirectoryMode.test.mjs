#!/usr/bin/env node
/**
 * Subdirectory Driving Modes (imageSubdirectoryMode) Test
 *
 * Covers src/lib/poolScope.js resolution rules plus their application through
 * DatabaseService selection queries, RandomSelector fallbacks and strategy SQL builders:
 *   - include / flat / subdirsOnly pool shapes across multiple roots
 *   - exclusiveFlat vs exclusiveDeep random pick semantics (deterministic via injected rng)
 *   - LIKE metacharacter escaping (_ , spaces) in root/subdir names
 *   - viability gate: pools below requiredCount raise InsufficientPoolError; thin exclusive candidates are skipped
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
import { resolvePoolScope, InsufficientPoolError } from "../src/lib/poolScope.js"
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

// --- Viability-gate fixtures -- real files on disk because the gate counts off-disk ------
// a_small(1) < b_mid(2) < z_big(4 flat + 1 nested): sort order matters for rng=0 assertions.
// skip_me holds extra images that must be pruned whenever it is listed in exclusions.
const libC = path.join(workDir, "lib C")
for (const dir of ["a_small", "b_mid", "z_big/nested", "skip_me"]) fs.mkdirSync(path.join(libC, dir), { recursive: true })
fs.writeFileSync(path.join(libC, "a_small", "s.jpg"), "x")
fs.writeFileSync(path.join(libC, "b_mid", "m1.jpg"), "x")
fs.writeFileSync(path.join(libC, "b_mid", "m2.png"), "x")
for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(libC, "z_big", `z${i}.jpg`), "x")
fs.writeFileSync(path.join(libC, "z_big", "nested", "deep.webp"), "y")   // exclusiveDeep pool only
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(libC, "skip_me", `q${i}.jpg`), "x")
fs.writeFileSync(path.join(libC, "loose_a.jpg"), "z")                    // flat/include pools only
fs.writeFileSync(path.join(libC, "loose_b.jpeg"), "z")                   // flat/include pools only

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

    // Case 7 -- structural failure: subdir-dependent modes with NO eligible subdirs throw
    // (hard fail instead of silently widening to "include" and mixing loose root files in)
    await runCase("subdir-dependent modes raise InsufficientPoolError when nothing qualifies", async () => {
        db.setScope(null)   // clear case-6 scope first; the throws below never reach setScope
        for (const mode of ["exclusiveFlat", "exclusiveDeep", "subdirsOnly"]) {
            assert.throws(
                () => resolvePoolScope(
                    { imageDirectories: [emptyRoot], imageSubdirectoryMode: mode },
                    { logger: quietLogger }
                ),
                (err) => err instanceof InsufficientPoolError && /no eligible subdirector/i.test(err.message),
                `${mode}: expected an InsufficientPoolError naming the missing subdirectories`
            )
        }
        assert.deepEqual(allPoolPaths(db), ALL, "full catalog must remain visible after the throws")
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

    // Case 12 -- viability gate: exclusiveFlat skips thin subdirs instead of picking them
    await runCase("exclusiveFlat skips subdirectories below requiredCount and picks a viable one", async () => {
        const scope = resolvePoolScope(
            { imageDirectories: [libC], imageSubdirectoryMode: "exclusiveFlat", imageDirectoryExclusions: ["skip_me"] },
            { rng: () => 0, requiredCount: 3 }
        )
        assert.equal(scope.chosenDir, path.join(libC, "z_big"), "first VIABLE candidate wins, not first overall")
        assert.deepEqual(
            scope.skippedThin.map((t) => `${path.basename(t.dir)}(${t.count})`),
            ["a_small(1)", "b_mid(2)"],
            "thin candidates must be reported with their counts"
        )
    })

    // Case 13 -- lower minimum admits more folders; the pick index applies to the filtered list
    await runCase("requiredCount=2 admits b_mid as the new first viable candidate", async () => {
        const scope = resolvePoolScope(
            { imageDirectories: [libC], imageSubdirectoryMode: "exclusiveFlat", imageDirectoryExclusions: ["skip_me"] },
            { rng: () => 0, requiredCount: 2 }
        )
        assert.equal(scope.chosenDir, path.join(libC, "b_mid"))
        assert.deepEqual(scope.skippedThin.map((t) => path.basename(t.dir)), ["a_small"])
    })

    // Case 14 -- every candidate below the minimum -> typed error carrying all attempted counts
    await runCase("all-thin exclusive pool raises InsufficientPoolError listing each count", async () => {
        let err
        try {
            resolvePoolScope(
                { imageDirectories: [libC], imageSubdirectoryMode: "exclusiveFlat", imageDirectoryExclusions: ["skip_me"] },
                { requiredCount: 9 }
            )
            throw new Error("expected InsufficientPoolError")
        } catch (e) { err = e }
        assert.ok(err instanceof InsufficientPoolError, `got ${err.name}: ${err.message}`)
        assert.deepEqual(
            err.attempted.map((t) => `${path.basename(t.dir)}(${t.count})`),
            ["a_small(1)", "b_mid(2)", "z_big(4)"],
            "attempted list must carry per-directory counts"
        )
        assert.match(err.message, /need at least 9 distinct image\(s\)/)
        assert.match(err.message, /a_small\(1\), b_mid\(2\), z_big\(4\)/)
    })

    // Case 15 -- exclusiveDeep counts the whole subtree; flat does not
    await runCase("exclusiveDeep viability uses recursive counts (nested files included)", async () => {
        const deepOk = resolvePoolScope(
            { imageDirectories: [libC], imageSubdirectoryMode: "exclusiveDeep", imageDirectoryExclusions: ["skip_me"] },
            { rng: () => 0, requiredCount: 5 }   // only z_big reaches 5 (4 flat + 1 nested)
        )
        assert.equal(deepOk.chosenDir, path.join(libC, "z_big"))
        assert.ok(!deepOk.condition.includes("NOT LIKE"), "deep pool condition shape unchanged")

        let err
        try {
            resolvePoolScope(
                { imageDirectories: [libC], imageSubdirectoryMode: "exclusiveFlat", imageDirectoryExclusions: ["skip_me"] },
                { requiredCount: 5 }             // same minimum, but flat sees only 4 in z_big
            )
            throw new Error("expected InsufficientPoolError")
        } catch (e) { err = e }
        assert.ok(err instanceof InsufficientPoolError, `got ${err.name}: ${err.message}`)
    })

    // Case 16 -- flat mode gates on loose root-level files only
    await runCase("flat total-count gate counts direct files across roots", async () => {
        let err
        try {
            resolvePoolScope({ imageDirectories: [libC], imageSubdirectoryMode: "flat" }, { requiredCount: 3 })
            throw new Error("expected InsufficientPoolError")
        } catch (e) { err = e }
        assert.ok(err instanceof InsufficientPoolError, `got ${err.name}: ${err.message}`)
        assert.match(err.message, /only 2 loose root-level image file\(s\)/)

        const ok = resolvePoolScope({ imageDirectories: [libC], imageSubdirectoryMode: "flat" }, { requiredCount: 2 })
        assert.ok(ok.condition.includes("LIKE"), "viable flat pool still resolves its condition")
    })

    // Case 17 -- include mode gates on the full recursive budget, pruning exclusions
    await runCase("include total-count gate honors imageDirectoryExclusions while counting", async () => {
        let err
        try {
            resolvePoolScope(
                { imageDirectories: [libC], imageSubdirectoryMode: "include", imageDirectoryExclusions: ["skip_me"] },
                { requiredCount: 11 }   // real total is 10 without skip_me's 5 files
            )
            throw new Error("expected InsufficientPoolError")
        } catch (e) { err = e }
        assert.ok(err instanceof InsufficientPoolError, `got ${err.name}: ${err.message}`)
        assert.match(err.message, /only 10 image file\(s\) found under configured root\(s\)/)

        const ok = resolvePoolScope(
            { imageDirectories: [libC], imageSubdirectoryMode: "include", imageDirectoryExclusions: ["skip_me"] },
            { requiredCount: 10 }
        )
        assert.equal(ok.condition, "", "include scope stays unrestricted")
    })

    // Case 18 -- subdirsOnly quantitative gate over the union of eligible subtrees
    await runCase("subdirsOnly gates on the combined subtree budget", async () => {
        let err
        try {
            resolvePoolScope(
                { imageDirectories: [libC], imageSubdirectoryMode: "subdirsOnly", imageDirectoryExclusions: ["skip_me"] },
                { requiredCount: 9 }     // union is 8 (a_small + b_mid + z_big incl. nested)
            )
            throw new Error("expected InsufficientPoolError")
        } catch (e) { err = e }
        assert.ok(err instanceof InsufficientPoolError, `got ${err.name}: ${err.message}`)
        assert.match(err.message, /only 8 image file\(s\) below configured root\(s\)/)

        const ok = resolvePoolScope(
            { imageDirectories: [libC], imageSubdirectoryMode: "subdirsOnly", imageDirectoryExclusions: ["skip_me"] },
            { requiredCount: 8 }
        )
        assert.ok(ok.params.some((p) => String(p).includes("/%/%")), "viable subdirsOnly pool keeps its depth condition")
    })
} catch (err) {
    failures++
    console.error(`  ✗ unexpected error: ${err.stack || err.message}`)
} finally {
    try { if (db) await db.close() } catch { /* already closed */ }
    fs.rmSync(workDir, { recursive: true, force: true })
}

if (failures > 0) {
    console.error(`\n[subdirectoryMode] FAILED - ${failures} case(s)`)
    if (process.env.DEBUG_TESTS) {
        console.error("\n--- captured log ---")
        messages.slice(-40).forEach((m) => console.error("  " + m))
    }
    process.exit(1)
}

console.log("\n[subdirectoryMode] All cases passed")