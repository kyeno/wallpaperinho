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
 * Colors (when stdout is a TTY):
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

class LoggerService {
    // ---- Private field declarations ----

    /** @type {string} The directory prefix to strip from logged paths */
    #stripPrefix = ""

    /** @type {boolean} Whether to use ANSI color codes */
    #useColors = false

    /** @type {number} Minimum severity threshold; messages below this are dropped */
    #minLevel = LEVELS.debug

    /**
     * @param {ConfigService} configService - Must expose settings.imageDirectories
     * @param {"debug"|"info"|"warn"|"error"} [minLevel="debug"] - Minimum severity to emit (default shows everything).
     */
    constructor(configService, minLevel = "debug") {
        if (!(minLevel in LEVELS)) {
            throw new RangeError(`Unknown log level "${minLevel}" -- expected one of: ${Object.keys(LEVELS).join(", ")}`)
        }
        this.#minLevel = LEVELS[minLevel]
        this.#stripPrefix = this.#computeStripPrefix(
            configService.settings.imageDirectories || []
        )
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
     * @returns {{tagStr: string, msgStr: string}} Formatted strings ready for output.
     */
    #format(message, tag = null, tagColor, msgColor = Color.Reset) {
        const sanitizedMsg = this.#sanitize(String(message))
        const sanitizedTag = tag ? this.#sanitize(String(tag)) : null

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
     * Log with path sanitization and green tag color. Delegates to console.log.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    log(message, tag) {
        if (this.#minLevel > LEVELS.info) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Green, Color.Reset)
        console.log(tagStr + msgStr)
    }

    /**
     * Info with path sanitization and green tag color. Delegates to console.info.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    info(message, tag) {
        if (this.#minLevel > LEVELS.info) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Green, Color.Reset)
        console.info(tagStr + msgStr)
    }

    /**
     * Debug with path sanitization and blue tag color. Delegates to console.log.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    debug(message, tag) {
        if (this.#minLevel > LEVELS.debug) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Blue, Color.Gray)
        console.log(tagStr + msgStr)
    }

    /**
     * Warn with path sanitization and yellow tag color. Delegates to console.warn.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    warn(message, tag) {
        if (this.#minLevel > LEVELS.warn) return
        const { tagStr, msgStr } = this.#format(message, tag, Color.Yellow, Color.Yellow)
        console.warn(tagStr + msgStr)
    }

    /**
     * Error with path sanitization and red tag color. Delegates to console.error.
     * Always emitted regardless of the minimum level threshold.
     * @param {string} message - The log message.
     * @param {string} [tag] - Optional tag for bracketed prefix.
     */
    error(message, tag) {
        const { tagStr, msgStr } = this.#format(message, tag, Color.Red, Color.Yellow)
        console.error(tagStr + msgStr)
    }
}

export default LoggerService