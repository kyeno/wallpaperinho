#!/usr/bin/env node
/**
 * Profile Selection & Silent Logging Test Suite
 *
 * Covers the crontab-usability features:
 *   - src/lib/profilePicker.js : eligibility filtering, deterministic random picks,
 *     all-excluded fallback, no-repeat rotation, empty-pool edge cases
 *   - src/services/configService.js : meta-key (excludeFromRandom) never leaking into
 *     .settings, and --directory mode still inheriting profile strategies/upscaler
 *   - src/services/loggerService.js : minimum-level filtering (--silent behavior)
 *
 * No ImageMagick/NCNN/display required. Exit codes: 0 = pass, 1 = fail.
 *
 * Usage:
 *   node tests/profileSelection.test.mjs
 */

import assert from "node:assert/strict"

import { getEligibleProfileNames, selectRandomProfile } from "../src/lib/profilePicker.js"
import ConfigService, { applyProfileOverrides } from "../src/services/configService.js"
import LoggerService from "../src/services/loggerService.js"

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

/** Deterministic LCG random source in [0, 1). */
function makeLcg(seed = 42) {
    let state = seed >>> 0
    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296
        return state / 4294967296
    }
}

const syntheticProfiles = {
    alpha:   { imageDirectories: ["/a"], imageMatchingStrategy: "gemini" },
    beta:    { imageDirectories: ["/b"], excludeFromRandom: true },
    gamma:   { imageDirectories: ["/c"], excludeFromRandom: false },
    delta:   {}, // no explicit flag at all -> eligible by default
}

console.log("[profileSelection] pure picker logic")

await runCase("getEligibleProfileNames filters only explicit true flags", () => {
    assert.deepEqual(getEligibleProfileNames(syntheticProfiles), ["alpha", "gamma", "delta"])
})

await runCase("picks always stay within the eligible pool (seeded RNG)", () => {
    const rng = makeLcg()
    for (let i = 0; i < 500; i++) {
        const pick = selectRandomProfile(syntheticProfiles, { rng })
        assert.ok(["alpha", "gamma", "delta"].includes(pick), `unexpected pick: ${pick}`)
    }
})

await runCase("all eligible profiles appear across many draws", () => {
    const seen = new Set()
    const rng = makeLcg(7)
    for (let i = 0; i < 1000 && seen.size < 3; i++) {
        seen.add(selectRandomProfile(syntheticProfiles, { rng }))
    }
    assert.equal(seen.size, 3, `expected full coverage, saw: ${[...seen].join(", ")}`)
})

await runCase("falls back to first profile when everything is excluded", () => {
    const allExcluded = { a: { excludeFromRandom: true }, b: { excludeFromRandom: true } }
    assert.equal(selectRandomProfile(allExcluded), "a")
})

await runCase("no-repeat rotation skips the last pick when alternatives exist", () => {
    const two = { x: {}, y: {} }
    const rng = makeLcg()
    for (let i = 0; i < 50; i++) {
        assert.equal(selectRandomProfile(two, { rng, excludeName: "x" }), "y")
        assert.equal(selectRandomProfile(two, { rng, excludeName: "y" }), "x")
    }
})

await runCase("single-profile setup still works even when it was the last pick", () => {
    const one = { solo: { excludeFromRandom: true } } // excluded AND the only candidate
    assert.equal(selectRandomProfile(one, { excludeName: "solo" }), "solo")
})

await runCase("empty profiles object yields empty string", () => {
    assert.equal(selectRandomProfile({}), "")
})

await runCase("rng returning exactly 1 is clamped instead of overflowing", () => {
    const pool = { a: {}, b: {}, c: {} }
    assert.equal(selectRandomProfile(pool, { rng: () => 1 }), "c")
})

console.log("\n[profileSelection] config merge semantics")

await runCase("applyProfileOverrides skips meta-keys and undefined values", () => {
    const base = { imageMatchingStrategy: "gemini" }
    const merged = applyProfileOverrides(base, {
        ncnnUpscalerModel: "4xHFA2k",
        excludeFromRandom: true,   // must NOT leak into settings
        somethingUndefined: undefined,
    })
    assert.equal(merged.ncnnUpscalerModel, "4xHFA2k")
    assert.ok(!("excludeFromRandom" in merged), "meta-key leaked into settings")
    assert.ok(!("somethingUndefined" in merged), "undefined value was copied")
    assert.equal(base.excludeFromRandom, undefined, "base object was mutated")
})

