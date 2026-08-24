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