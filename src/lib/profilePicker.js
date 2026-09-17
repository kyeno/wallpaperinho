"use strict"
/**
 * Profile Picker
 *
 * Pure selection logic for random profile rotation (used by --random / bare
 * invocations). Kept free of fs/logger dependencies so it can be unit-tested
 * with synthetic profile objects and an injectable RNG.
 *
 * Rules:
 *   - A profile is eligible unless it sets `excludeFromRandom: true`.
 *   - When a previously picked name is supplied (`excludeName`) it is removed
 *     from the pool to rotate across runs -- but only when doing so leaves at
 *     least one candidate (a single-profile setup must still work).
 *   - When every profile is excluded, fall back to the implicit default
 *     (first) profile so the app keeps working under cron.
 *   - getProfileAttemptOrder builds an ordered RETRY list for unattended runs that
 *     may need several profiles before finding one with a viable selection pool:
 *     eligible names are shuffled (variety preserved), and the previous pick moves
 *     to the END instead of being dropped entirely (still rotated away in practice,
 *     but reachable as a last resort when every other pool is too small).
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

/** Profile meta-key that opts a profile out of random selection. */
export const RANDOM_EXCLUDE_KEY = "excludeFromRandom"

/**
 * List names of profiles eligible for random selection.
 * @param {Object<string, object>} [profiles={}] - Map of profile name -> settings overrides.
 * @returns {string[]} Eligible profile names (insertion order preserved).
 */
export function getEligibleProfileNames(profiles = {}) {
    return Object.keys(profiles || {}).filter(
        (name) => profiles[name] && profiles[name][RANDOM_EXCLUDE_KEY] !== true
    )
}

/**
 * Pick one profile at random among those not marked `excludeFromRandom`.
 * @param {Object<string, object>} [profiles={}] - Map of profile name -> settings overrides.
 * @param {object} [options={}]
 * @param {Function} [options.rng=Math.random] - Random source returning [0, 1); injectable for tests.
 * @param {string|null} [options.excludeName=null] - Previously picked profile to avoid repeating.
 * @returns {string} Chosen profile name; "" when no profiles are defined at all.
 */
export function selectRandomProfile(profiles = {}, { rng = Math.random, excludeName = null } = {}) {
    let pool = getEligibleProfileNames(profiles)

    // Rotate: skip the last pick unless it is the only candidate left.
    if (excludeName && pool.length > 1) {
        const filtered = pool.filter((name) => name !== excludeName)
        if (filtered.length > 0) {
            pool = filtered
        }
    }

    if (pool.length === 0) {
        // Nothing eligible (or everything excluded) -- fall back to the implicit default
        // so unattended runs never die on an empty selection pool.
        return Object.keys(profiles || {})[0] || ""
    }

    const index = Math.min(pool.length - 1, Math.max(0, Math.floor(rng() * pool.length)))
    return pool[index]
}

/**
 * Build a rotation-aware ATTEMPT ORDER for unattended runs that may walk several
 * profiles before finding one with a viable selection pool:
 *   - eligible profiles are shuffled (injectable rng) so variety is preserved;
 *   - the previously picked profile (`excludeName`) moves to the END instead of
 *     being dropped -- rotated away in practice, yet reachable as a last resort;
 *   - when nothing is eligible, all defined profiles are tried in definition order;
 *   - an empty map yields [] (caller reports "no profiles").
 * @param {Object<string, object>} [profiles={}] - Map of profile name -> settings overrides.
 * @param {{rng?: Function, excludeName?: string|null}} [options={}] - Random source + last successful pick to rotate away from.
 * @returns {string[]} Ordered list of profile names to attempt.
 */
export function getProfileAttemptOrder(profiles = {}, { rng = Math.random, excludeName = null } = {}) {
    const names = Object.keys(profiles || {})
    let pool = getEligibleProfileNames(profiles)
    if (pool.length === 0) return names.slice()

    // Fisher-Yates shuffle -- deterministic under an injected rng (tests).
    const shuffled = pool.slice()
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.max(0, Math.floor(rng() * (i + 1))))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }

    // Rotate the previous pick to the end: variety first, but keep it as a fallback option.
    if (excludeName && shuffled.includes(excludeName)) {
        shuffled.splice(shuffled.indexOf(excludeName), 1)
        shuffled.push(excludeName)
    }
    return shuffled
}