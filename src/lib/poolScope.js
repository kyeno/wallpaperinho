"use strict"
/**
 * Pool Scope Resolver -- "subdirectory driving modes" for image selection.
 *
 * Resolves the effective selection-pool restriction implied by the
 * `imageSubdirectoryMode` setting relative to the configured root directories:
 *
 *   include        everything under the roots, recursively            (default)
 *   flat           only files directly inside a root directory
 *   subdirsOnly    skip loose root-level files; use subdirectories only
 *   exclusiveFlat  one random first-level subdir per run -> its own files only
 *   exclusiveDeep  one random first-level subdir per run -> its whole subtree
 *
 * The result is a SQL WHERE fragment over `images.path` plus bound parameters,
 * applied at SELECTION time only -- indexing and catalog maintenance stay unscoped
 * so shared catalogs remain complete no matter which mode each profile requests.
 * Directories listed in `imageDirectoryExclusions` never count as candidates.
 *
 * Viability gate (`options.requiredCount`, typically the number of display slots):
 * wallpaperGenerator needs one DISTINCT image per display slot, so any pool holding
 * fewer images than that can never succeed. When requiredCount > 0 every mode verifies
 * its on-disk file budget before resolving; exclusive modes pick ONLY among
 * subdirectories meeting the minimum (thin folders are skipped, not picked-then-failed).
 * Nothing qualifies -> InsufficientPoolError (carrying attempted dirs + counts) instead
 * of silently widening the pool, so callers can rotate profiles or fail fast with full
 * diagnostics BEFORE any indexing/processing work is spent.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import fs from "node:fs"
import path from "node:path"

/** Valid values for the `imageSubdirectoryMode` config key. */
export const SUBDIR_MODES = ["include", "flat", "subdirsOnly", "exclusiveFlat", "exclusiveDeep"]

const LIKE_ESCAPE_CHAR = "\\"
const ESCAPE_CLAUSE = `ESCAPE '${LIKE_ESCAPE_CHAR}'`

