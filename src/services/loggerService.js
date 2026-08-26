"use strict"
/**
 * Logger Service
 *
 * Wraps console.log/warn/error/info/debug and automatically strips the configured image
 * directory prefixes from logged messages to make paths more readable.
 *
 * Single directory → strip that entire directory path
 * Multiple directories → find longest common prefix (trimmed to directory boundary)
 * Temp/output paths outside the prefix are left untouched.
 *
 * Signature: logger.<level>(message, tag?)
 *   - tag provided → "[{tag}] {message}" with colored tag + gray message
 *   - no tag      → "{message}" with level-based color on the full message
 *
 * Level filtering (--silent):
 *   The optional second constructor argument sets the minimum severity to emit
 *   ("debug" | "info" | "warn" | "error", default "debug" = show everything).
 *   Messages below the threshold are dropped entirely -- e.g., minLevel "warn"
 *   keeps warnings+errors, which is what unattended/cron runs use (--silent).
 *
 * Plain level prefixes (--silent/--cron):
 *   The optional third constructor argument switches output style for unattended
 *   runs: no ANSI codes at all, every line prefixed with its severity label
 *   instead ([DEBUG] [INFO] [WARN] [ERR]). Raw escape sequences render as "^[[33m..."
 *   in cron mail, so plain labels keep those logs readable and grep-friendly.
 *   In this mode WARN/ERROR lines additionally carry a compact context trailer
 *   naming the active profile and the effective selection pool -- the picked
 *   subdirectory under exclusiveFlat/exclusiveDeep, otherwise the configured root
 *   directories -- so any single mail line is enough to debug which library a failure hit.
 *
 * Colors (default mode):
 *   log/info  → green tag
 *   debug     → blue tag
 *   warn      → yellow tag
 *   error     → red tag
 *   message   → gray (always, when tag is present)
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import path from "node:path"

// Log level thresholds (higher = more severe)
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

// ANSI color codes
const Color = {
    Reset:  "\x1b[0m",
    Green:  "\x1b[32m",
    Blue:   "\x1b[34m",
    Yellow: "\x1b[33m",
    Red:    "\x1b[31m",
    Gray:   "\x1b[90m",
}

// Plain-text severity prefixes used for unattended runs (--silent/--cron) where ANSI codes are dropped
const LevelLabel = { debug: "[DEBUG]", info: "[INFO]", warn: "[WARN]", error: "[ERR]" }

class LoggerService {
    // ---- Private field declarations ----

    /** @type {string} The directory prefix to strip from logged paths */
    #stripPrefix = ""

    /** @type {string[]} Active image directories -- used by the run-context trailer on unattended warnings/errors */
    #imageDirs = []

    /** @type {string|null} Resolved profile name for this run (via setRunContext); null when unknown */
    #runProfile = null

    /** @type {string|null} Effective selection-pool directory for this run (exclusiveFlat/exclusiveDeep pick); null when unscoped */
    #poolDir = null

    /** @type {boolean} Whether to use ANSI color codes */
    #useColors = false

    /** @type {boolean} When true, lines get plain-text severity prefixes instead of colors */
    #useLevelPrefixes = false

    /** @type {number} Minimum severity threshold; messages below this are dropped */
    #minLevel = LEVELS.debug

    /**
     * @param {ConfigService} configService - Must expose settings.imageDirectories
     * @param {"debug"|"info"|"warn"|"error"} [minLevel="debug"] - Minimum severity to emit (default shows everything).
     * @param {boolean} [levelPrefixes=false] - Unattended style for cron mail: no ANSI codes at all, every line prefixed with its severity label ([DEBUG]/[INFO]/[WARN]/[ERR]).
     */
    constructor(configService, minLevel = "debug", levelPrefixes = false) {
        if (!(minLevel in LEVELS)) {
            throw new RangeError(`Unknown log level "${minLevel}" -- expected one of: ${Object.keys(LEVELS).join(", ")}`)
        }
        this.#minLevel = LEVELS[minLevel]
        this.#useLevelPrefixes = Boolean(levelPrefixes)
        this.#imageDirs = configService.settings.imageDirectories || []
        this.#stripPrefix = this.#computeStripPrefix(this.#imageDirs)
        this.#useColors = process.stdout.isTTY !== false
    }

    /**
     * Compute the directory prefix to strip from logged paths.
     * @param {string[]} dirs
     * @returns {string} The prefix to remove (empty string if none).
     */
    #computeStripPrefix(dirs) {
        if (!dirs || dirs.length === 0) return ""
        if (dirs.length === 1) {
            let p = dirs[0]
            // Ensure trailing separator for clean replacement
            if (!p.endsWith(path.sep)) p += path.sep
            return p
        }

        // Multiple directories: find longest common prefix, trimmed to directory boundary
        const sorted = [...dirs].sort()
        const first = sorted[0]
        const last = sorted[sorted.length - 1]

        let i = 0
        while (i < first.length && first[i] === last[i]) {
            i++
        }

        let lcp = first.substring(0, i)

        // Trim to the last directory boundary so we don't split a directory name
        const lastSep = lcp.lastIndexOf(path.sep)
        if (lastSep >= 0) {
            lcp = lcp.substring(0, lastSep + 1)
        }

        return lcp
    }

    /**
     * Sanitize a single value: strip the prefix from string representations.
     * @param {*} val
     * @returns {*} The sanitized value (strings are transformed, others pass through).
     */
    #sanitize(val) {
        if (this.#stripPrefix === "") return val
        if (typeof val === "string") {
            // Only strip when the prefix has sub-path content after it.
            // If the prefix appears alone (at end of string or followed only by whitespace/punctuation),
            // leave it intact to avoid breaking messages like "Directory: /mnt/path/"
            const idx = val.indexOf(this.#stripPrefix)
            if (idx >= 0) {
                const afterPrefix = val.substring(idx + this.#stripPrefix.length)
                // Only replace if there's meaningful path content after the prefix
                if (afterPrefix.match(/[^\s,;:!?.]/)) {
                    return val.replace(this.#escapeRegExp(this.#stripPrefix), "")
                }
            }
            return val
        }
        return val
    }

    /** Escape special regex characters in a string. */
    #escapeRegExp(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }

    /**
     * Format a log line with optional tag.
     * @param {string} message - The log message.
     * @param {string|null} [tag=null] - Optional tag (class/module name) displayed in brackets.
     * @param {string} tagColor - ANSI color code for the tag.
     * @param {string} [msgColor=Color.Reset] - ANSI color code for the message body (when tag is present).
     * @param {string} levelLabel - Plain-text severity prefix used when constructed with level prefixes enabled.
     * @returns {{tagStr: string, msgStr: string}} Formatted strings ready for output.
     */
    #format(message, tag = null, tagColor, msgColor = Color.Reset, levelLabel) {
        const sanitizedMsg = this.#sanitize(String(message))
        const sanitizedTag = tag ? this.#sanitize(String(tag)) : null

        // Unattended style (--silent/--cron): plain text only, severity label first -- no ANSI codes at all.
        if (this.#useLevelPrefixes) {
            const prefix = `${levelLabel} `
            // WARN/ERROR lines carry the run context so any single cron-mail line is debuggable on its own.
            const trailer = levelLabel === LevelLabel.warn || levelLabel === LevelLabel.error ? this.#contextTrailer() : ""
            return sanitizedTag
                ? { tagStr: `${prefix}[${sanitizedTag}] `, msgStr: sanitizedMsg + trailer }
                : { tagStr: prefix, msgStr: sanitizedMsg + trailer }
        }

        if (!this.#useColors) {
            if (sanitizedTag) {
                return {
                    tagStr: `[${sanitizedTag}] `,
                    msgStr: sanitizedMsg,
                }
            }
            return { tagStr: "", msgStr: sanitizedMsg }
        }

        if (sanitizedTag) {
            return {
                tagStr: `${tagColor}[${sanitizedTag}]${Color.Reset} `,
                msgStr: `${msgColor}${sanitizedMsg}${Color.Reset}`,
            }
        }

        // No tag → apply level color to entire message (backward compatible)
        return { tagStr: "", msgStr: `${tagColor}${sanitizedMsg}${Color.Reset}` }
    }

    /**
     * Build the compact run-context trailer for unattended WARN/ERROR lines.
     * Names the effective selection pool: the picked subdirectory when this run was scoped by
     * exclusiveFlat/exclusiveDeep, otherwise the configured root directories.
     * @returns {string} e.g. " [profile=art pool=/mnt/x/Sketches]" or " [profile=p imageDirs=/a, /b]" -- empty string when nothing is known.
     */
    #contextTrailer() {
        const parts = []
        if (this.#runProfile) parts.push(`profile=${this.#runProfile}`)
        if (this.#poolDir) {
            parts.push(`pool=${this.#poolDir}`)
        } else if (this.#imageDirs.length > 0) {
            parts.push(`imageDirs=${this.#imageDirs.join(", ")}`)
        }
        return parts.length > 0 ? ` [${parts.join(" ")}]` : ""
    }

    /**
     * Update run context for unattended WARN/ERROR trailers. Merge semantics: each key provided
     * replaces its slot; keys omitted keep their current value. Best-effort context only -- never
     * affects filtering or output style.
     * @param {{profile?: string|null, poolDir?: string|null}} ctx - profile: named profile for this run;
     *   poolDir: effective selection-pool directory (the per-run pick under exclusiveFlat/exclusiveDeep).
     */
    setRunContext(ctx) {
        if (!ctx || typeof ctx !== "object") return
        if ("profile" in ctx) {
            this.#runProfile = typeof ctx.profile === "string" && ctx.profile ? ctx.profile : null
        }
        if ("poolDir" in ctx) {
            this.#poolDir = typeof ctx.poolDir === "string" && ctx.poolDir ? ctx.poolDir : null
        }
    }

    /**
     * Log with path sanitization and green tag color. Delegates to console.log.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    log(message, tag) {
        if (this.#minLevel > LEVELS.info) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Green, Color.Reset, LevelLabel.info)
        console.log(tagStr + msgStr)
    }

    /**
     * Info with path sanitization and green tag color. Delegates to console.info.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    info(message, tag) {
        if (this.#minLevel > LEVELS.info) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Green, Color.Reset, LevelLabel.info)
        console.info(tagStr + msgStr)
    }

    /**
     * Debug with path sanitization and blue tag color. Delegates to console.log.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    debug(message, tag) {
        if (this.#minLevel > LEVELS.debug) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Blue, Color.Gray, LevelLabel.debug)
        console.log(tagStr + msgStr)
    }

    /**
     * Warn with path sanitization and yellow tag color. Delegates to console.warn.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    warn(message, tag) {
        if (this.#minLevel > LEVELS.warn) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Yellow, Color.Yellow, LevelLabel.warn)
        console.warn(tagStr + msgStr)
    }

    /**
     * Error with path sanitization and red tag color. Delegates to console.error.
     * Always emitted regardless of the minimum level threshold.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    error(message, tag) {
        const { tagStr, msgStr } = this.#format(message, tag, Color.Red, Color.Yellow, LevelLabel.error)
        console.error(tagStr + msgStr)
    }
}

export default LoggerService