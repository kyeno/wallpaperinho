"use strict"
/**
 * Color HSL Image Selector
 *
 * Selects images based on HSL color distance. Extends SelectorBase which handles
 * seed selection and orchestration; this subclass only provides the color-specific
 * metric logic and SQL query builder.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import SelectorBase from "./selectorBase.js"

class ColorHSLSelector extends SelectorBase {
    get selectorName() { return "ColorHSLSelector" }

    hasValidData(img) {
        return img.hue !== null && img.saturation !== null && img.lightness !== null
    }

    getMetricValue(seed) {
        return { hue: seed.hue, saturation: seed.saturation, lightness: seed.lightness }
    }

    logSeed(seed) {
        this.logger.log(
            `Global seed: hue=${seed.hue}, sat=${seed.saturation}, light=${seed.lightness}`, this.selectorName
        )
    }

    /**
     * Build a similarity query for color matching.
     * @param {{hue: number, saturation: number, lightness: number}} metricValues - Seed HSL values.
     * @param {string} orient - Target orientation.
     * @param {number[]} excludeIds - Image IDs to exclude.
     * @param {number} limit - Max results.
     * @param {number} tolerance - Current tolerance threshold (squared HSL distance).
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     */
    buildSimilarityQuery(metricValues, orient, excludeIds, limit, tolerance, poolIds = []) {
        const { hue, saturation, lightness } = metricValues
        const distanceExpr =
            "(hue - ?)*(hue - ?) + (saturation - ?)*(saturation - ?) + " +
            "(lightness - ?)*(lightness - ?)"

        let sql = `SELECT * FROM images WHERE ${distanceExpr} < ? AND hue IS NOT NULL`
        const params = [hue, hue, saturation, saturation, lightness, lightness, tolerance]

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
        return this.config.settings.colorInitialTolerance
    }

    getMaxTolerance() {
        return this.config.settings.colorMaxTolerance
    }
}

export default ColorHSLSelector
