"use strict"
/**
 * Display Configuration Validation
 *
 * Pure validation for the merged `displays` setting ([width, height] tuples per
 * monitor). Lives in lib/ so both service-layer (ConfigService) and lib-layer
 * (DisplayAssignment) consumers can enforce it without pulling etc/*.js loading
 * or other services into their dependency graph.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

/** Thrown when the merged displays configuration is malformed; message names every offending entry. */
export class ConfigValidationError extends Error {}

/** Compact rendering of an offending value for error messages (JSON when possible). */
function describeValue(value) {
    try {
        const rendered = JSON.stringify(value)
        return rendered === undefined ? String(value) : rendered
    } catch {
        return String(value)
    }
}

/**
 * Validate display dimensions: must be a non-empty array of [width, height] pairs
 * whose entries are finite positive integers (pixels). Reports EVERY problem found
 * with its index, so users fix all bad entries in one pass instead of iterating.
 * @param {*} displays - Value of settings.displays after base+profile+CLI merging.
 * @returns {*[]} The validated input, unchanged.
 * @throws {ConfigValidationError} When any part of the setting is malformed.
 */
export function validateDisplays(displays) {
    if (!Array.isArray(displays) || displays.length === 0) {
        throw new ConfigValidationError(
            `invalid "displays" configuration: expected a non-empty array of ` +
            `[width, height] pixel tuples (e.g., [[1920, 1080], [1080, 1920]]), got ${describeValue(displays)}. ` +
            `Check etc/config.js and profile overrides in etc/profiles.js.`
        )
    }

    const problems = []
    for (let i = 0; i < displays.length; i++) {
        const entry = displays[i]
        if (!Array.isArray(entry) || entry.length !== 2) {
            problems.push(`displays[${i}]: expected a [width, height] pair, got ${describeValue(entry)}`)
            continue
        }
        const [w, h] = entry
        if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
            problems.push(`displays[${i}]: width/height must be positive integers, got [${String(w)}, ${String(h)}]`)
        }
    }

    if (problems.length > 0) {
        throw new ConfigValidationError(
            'invalid "displays" configuration - check etc/config.js and profile overrides in etc/profiles.js:\n  - ' +
            problems.join("\n  - ")
        )
    }

    return displays
}