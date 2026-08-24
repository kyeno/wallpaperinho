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
 * When no eligible subdirectories exist, non-include modes fall back to "include".
 * Directories listed in `imageDirectoryExclusions` never count as candidates.
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
 * Resolve the effective pool scope for a run from merged settings.
 * Pure with respect to the database -- only reads directory listings off disk.
 * @param {{imageDirectories?: string[], imageSubdirectoryMode?: string, imageDirectoryExclusions?: string[]}} settings - Merged runtime settings.
 * @param {{logger?: object, rng?: Function}} [options={}] - Logger for fallback/pick notices; injectable random source (tests).
 * @returns {{mode: string, effectiveMode: string, roots: string[], chosenDir: string|null, condition: string, params: Array<string>}}
 *          Resolved scope; `condition`/`params` form a SQL WHERE fragment over images.path ("").
 */
export function resolvePoolScope(settings = {}, options = {}) {
    const logger = options.logger || console
    const rng = typeof options.rng === "function" ? options.rng : Math.random

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

    const base = { mode: requestedMode, effectiveMode: requestedMode, roots, chosenDir: null }

    /** Fallback used when a subdirectory-dependent mode finds nothing to work with. */
    const fallbackToInclude = () => {
        logger.warn(
            `imageSubdirectoryMode "${requestedMode}" -- no eligible subdirectories under configured roots; falling back to "include"`,
            'PoolScope'
        )
        return { ...base, effectiveMode: "include", condition: "", params: [] }
    }

    switch (requestedMode) {
        case "include":
            return { ...base, condition: "", params: [] }

        case "flat":
            return { ...base, ...combineFragments(roots.map(directFilesOf)) }

        case "subdirsOnly": {
            if (roots.flatMap((r) => listEligibleSubdirs(r, exclusions)).length === 0) {
                return fallbackToInclude()
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
            const candidates = roots.flatMap((r) => listEligibleSubdirs(r, exclusions))
            if (candidates.length === 0) return fallbackToInclude()
            const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))
            const chosenDir = candidates[index]
            logger.log(`Picked subdirectory for this run: ${chosenDir}`, 'PoolScope')
            const scope = requestedMode === "exclusiveFlat"
                ? directFilesOf(chosenDir)
                : anyDepthUnder(chosenDir)
            return { ...base, chosenDir, condition: scope.cond, params: [...scope.params] }
        }
    }
}