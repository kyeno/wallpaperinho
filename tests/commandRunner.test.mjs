"use strict"
/**
 * Command Runner Tests
 *
 * Covers stderr classification (using real ImageMagick output samples), noise
 * filtering, and the sync/async command wrappers' success/failure behavior.
 * Run via: npm test  (or: node tests/commandRunner.test.mjs)
 */

import assert from "node:assert/strict"
import { classifyStderr, runCommand, runCommandSync, CommandError, TIMEOUT_FAILURE_CODE } from "../src/lib/commandRunner.js"

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

console.log("[commandRunner] stderr classification")

await runCase("real PNG sample: @ warning line -> warnings, @ error line -> errors", () => {
    const text = [
        "identify: Expected 8 bytes; found 0 bytes `/mnt/x/wall_12b15.PNG' @ warning/png.c/MagickPNGWarningHandler/1531.",
        "identify: unexpected end-of-file `/mnt/x/wall_12b15.PNG' @ error/png.c/MagickPNGError/1305.",
    ].join("\n")
    const c = classifyStderr(text, { failed: true })
    assert.equal(c.warnings.length, 1)
    assert.match(c.warnings[0], /@ warning\/png\.c/)
    assert.equal(c.errors.length, 1)
    assert.match(c.errors[0], /@ error\/png\.c/)
})

await runCase("real JPEG sample: single @ error line classified as error on failure", () => {
    const text = "identify: Insufficient image data to decode image `/media/x/cars.jpg' @ error/jpeg.c/ReadOneJPEGImage/2649."
    const c = classifyStderr(text, { failed: true })
    assert.deepEqual(c.errors, [text])
    assert.equal(c.warnings.length, 0)
})

await runCase("@ fatal marker counts as an error even when the command exited 0", () => {
    const c = classifyStderr("some noise\nboom @ fatal/jpg.c/JpegException/287", { failed: false })
    assert.deepEqual(c.errors, ["boom @ fatal/jpg.c/JpegException/287"])
    assert.deepEqual(c.warnings, ["some noise"])
})

await runCase("known-benign noise lines are dropped entirely", () => {
    const c = classifyStderr("foo bar\nDelegate loading\nplain diagnostic line", { failed: false })
    assert.deepEqual(c.warnings, ["foo bar", "plain diagnostic line"])
    assert.equal(c.errors.length, 0)
})

await runCase("successful-command stderr defaults to warnings; blank lines ignored", () => {
    const c = classifyStderr("\nline one\n   \nline two\n")
    assert.deepEqual(c.warnings, ["line one", "line two"])
    assert.equal(c.errors.length, 0)
})

await runCase("empty/null input yields empty buckets", () => {
    assert.deepEqual(classifyStderr(""), { errors: [], warnings: [] })
    assert.deepEqual(classifyStderr(null), { errors: [], warnings: [] })
})

console.log("[commandRunner] command wrappers")

await runCase("runCommand captures stdout+stderr on success (exit 0)", async () => {
    const r = await runCommand("/bin/sh", ["-c", "echo OUT && echo NOISY >&2"])
    assert.match(r.stdout, /OUT/)
    const c = classifyStderr(r.stderr)
    assert.deepEqual(c.warnings, ["NOISY"])
    assert.equal(c.errors.length, 0)
})

await runCase("runCommand throws CommandError with concise message + classified error line", async () => {
    try {
        await runCommand("/bin/sh", ["-c", "echo BOOM >&2; exit 3"])
        assert.fail("expected throw")
    } catch (err) {
        assert.ok(err instanceof CommandError, `got ${err.constructor.name}`)
        assert.equal(err.code, 3)
        assert.ok(!String(err.message).includes("BOOM"), `message should stay concise: ${err.message}`)
        assert.ok(err.classified.errors.some((l) => l.includes("BOOM")))
    }
})

await runCase("missing binary -> CommandError carrying errno-like code", async () => {
    try {
        await runCommand("/nonexistent/bin/xyz123", [])
        assert.fail("expected throw")
    } catch (err) {
        assert.ok(err instanceof CommandError)
        assert.equal(String(err.code), "ENOENT")
    }
})

await runCase("timeout kill -> CommandError with ERR_CHILD_PROCESS_TIMEOUT code", async () => {
    const t0 = Date.now()
    try {
        await runCommand("/bin/sh", ["-c", "sleep 30"], { timeout: 300 })
        assert.fail("expected throw")
    } catch (err) {
        assert.ok(err instanceof CommandError)
        assert.equal(String(err.code), TIMEOUT_FAILURE_CODE)
        assert.ok(Date.now() - t0 < 10_000, `should be killed at ~300 ms, took ${Date.now() - t0} ms`)
    }
})

await runCase("runCommandSync honors timeout and maps the same failure code", () => {
    let threw = false
    try {
        runCommandSync("/bin/sh", ["-c", "sleep 30"], { timeout: 300 })
    } catch (err) {
        threw = true
        assert.ok(err instanceof CommandError)
        assert.equal(String(err.code), TIMEOUT_FAILURE_CODE)
    }
    assert.ok(threw, "sync timeout should throw")
})

await runCase("runCommandSync mirrors the async wrapper behavior", () => {
    const ok = runCommandSync("/bin/sh", ["-c", "echo OUT && echo NOISY >&2"])
    assert.match(ok.stdout, /OUT/)
    assert.deepEqual(classifyStderr(ok.stderr).warnings, ["NOISY"])

    let threw = false
    try {
        runCommandSync("/bin/sh", ["-c", "echo BOOM >&2; exit 5"])
    } catch (err) {
        threw = true
        assert.ok(err instanceof CommandError)
        assert.equal(err.code, 5)
        assert.ok(!String(err.message).includes("BOOM"))
        assert.ok(err.classified.errors.some((l) => l.includes("BOOM")))
    }
    assert.ok(threw, "sync failure should throw")
})

// ---- Summary ----
console.log(`\n${"=".repeat(50)}`)
if (failures > 0) {
    console.error(`[commandRunner] FAILED - ${failures} case(s) failed`)
    process.exit(1)
}
console.log("[commandRunner] All cases passed")
process.exit(0)