"use strict"
/**
 * Canny Edge Density Selector
 *
 * Selects images based on Canny edge density similarity. Extends SelectorBase which handles
 * seed selection and orchestration; this subclass only provides the canny-specific
 * metric logic and SQL query builder.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import SelectorBase from "./selectorBase.js"

class CannySelector extends SelectorBase {
    get selectorName() { return "CannySelector" }

    hasValidData(img) {
        return img.canny !== null && img.canny !== undefined
    }

    getMetricValue(seed) {
        return seed.canny
    }

    logSeed(seed) {
        this.logger.log(`Global seed: canny=${seed.canny}`, this.selectorName)
    }

    /**
     * Build a similarity query for Canny edge density matching.
     * @param {number} metricValue - Seed canny value.
     * @param {string} orient - Target orientation.
     * @param {number[]} excludeIds - Image IDs to exclude.
     * @param {number} limit - Max results.
     * @param {number} tolerance - Current tolerance threshold.
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     */
    buildSimilarityQuery(metricValue, orient, excludeIds, limit, tolerance, poolIds = []) {
        let sql = `SELECT * FROM images WHERE ABS(canny - ?) < ? AND canny IS NOT NULL`
        const params = [metricValue, tolerance]

        // Filter by orientation
        if (orient === "vertical") sql += " AND height > width"
        else if (orient === "horizontal") sql += " AND width > height"
        else if (orient === "square") sql += " AND width = height"

        // Pool filter -- restrict to candidates from previous chain step
        const { sql: poolSql, params: poolParams } = this.buildPoolFilterClause(poolIds)
        sql += poolSql
        params.push(...poolParams)

        // Exclude already-used IDs
        if (excludeIds.length > 0) {
            const placeholders = excludeIds.map(() => "?").join(", ")
            sql += ` AND id NOT IN (${placeholders})`
            params.push(...excludeIds)
        }

        sql += " ORDER BY RANDOM() LIMIT ?"
        params.push(limit)

        return { sql, params }
    }

    getInitialTolerance() {
        return this.config.settings.cannyInitialTolerance
    }

    getMaxTolerance() {
        return this.config.settings.cannyMaxTolerance
    }
}

export default CannySelector