await runCase("--directory mode still inherits profile strategy/upscaler (regression)", () => {
    const names = ConfigService.listProfiles()
    assert.ok(names.length > 0, "expected at least one profile in etc/profiles.js")

    // Pick a real profile that defines an imageMatchingStrategy to compare against.
    let target = null
    for (const name of names) {
        if (new ConfigService(name).settings.imageMatchingStrategy !== undefined) {
            target = name
            break
        }
    }
    if (!target) target = names[0]

    const customDirs = ["/tmp/wallpaperinho-test-dirs"]
    const config = new ConfigService(target, { imageDirectories: customDirs })

    assert.deepEqual(config.settings.imageDirectories, customDirs, "CLI directories must win")
    assert.equal(config.getProfileName(), target, "profile must be resolved even in directory mode")

    // Whatever non-directory overrides the chosen profile carries must survive now.
    const reference = new ConfigService(target)
    for (const key of ["imageMatchingStrategy", "ncnnUpscalerModel", "ncnnUpscalerScale"]) {
        if (reference.settings[key] !== undefined) {
            assert.deepEqual(
                config.settings[key],
                reference.settings[key],
                `profile setting "${key}" was lost in --directory mode`
            )
        }
    }
})

await runCase("explicit strategy CLI override still beats the profile's", () => {
    const config = new ConfigService(null, {
        imageDirectories: ["/tmp/x"],
        strategy: "canny",
    })
    assert.equal(config.settings.imageMatchingStrategy, "canny")
})

console.log("\n[profileSelection] random statics against real profiles.js")

await runCase("ConfigService.pickRandomProfile stays within eligible set", () => {
    const all = ConfigService.listProfiles()
    const eligible = ConfigService.listEligibleProfiles()
    assert.ok(eligible.length <= all.length, "eligible set larger than full set?")
    if (all.length === 0) return // nothing defined -> nothing to check
    for (let i = 0; i < 100; i++) {
        const pick = ConfigService.pickRandomProfile({ excludeName: null })
        assert.ok(all.includes(pick), `pick not a known profile: ${pick}`)
        if (eligible.length > 0) {
            assert.ok(eligible.includes(pick), `pick from excluded pool: ${pick}`)
        }
    }
})

console.log("\n[profileSelection] logger level filtering (--silent)")

function captureConsole(fn) {
    const calls = []
    const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    console.log = (...a) => calls.push(["log", ...a])
    console.info = (...a) => calls.push(["info", ...a])
    console.warn = (...a) => calls.push(["warn", ...a])
    console.error = (...a) => calls.push(["error", ...a])
    try {
        fn()
    } finally {
        Object.assign(console, orig)
    }
    return calls
}

const configStub = { settings: { imageDirectories: ["/some/base/dir"] } }

await runCase("default logger emits every level (backward compatible)", () => {
    const logger = new LoggerService(configStub)
    const calls = captureConsole(() => {
        logger.debug("d")
        logger.log("l")
        logger.info("i")
        logger.warn("w")
        logger.error("e")
    })
    assert.equal(calls.length, 5, `expected all 5 levels to emit, got ${calls.map((c) => c[0]).join(",")}`)
})

await runCase('minLevel "error" hides debug/log/info/warn but keeps errors', () => {
    const logger = new LoggerService(configStub, "error")
    const calls = captureConsole(() => {
        logger.debug("d")
        logger.log("l")
        logger.info("i")
        logger.warn("w")
        logger.error("e")
    })
    assert.deepEqual(
        calls.map((c) => c[0]),
        ["error"],
        `only error should pass through, got: ${calls.map((c) => c[0]).join(", ") || "(nothing)"}`)
})

await runCase('minLevel "warn" keeps warn+error only', () => {
    const logger = new LoggerService(configStub, "warn")
    const calls = captureConsole(() => {
        logger.debug("d")
        logger.info("i")
        logger.warn("w")
        logger.error("e")
    })
    assert.deepEqual(calls.map((c) => c[0]), ["warn", "error"])
})

await runCase("unknown level name throws a clear RangeError", () => {
    assert.throws(() => new LoggerService(configStub, "verbose"), RangeError)
})

// ---- Summary ----
console.log(`\n${"=".repeat(50)}`)
if (failures > 0) {
    console.error(`[profileSelection] FAILED — ${failures} case(s) failed`)
    process.exit(1)
}
console.log("[profileSelection] All cases passed")
process.exit(0)