/** Escape LIKE metacharacters (\, %, _) in a literal string fragment. */
function escapeLike(value) {
    return value.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE_CHAR}${ch}`)
}

/** Condition matching image paths located anywhere under dir (any depth). */
function anyDepthUnder(dir) {
    return {
        cond: `path LIKE ? ${ESCAPE_CLAUSE}`,
        params: [`${escapeLike(dir)}/%`],
    }
}

/** Condition matching files DIRECTLY inside dir (no deeper nesting). */
function directFilesOf(dir) {
    const esc = escapeLike(dir)
    return {
        cond: `path LIKE ? ${ESCAPE_CLAUSE} AND path NOT LIKE ? ${ESCAPE_CLAUSE}`,
        params: [`${esc}/%`, `${esc}/%/%`],
    }
}

/** Join per-root condition fragments with OR (empty input -> unrestricted). */
function combineFragments(fragments) {
    if (fragments.length === 0) return { condition: "", params: [] }
    const parts = fragments.map((f) => `(${f.cond})`)
    // Outer parens are REQUIRED: callers append this after an AND clause, so without them
    // only the first fragment would be bound to that predicate (AND binds tighter than OR).
    return {
        condition: `(${parts.join(" OR ")})`,
        params: fragments.flatMap((f) => f.params),
    }
}

/**
 * List eligible first-level subdirectories of a root.
 * Skips names listed in exclusions; missing/unreadable roots contribute nothing.
 * Sorted for deterministic random selection.
 * @param {string} rootDir - Absolute, normalized root directory.
 * @param {string[]} exclusions - Directory basenames to skip.
 * @returns {string[]} Absolute paths of eligible child directories.
 */
function listEligibleSubdirs(rootDir, exclusions) {
    let entries
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true })
    } catch {
        return []
    }
    return entries
        .filter((e) => e.isDirectory() && !exclusions.includes(e.name))
        .map((e) => path.join(rootDir, e.name))
        .sort()
}

/**
 * Thrown when a selection pool cannot supply enough distinct images to fill every
 * display slot. Carries structured details (mode, required count, attempted candidates)
 * so callers can render actionable diagnostics and tests can assert on them.
 */
export class InsufficientPoolError extends Error {
    /**
     * @param {{mode?: string|null, required?: number|null, attempted?: Array<{dir: string, count: number}>, note?: string}} [desc={}] - Failure context; the message is composed from these parts.
     */
    constructor({ mode = "unknown", required = null, attempted = [], note = "" } = {}) {
        const tried = (attempted || []).map((a) => `${path.basename(a.dir)}(${a.count})`).join(", ")
        const detail = tried
            ? `subdirectory image counts below minimum: ${tried}`
            : (note || "no eligible subdirectories under configured root(s)")
        const req = Number.isFinite(required) && required > 0
            ? `, need at least ${required} distinct image(s) -- one per display`
            : ""
        super(`selection pool too small for imageSubdirectoryMode "${mode}"${req}: ${detail}`)
        this.name = "InsufficientPoolError"
        this.mode = mode
        this.required = required
        this.attempted = attempted || []
    }
}

/**
 * Count image files under dir using the SAME rules as ImageIndexer.#walkDirectory:
 * lowercase extension filter, excluded directory basenames pruned at every level,
 * unreadable directories contribute zero. recursive=false counts direct files only.
 * @param {string} dir - Directory to start from.
 * @param {string[]} extensions - Allowed file extensions (lowercase, including dot).
 * @param {string[]} exclusions - Directory basenames to prune entirely.
 * @param {boolean} [recursive=true] - Walk nested directories; false = direct files only.
 * @returns {number} Number of matching image files on disk.
 */
function countImageFiles(dir, extensions, exclusions, recursive = true) {
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return 0
    }
    let total = 0
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (recursive && !exclusions.includes(entry.name)) {
                total += countImageFiles(path.join(dir, entry.name), extensions, exclusions, true)
            }
        } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
            total++
        }
    }
    return total
}

/**
 * Resolve the effective pool scope for a run from merged settings.
 * Pure with respect to the database -- only reads directory listings off disk.
 * @param {{imageDirectories?: string[], imageSubdirectoryMode?: string, imageDirectoryExclusions?: string[], imageExtensions?: string[]}} settings - Merged runtime settings.
 * @param {{rng?: Function, requiredCount?: number}} [options={}] - Injectable random source (tests); minimum distinct images the resolved pool must hold on disk (typically displays.length). When > 0, pools below it raise InsufficientPoolError instead of resolving.
 * @returns {{mode: string, effectiveMode: string, roots: string[], chosenDir: string|null, condition: string, params: Array<string>, skippedThin: Array<{dir: string, count: number}>}}
 *          Resolved scope; `condition`/`params` form a SQL WHERE fragment over images.path ("").
 */
export function resolvePoolScope(settings = {}, options = {}) {
    const rng = typeof options.rng === "function" ? options.rng : Math.random
    const requiredCount = Number.isFinite(options.requiredCount) && options.requiredCount > 0
        ? Math.floor(options.requiredCount)
        : null

    const requestedMode = settings.imageSubdirectoryMode ?? "include"
    if (!SUBDIR_MODES.includes(requestedMode)) {
        throw new Error(
            `Invalid imageSubdirectoryMode ${JSON.stringify(requestedMode)}. Valid values: ${SUBDIR_MODES.join(", ")}`
        )
    }

    const roots = [...new Set(
        (Array.isArray(settings.imageDirectories) ? settings.imageDirectories : [])
            .filter((d) => typeof d === "string" && d.trim() !== "")
            .map((d) => path.resolve(d))
    )]
    const exclusions = Array.isArray(settings.imageDirectoryExclusions)
        ? settings.imageDirectoryExclusions
        : []
    const extensions = Array.isArray(settings.imageExtensions) && settings.imageExtensions.length > 0
        ? settings.imageExtensions.map((e) => String(e).toLowerCase())
        : [".jpg", ".jpeg", ".png", ".webp"]

    const base = { mode: requestedMode, effectiveMode: requestedMode, roots, chosenDir: null, skippedThin: [] }

    switch (requestedMode) {
        case "include": {
            if (requiredCount != null) {
                const total = roots.reduce((n, r) => n + countImageFiles(r, extensions, exclusions, true), 0)
                if (total < requiredCount) {
                    throw new InsufficientPoolError({
                        mode: requestedMode, required: requiredCount,
                        note: `only ${total} image file(s) found under configured root(s)`,
                    })
                }
            }
            return { ...base, condition: "", params: [] }
        }

        case "flat": {
            if (requiredCount != null) {
                const total = roots.reduce((n, r) => n + countImageFiles(r, extensions, exclusions, false), 0)
                if (total < requiredCount) {
                    throw new InsufficientPoolError({
                        mode: requestedMode, required: requiredCount,
                        note: `only ${total} loose root-level image file(s) found across configured root(s)`,
                    })
                }
            }
            return { ...base, ...combineFragments(roots.map(directFilesOf)) }
        }

        case "subdirsOnly": {
            const subdirs = roots.flatMap((r) => listEligibleSubdirs(r, exclusions))
            if (subdirs.length === 0) {
                throw new InsufficientPoolError({ mode: requestedMode, required: requiredCount })
            }
            if (requiredCount != null) {
                const total = subdirs.reduce((n, d) => n + countImageFiles(d, extensions, exclusions, true), 0)
                if (total < requiredCount) {
                    throw new InsufficientPoolError({
                        mode: requestedMode, required: requiredCount,
                        note: `only ${total} image file(s) below configured root(s)`,
                    })
                }
            }
            // At least one intermediate directory between root and file name
            const fragments = roots.map((dir) => ({
                cond: `path LIKE ? ${ESCAPE_CLAUSE}`,
                params: [`${escapeLike(dir)}/%/%`],
            }))
            return { ...base, ...combineFragments(fragments) }
        }

        case "exclusiveFlat":
        case "exclusiveDeep": {
            const recursive = requestedMode === "exclusiveDeep"
            const subdirs = roots.flatMap((r) => listEligibleSubdirs(r, exclusions))
            if (subdirs.length === 0) {
                throw new InsufficientPoolError({ mode: requestedMode, required: requiredCount })
            }

            let pool = subdirs
            let skippedThin = []
            if (requiredCount != null) {
                const counted = subdirs.map(
                    (dir) => ({ dir, count: countImageFiles(dir, extensions, exclusions, recursive) })
                )
                pool = counted.filter((c) => c.count >= requiredCount)
                skippedThin = counted.filter((c) => c.count < requiredCount)
                if (pool.length === 0) {
                    throw new InsufficientPoolError({ mode: requestedMode, required: requiredCount, attempted: counted })
                }
            }

            // Pick among VIABLE candidates only -- thin folders are never selected.
            const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length))
            const chosenDir = typeof pool[index] === "string" ? pool[index] : pool[index].dir
            const scope = recursive ? anyDepthUnder(chosenDir) : directFilesOf(chosenDir)
            return { ...base, chosenDir, condition: scope.cond, params: [...scope.params], skippedThin }
        }
    }
}