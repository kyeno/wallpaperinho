#!/usr/bin/env node
/**
 * Source Syntax Checker
 *
 * Validates syntax of all JavaScript source files using `node --check`.
 * Walks the src/ directory recursively and checks .js, .mjs, and .cjs files.
 *
 * Exit codes:
 *   0 - All files pass syntax validation
 *   1 - One or more files failed
 *   2 - Internal error (e.g., missing src/ directory)
 *
 * Usage:
 *   node tests/check-syntax.mjs
 *   npm test          # if wired into package.json "test" script
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const SRC_DIR = path.join(ROOT, "src")

const EXTENSIONS = new Set([".js", ".mjs", ".cjs"])

/**
 * Recursively collect all source files matching supported extensions.
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
    const result = []
    let entries

    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
        console.error(`[check-syntax] Cannot read directory ${dir}: ${err.message}`)
        process.exit(2)
        return result // unreachable but satisfies exhaustiveness
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
            // Skip node_modules and hidden directories
            if (entry.name === "node_modules" || entry.name.startsWith(".")) {
                continue
            }
            result.push(...collectFiles(fullPath))
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase()
            if (EXTENSIONS.has(ext)) {
                result.push(fullPath)
            }
        }
    }

    return result
}

/**
 * Check a single file with `node --check`.
 * @param {string} filePath
 * @returns {{ ok: boolean, error?: string }}
 */
function checkFile(filePath) {
    try {
        execFileSync("node", ["--check", filePath], {
            cwd: ROOT,
            timeout: 10_000,
            stdio: "pipe",
        })
        return { ok: true }
    } catch (err) {
        return { ok: false, error: err.message || err.stdout?.toString() || "unknown error" }
    }
}

// ---- Main ----

if (!fs.existsSync(SRC_DIR)) {
    console.error(`[check-syntax] Source directory not found: ${SRC_DIR}`)
    process.exit(2)
}

const files = collectFiles(SRC_DIR)

if (files.length === 0) {
    console.log("[check-syntax] No source files found in src/")
    process.exit(0)
}

console.log(`[check-syntax] Checking ${files.length} file(s) in src/ ...\n`)

let failures = 0
const passed = []

for (const filePath of files) {
    const relativePath = path.relative(ROOT, filePath)
    const result = checkFile(filePath)

    if (result.ok) {
        passed.push(relativePath)
        process.stdout.write(`  ✓ ${relativePath}\n`)
    } else {
        failures++
        console.error(`  ✗ ${relativePath}`)
        console.error(`    ${result.error}`)
    }
}

// Summary
console.log(`\n${"=".repeat(50)}`)
console.log(`Total: ${files.length} | Passed: ${passed.length} | Failed: ${failures}`)
console.log("=".repeat(50))

if (failures > 0) {
    console.error(`\n[check-syntax] FAILED - ${failures} file(s) have syntax errors`)
    process.exit(1)
}

console.log("\n[check-syntax] All files pass syntax validation")
process.exit(0)