"use strict"
/**
 * Color Palette Image Selector
 *
 * Selects images based on dominant color palette similarity using weighted
 * nearest-color matching. Compares the top-N colors from each image's extracted
 * palette, weighted by pixel-count percentages.
 *
 * Uses client-side scoring (fetches candidates ordered by hue proximity as a
 * pre-filter, then ranks by full palette distance). This provides rich color
 * harmony without requiring complex SQL expressions.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import SelectorBase from "./selectorBase.js"

class ColorPaletteSelector extends SelectorBase {
    get selectorName() { return "ColorPaletteSelector" }

    hasValidData(img) {
        return img.palette != null && img.palette !== "" && img.hue != null
    }

    /**
     * Extract seed metric values used for initial SQL pre-filter.
     * Returns hue for coarse ordering + raw palette string.
     * @param {Object} seed - The seed image record.
     * @returns {{hue: number, palette: string}}
     */
    getMetricValue(seed) {
        return { hue: seed.hue, palette: seed.palette }
    }

    logSeed(seed) {
        const pal = SelectorBase.parsePalette(seed.palette)
        this.logger.log(
            `Global seed: hue=${seed.hue}, ` +
            `palette colors=${pal.length}`, this.selectorName
        )
    }

    // ------------------------------------------------------------------
    // SQL query builders (required by SelectorBase contract)
    // ------------------------------------------------------------------

    /**
     * Build a similarity query that uses hue as a coarse pre-filter,
     * then returns candidates for client-side palette scoring.
     * @param {{hue: number, palette: string}} metricValues
     * @param {string} orient
     * @param {number[]} excludeIds
     * @param {number} limit
     * @param {number} tolerance - Hue distance tolerance (degrees).
     * @param {number[]} [poolIds]
     * @returns {{sql: string, params: (number|string)[]}}
     */
    buildSimilarityQuery(metricValues, orient, excludeIds, limit, tolerance, poolIds = []) {
        const { hue } = metricValues

        // Circular hue distance check: find images within ±tolerance degrees on the color wheel
        const low1 = 0
        const high1 = Math.min(360, hue + tolerance)
        const low2 = Math.max(0, hue - tolerance)
        const high2 = 360

        let sql = `SELECT * FROM images WHERE ` +
            `((hue >= ? AND hue <= ?) OR (hue >= ? AND hue <= ?))` +
            ` AND palette IS NOT NULL AND palette != ''`
        let params = [low1, high1, low2, high2]

        // Orientation filter
        if (orient === "vertical") sql += " AND height > width"
        else if (orient === "horizontal") sql += " AND width > height"
        else if (orient === "square") sql += " AND width = height"

        // Pool filter for chain mode
        const { sql: poolSql, params: poolParams } = this.buildPoolFilterClause(poolIds)
        sql += poolSql
        params.push(...poolParams)

        // Exclude already-used IDs
        if (excludeIds.length > 0) {
            const placeholders = excludeIds.map(() => "?").join(", ")
            sql += ` AND id NOT IN (${placeholders})`
            params.push(...excludeIds)
        }

        // Order by hue proximity for better pre-filtering, then randomize within bands
        sql += ` ORDER BY ABS(hue - ?) LIMIT ?`
        params.push(hue, limit)

        return { sql, params }
    }

    /**
     * Build an ORDER BY distance query using hue as the primary sort key.
     * @param {{hue: number, palette: string}} metricValue
     * @param {string} orient
     * @param {number[]} excludeIds
     * @param {number} limit
     * @param {number[]} [poolIds]
     * @returns {{sql: string, params: (number|string)[]}}
     */
    buildOrderByDistanceQuery(metricValue, orient, excludeIds, limit, poolIds = []) {
        const { hue } = metricValue

        let sql = `SELECT * FROM images WHERE hue IS NOT NULL` +
            ` AND palette IS NOT NULL AND palette != ''`
        let params = []

        if (orient === "vertical") sql += " AND height > width"
        else if (orient === "horizontal") sql += " AND width > height"
        else if (orient === "square") sql += " AND width = height"

        const { sql: poolSql, params: poolParams } = this.buildPoolFilterClause(poolIds)
        sql += poolSql
        params.push(...poolParams)

        if (excludeIds.length > 0) {
            const placeholders = excludeIds.map(() => "?").join(", ")
            sql += ` AND id NOT IN (${placeholders})`
            params.push(...excludeIds)
        }

        // Circular hue distance ordering
        sql += ` ORDER BY MIN(ABS(hue - ?), 360 - ABS(hue - ?)) LIMIT ?`
        params.push(hue, hue, limit)

        return { sql, params }
    }

    getInitialTolerance() {
        return this.config.settings.colorPaletteInitialTolerance || 30
    }

    getMaxTolerance() {
        return this.config.settings.colorPaletteMaxTolerance || 180
    }

    canBeIntermediate() {
        return true
    }

    // ------------------------------------------------------------------
    // Client-side palette scoring override
    // ------------------------------------------------------------------

    /**
     * Override pickImages to apply client-side palette distance ranking.
     * Fetches a broader set of hue-proximate candidates, then scores them
     * by full palette similarity and returns the top-N.
     * @param {Object} seed - The seed image.
     * @param {string} orient - Target orientation.
     * @param {(number|string)[]} excludeIds - IDs/paths to exclude.
     * @param {number} needed - How many images to pick.
     * @param {(number|string)[]} [poolIds] - Optional pool from chain step.
     * @returns {Object[]}
     */
    pickImages(seed, orient, excludeIds, needed, poolIds = []) {
        const metricValues = this.getMetricValue(seed)

        // Fetch a generous batch for client-side scoring
        const fetchLimit = Math.max(needed * 5, 50)
        const tolerance = this.getMaxTolerance()

        const { sql, params } = this.buildSimilarityQuery(
            metricValues, orient, [...excludeIds], fetchLimit, tolerance, poolIds
        )

        this.logger.log(`[${orient}] Fetching ${fetchLimit} candidates for palette scoring`, this.selectorName)

        let candidates
        try {
            candidates = this.db.execute(sql, params) || []
        } catch (err) {
            this.logger.warn(`Query error: ${err.message}`, this.selectorName)
            return []
        }

        if (candidates.length === 0) {
            this.logger.log(`[${orient}] No candidates found`, this.selectorName)
            return []
        }

        // Score each candidate by palette distance to seed
        const scored = candidates.map((img) => ({
            img,
            distance: SelectorBase.calculatePaletteDistance(seed, img)
        }))

        // Sort by palette distance (lower = more similar)
        scored.sort((a, b) => a.distance - b.distance)

        // Apply elite-pool shuffle within top candidates
        const eliteSize = Math.min(scored.length, needed + Math.floor(needed * 0.4))
        const elitePool = scored.slice(0, eliteSize)

        // Shuffle the elite pool for variety
        const shuffled = this.#shuffle(elitePool)
        const result = shuffled.slice(0, needed).map((s) => s.img)

        this.logger.log(
            `[${orient}] Scored ${scored.length}, ` +
            `elite=${eliteSize}, picked=${result.length}`, this.selectorName
        )

        return result
    }

    /**
     * Override collectCandidates for chain mode: fetch hue-proximate candidates
     * then score by palette distance, returning all above a quality threshold.
     */
    collectCandidates(seed, orient, excludeIds, poolIds = []) {
        const metricValues = this.getMetricValue(seed)
        const fetchLimit = 200
        const tolerance = this.getMaxTolerance()

        const { sql, params } = this.buildSimilarityQuery(
            metricValues, orient, [...excludeIds], fetchLimit, tolerance, poolIds
        )

        let candidates
        try {
            candidates = this.db.execute(sql, params) || []
        } catch (err) {
            this.logger.warn(`Collect query error: ${err.message}`, this.selectorName)
            return []
        }

        if (candidates.length === 0) return []

        // Score and sort by palette distance
        const scored = candidates.map((img) => ({
            img,
            distance: SelectorBase.calculatePaletteDistance(seed, img)
        }))
        scored.sort((a, b) => a.distance - b.distance)

        // Return top candidates within acceptable palette distance
        const maxDist = this.config.settings.colorPaletteMaxDistance || 0.5
        const result = scored.filter((s) => s.distance <= maxDist).map((s) => s.img)

        this.logger.log(
            `[${orient}][COLLECT] ` +
            `${scored.length} scored, ${result.length} within dist=${maxDist}`, this.selectorName
        )

        return result
    }

    /** Fisher-Yates shuffle */
    #shuffle(array) {
        const arr = [...array]
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[arr[i], arr[j]] = [arr[j], arr[i]]
        }
        return arr
    }
}

export default ColorPaletteSelector