"use strict"
/**
 * Quarantine Service Tests
 *
 * Covers enable/disable semantics, directory guardrails, collision-safe naming,
 * the EXDEV (cross-device) fallback branch, and failure containment.
 * Run via: npm test  (or: node tests/quarantine.test.mjs)
 */

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import QuarantineService, { defaultQuarantineDir } from "../src/lib/quarantineService.js"

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

function quietLogger() {
    const calls = []
    return {
        calls,
        log() {}, info() {}, debug() {},
        warn(msg) { calls.push(["warn", msg]) },
        error(msg) { calls.push(["error", msg]) },
    }
}

/** Build an isolated fixture: library dir with one broken file + quarantine dir. */
function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wpq-"))
    const libDir = path.join(root, "library")
    const qDir = path.join(root, "quarantined")
    fs.mkdirSync(libDir, { recursive: true })
    fs.mkdirSync(qDir, { recursive: true })
    const filePath = path.join(libDir, "broken.png")
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // truncated PNG header
    const config = { settings: { imageDirectories: [libDir], quarantinedImagesDirectory: qDir } }
    return { root, libDir, qDir, filePath, config }
}

console.log("[quarantine] configuration semantics")

await runCase("enabled by default when key is absent; disabled only on explicit false", () => {
    assert.equal(new QuarantineService({ settings: {} }, quietLogger()).enabled, true)
    assert.equal(new QuarantineService({ settings: { quarantineBrokenImages: true } }, quietLogger()).enabled, true)
    assert.equal(new QuarantineService({ settings: { quarantineBrokenImages: false } }, quietLogger()).enabled, false)
})

await runCase("default directory resolves to ~/Pictures/Quarantined", () => {
    assert.equal(defaultQuarantineDir(), path.join(os.homedir(), "Pictures", "Quarantined"))
})

console.log("[quarantine] guardrails")

await runCase("canQuarantine rejects files outside configured image directories", () => {
    const fx = makeFixture()
    const svc = new QuarantineService(fx.config, quietLogger())
    const outsider = path.join(fx.root, "elsewhere.png")
    fs.writeFileSync(outsider, "data")
    assert.equal(svc.canQuarantine(outsider), false)
    assert.equal(svc.canQuarantine(path.join(fx.libDir, "missing.png")), false) // not a file
    assert.equal(svc.canQuarantine(fx.filePath), true)
    fs.rmSync(fx.root, { recursive: true, force: true })
})

await runCase("disabled service quarantines nothing without throwing", () => {
    const fx = makeFixture()
    const logger = quietLogger()
    const svc = new QuarantineService({ settings: { ...fx.config.settings, quarantineBrokenImages: false } }, logger)
    assert.equal(svc.quarantine(fx.filePath), null)
    assert.ok(fs.existsSync(fx.filePath), "file must remain in place when disabled")
    assert.equal(logger.calls.length, 0)
    fs.rmSync(fx.root, { recursive: true, force: true })
})

console.log("[quarantine] move behavior")

await runCase("moves the file out of the library and logs one WARN line", () => {
    const fx = makeFixture()
    const logger = quietLogger()
    const svc = new QuarantineService(fx.config, logger)
    const dest = svc.quarantine(fx.filePath)
    assert.ok(dest && fs.existsSync(dest), `expected destination to exist (got ${dest})`)
    assert.ok(!fs.existsSync(fx.filePath), "original must be gone from the library")
    assert.equal(fs.readFileSync(dest).length, 4)
    const warns = logger.calls.filter(([lvl]) => lvl === "warn").map(([, m]) => m)
    assert.ok(warns.some((m) => m.includes("Quarantined broken image")), `expected a quarantine WARN, got: ${JSON.stringify(logger.calls)}`)
    fs.rmSync(fx.root, { recursive: true, force: true })
})

await runCase("name collision gets a unique suffix instead of overwriting", () => {
    const fx = makeFixture()
    const svc = new QuarantineService(fx.config, quietLogger())
    // Pre-occupy the plain target name with unrelated content
    const occupied = path.join(fx.qDir, "broken.png")
    fs.writeFileSync(occupied, "pre-existing")
    const dest = svc.quarantine(fx.filePath)
    assert.ok(dest && fs.existsSync(dest))
    assert.notEqual(path.basename(dest), "broken.png", "must not clobber the pre-existing file")
    assert.equal(fs.readFileSync(occupied).toString(), "pre-existing")
    assert.equal(fs.readFileSync(dest).length, 4)
    fs.rmSync(fx.root, { recursive: true, force: true })
})

await runCase("EXDEV (cross-device) falls back to copy+unlink and still succeeds", () => {
    const fx = makeFixture()
    const logger = quietLogger()
    const svc = new QuarantineService(fx.config, logger)
    const origRename = fs.renameSync
    let renameThrew = false
    fs.renameSync = () => {
        renameThrew = true
        throw Object.assign(new Error("Invalid cross-device link"), { code: "EXDEV" })
    }
    try {
        const dest = svc.quarantine(fx.filePath)
        assert.ok(renameThrew, "rename stub should have been hit")
        assert.ok(dest && fs.existsSync(dest), `expected destination via copy fallback (got ${dest})`)
        assert.ok(!fs.existsSync(fx.filePath), "original must be removed after successful copy")
        assert.equal(logger.calls.filter(([l]) => l === "error").length, 0)
    } finally {
        fs.renameSync = origRename
    }
    fs.rmSync(fx.root, { recursive: true, force: true })
})

await runCase("uncreatable quarantine dir returns null without throwing", () => {
    const fx = makeFixture()
    // Point the directory at a path under an existing regular file -> mkdir fails (ENOTDIR)
    const blocker = path.join(fx.root, "blocker-file")
    fs.writeFileSync(blocker, "x")
    const config = { settings: { ...fx.config.settings, quarantinedImagesDirectory: path.join(blocker, "sub") } }
    const logger = quietLogger()
    const svc = new QuarantineService(config, logger)
    assert.doesNotThrow(() => {
        assert.equal(svc.quarantine(fx.filePath), null)
    })
    assert.ok(fs.existsSync(fx.filePath), "file stays put when quarantine cannot be created")
    assert.ok(logger.calls.some(([lvl, m]) => lvl === "warn" && String(m).includes("Quarantine unavailable")))
    fs.rmSync(fx.root, { recursive: true, force: true })
})

// ---- Summary ----
console.log(`\n${"=".repeat(50)}`)
if (failures > 0) {
    console.error(`[quarantine] FAILED - ${failures} case(s) failed`)
    process.exit(1)
}
console.log("[quarantine] All cases passed")
process.exit(0)