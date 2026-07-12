"use strict"
/**
 * Contrast Image Selector
 *
 * Selects images based on contrast similarity. Extends SelectorBase which handles
 * seed selection and orchestration; this subclass only provides the contrast-specific
 * metric logic and SQL query builder.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import SelectorBase from "./selectorBase.js"

class ContrastSelector extends SelectorBase {
    get selectorName() { return "ContrastSelector" }

    hasValidData(img) {
        return img.contrast !== null && img.contrast !== undefined
    }

    getMetricValue(seed) {
        return seed.contrast
    }

    logSeed(seed) {
        this.logger.log(`Global seed: contrast=${seed.contrast}`, this.selectorName)
    }

    /**
     * Build a similarity query for contrast matching.
     * @param {number} metricValue - Seed contrast value.
     * @param {string} orient - Target orientation.
     * @param {number[]} excludeIds - Image IDs to exclude.
     * @param {number} limit - Max results.
     * @param {number} tolerance - Current tolerance threshold.
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     */
    buildSimilarityQuery(metricValue, orient, excludeIds, limit, tolerance, poolIds = []) {
        let sql = `SELECT * FROM images WHERE ABS(contrast - ?) < ? AND contrast IS NOT NULL`
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
        return this.config.settings.contrastInitialTolerance
    }

    getMaxTolerance() {
        return this.config.settings.contrastMaxTolerance
    }
}

export default ContrastSelector