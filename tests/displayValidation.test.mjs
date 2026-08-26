#!/usr/bin/env node
/**
 * Display Configuration Validation Test
 *
 * Verifies validateDisplays() rejects malformed displays settings with precise,
 * index-named errors (reporting ALL problems in one pass), accepts valid tuples,
 * and that DisplayAssignment enforces the same rules for direct consumers.
 * Run via: npm test  (or: node tests/displayValidation.test.mjs)
 */

import assert from "node:assert/strict"
import { validateDisplays, ConfigValidationError } from "../src/lib/displayConfig.js"
import DisplayAssignment from "../src/lib/displayAssignment.js"

let failures = 0
async function runCase(name, fn) {
    try {
        await fn()
        console.log(`  ok - ${name}`)
    } catch (err) {
        failures++
        console.error(`FAIL - ${name}\n${err.stack || err.message}`)
    }
}

const quietLogger = { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

console.log("[displayValidation] pure validator")

await runCase("valid mixed-orientation tuples pass through unchanged", () => {
    const d = [[1920, 1080], [1080, 1920], [512, 512]]
    assert.equal(validateDisplays(d), d)
})

await runCase("non-array values are rejected with a clear message", () => {
    for (const bad of ["nope", null, undefined, 42]) {
        assert.throws(
            () => validateDisplays(bad),
            (err) => err instanceof ConfigValidationError && /non-empty array/.test(err.message)
        )
    }
})

await runCase("empty array is rejected", () => {
    assert.throws(() => validateDisplays([]), ConfigValidationError)
})

await runCase("wrong-length entries are named by index", () => {
    assert.throws(
        () => validateDisplays([[1920, 1080], [640]]),
        (err) => err instanceof ConfigValidationError && err.message.includes("displays[1]")
    )
})

await runCase("zero/negative/non-integer/string dimensions are named by index", () => {
    assert.throws(() => validateDisplays([[0, 1080]]), (e) => e.message.includes("displays[0]"))
    assert.throws(() => validateDisplays([[-5, 1080]]), (e) => e.message.includes("displays[0]"))
    assert.throws(() => validateDisplays([[1920.5, 1080]]), (e) => e.message.includes("displays[0]"))
    assert.throws(() => validateDisplays([["abc", 1080]]), (e) => /displays\[0\]/.test(e.message))
    assert.throws(() => validateDisplays([[NaN, 1080]]), (e) => /displays\[0\]/.test(e.message))
})

await runCase("ALL bad entries are reported in one pass, not just the first", () => {
    let err = null
    try {
        validateDisplays([[0, 1080], ["x"], [1920, -3]])
    } catch (e) {
        err = e
    }
    assert.ok(err instanceof ConfigValidationError, `expected ConfigValidationError, got ${err && `${err.name}: ${err.message}`}`)
    for (const idx of ["displays[0]", "displays[1]", "displays[2]"]) {
        assert.ok(err.message.includes(idx), `expected ${idx} to be named in: ${err.message}`)
    }
})

console.log("[displayValidation] enforcement at entry points")

await runCase("DisplayAssignment rejects malformed displays before building slots", () => {
    assert.throws(() => new DisplayAssignment([[1920]], quietLogger), ConfigValidationError)
    assert.doesNotThrow(() => new DisplayAssignment([[1920, 1080], [1080, 1920]], quietLogger))
})

// ---- Summary ----
console.log(`\n${"=".repeat(50)}`)
if (failures > 0) {
    console.error(`[displayValidation] FAILED - ${failures} case(s) failed`)
    process.exit(1)
}
console.log("[displayValidation] All cases passed")
process.exit(0)