"use strict"
/**
 * Entropy Selector
 *
 * Selects images whose entropy is closest to a randomly chosen seed image's entropy.
 * Unlike tolerance-based selectors, this uses ORDER BY ABS(entropy - seedEntropy) ASC
 * to find the nearest matches in a single query per orientation.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import SelectorBase from "./selectorBase.js"

class EntropySelector extends SelectorBase {
    get selectorName() { return "EntropySelector" }

    /** Check whether an image has valid entropy data. */
    hasValidData(img) {
        return img.entropy !== null && img.entropy !== undefined
    }

    /** Extract the entropy value from the seed image. */
    getMetricValue(seed) {
        return seed.entropy
    }

    /** Log the chosen seed's entropy for debugging. */
    logSeed(seed) {
        this.logger.log(`Seed entropy: ${seed.entropy} (${seed.path})`, this.selectorName)
    }

    /** This selector prefers order-by-distance over the tolerance loop. */
    supportsOrderByDistance() { return true }

    /** Entropy can only be used as the final step in a chain (needs concrete counts). */
    canBeIntermediate() { return false }

    /**
     * Build an ORDER BY distance query to find images with entropy nearest to the seed.
     * @param {number} seedEntropy - The seed image's entropy value.
     * @param {string} orient - Target orientation ("vertical" | "horizontal" | "square").
     * @param {number[]} excludeIds - Image IDs to exclude from results.
     * @param {number} limit - Maximum number of results to return.
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     * @returns {{sql: string, params: Array}} SQL and parameters.
     */
    buildOrderByDistanceQuery(seedEntropy, orient, excludeIds, limit, poolIds = []) {
        let sql = `SELECT * FROM images WHERE entropy IS NOT NULL`
        const params = []

        // Orientation filter
        if (orient === "vertical") {
            sql += " AND height > width"
        } else if (orient === "horizontal") {
            sql += " AND width > height"
        } else if (orient === "square") {
            sql += " AND width = height"
        }

        // Pool filter -- restrict to candidates from previous chain step
        const { sql: poolSql, params: poolParams } = this.buildPoolFilterClause(poolIds)
        sql += poolSql
        params.push(...poolParams)

        // Subdirectory-mode scope -- restrict results to the configured selection pool
        const { sql: scopeSql, params: scopeParams } = this.buildScopeFilterClause()
        sql += scopeSql
        params.push(...scopeParams)

        // Exclude already-used IDs
        if (excludeIds.length > 0) {
            const placeholders = excludeIds.map(() => "?").join(", ")
            sql += ` AND id NOT IN (${placeholders})`
            params.push(...excludeIds)
        }

        // Order by distance to seed entropy, ascending
        sql += " ORDER BY ABS(entropy - ?) ASC LIMIT ?"
        params.push(seedEntropy, limit)

        return { sql, params }
    }

    /** Fallback similarity query (not used when supportsOrderByDistance is true). */
    buildSimilarityQuery(/* metricValue, orient, excludeIds, limit, tolerance, poolIds */) {
        return { sql: "", params: [] }
    }
}

export default EntropySelector