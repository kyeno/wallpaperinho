"use strict"
/**
 * Selector Base Class
 *
 * Provides common orchestration logic for all strategy-based selectors except RandomSelector.
 * Picks a single random seed image from ALL pools upfront, then iterates orientations
 * finding similar images based on the subclass's metric. When an orientation pool is
 * exhausted or lacks metric data, continues this strategy's own ranking logic across
 * ALL orientations before falling back to RandomSelector for any remaining shortfall.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import RandomSelector from "./randomSelector.js"

/**
 * Abstract base class for similarity-based selectors.
 *
 * Subclasses must implement:
 * - selectorName: string identifier for log messages
 * - hasValidData(img): whether the image has the required metric fields
 * - getMetricValue(seed): extract the metric value(s) from the seed image
 * - buildSimilarityQuery(metricValues, orient, excludePaths, limit): return { sql, params }
 * - logSeed(seed): log the chosen seed's metric values
 */
class SelectorBase {
    /**
     * Create a new SelectorBase.
     * @param {DatabaseService} db - Database service instance.
     * @param {ConfigService} config - Configuration service instance.
     * @param {LoggerService} [logger] - Optional logger service instance.
     */
    constructor(db, config, logger) {
        this.db = db
        this.config = config
        this.logger = logger || console
        this.randomSelector = new RandomSelector(db, config, logger)
    }

    // --- Abstract members (subclasses must override) ---

    get selectorName() { return "SelectorBase" }
    hasValidData(/* img */) { return false }
    getMetricValue(/* seed */) { return null }
    buildSimilarityQuery(/* metricValues, orient, excludePaths, limit, tolerance */) { return { sql: "", params: [] } }
    buildOrderByDistanceQuery(/* metricValue, orient, excludePaths, limit */) { return { sql: "", params: [] } }
    logSeed(/* seed */) {}

    /** Returns true if this selector prefers a single ORDER BY distance query over the tolerance loop. */
    supportsOrderByDistance() { return false }

    /** Subclasses that use the tolerance loop must override to provide their initial tolerance value. */
    getInitialTolerance() { throw new Error(`${this.selectorName} must implement getInitialTolerance()`) }

    /** Subclasses that use the tolerance loop must override to provide their maximum tolerance value. */
    getMaxTolerance() { throw new Error(`${this.selectorName} must implement getMaxTolerance()`) }

    /** Can this selector run as an intermediate step in a chain? Override to false if not. */
    canBeIntermediate() { return true }

    // ---------------------------------------------------------------
    // Shared static utilities
    // ---------------------------------------------------------------

    /**
     * Parse a palette JSON string into an array of color entries.
     * @param {string|null} paletteStr - JSON string of `{r, g, b, count}` objects.
     * @returns {{r: number, g: number, b: number, count: number}[]} Parsed palette, or empty array on failure.
     */
    static parsePalette(paletteStr) {
        if (!paletteStr) return []
        try {
            return JSON.parse(paletteStr)
        } catch {
            return []
        }
    }

    /**
     * Calculate normalized palette distance between two images.
     * Uses weighted nearest-color matching based on pixel count percentages.
     * Lower distance means more similar palettes.
     * @param {Object} base - Source image record with `palette` field.
     * @param {Object} target - Candidate image record with `palette` field.
     * @returns {number} Distance in range [0.0, 1.0]. Returns 0 if either lacks palette data.
     */
    static calculatePaletteDistance(base, target) {
        const basePalette = SelectorBase.parsePalette(base.palette)
        const targetPalette = SelectorBase.parsePalette(target.palette)

        // If either lacks palette data, skip this dimension
        if (basePalette.length === 0 || targetPalette.length === 0) return 0

        // Normalize both palettes to percentage weights by count
        const totalBaseCount = basePalette.reduce((sum, c) => sum + c.count, 0)
        const totalTargetCount = targetPalette.reduce((sum, c) => sum + c.count, 0)

        if (totalBaseCount === 0 || totalTargetCount === 0) return 0

        // Build a color-distance matrix: for each base color, find closest target color
        let weightedDist = 0
        for (const bc of basePalette) {
            const weight = bc.count / totalBaseCount
            let minDist = Infinity
            for (const tc of targetPalette) {
                const dr = bc.r - tc.r
                const dg = bc.g - tc.g
                const db = bc.b - tc.b
                /* Max RGB distance = sqrt(255^2 * 3) ≈ 441 */
                const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441
                if (dist < minDist) minDist = dist
            }
            weightedDist += weight * minDist
        }

        return weightedDist
    }

    // --- Helpers ---

    /**
     * Build a SQL WHERE fragment that restricts results to a set of candidate IDs.
     * Used during strategy chaining to scope queries to a pre-filtered pool.
     * @param {number[]} [poolIds] - Array of image IDs, or null/empty for no restriction.
     * @returns {{sql: string, params: number[]}}
     */
    buildPoolFilterClause(poolIds) {
        if (!poolIds || poolIds.length === 0) {
            return { sql: "", params: [] }
        }
        const placeholders = poolIds.map(() => "?").join(", ")
        return { sql: ` AND id IN (${placeholders})`, params: poolIds }
    }

    /**
     * Collect ALL candidates within acceptable tolerance for a given orientation.
     * Unlike #findBySimilarity this does NOT apply a limit -- it returns everything found.
     * Used by intermediate steps in a strategy chain.
     * @param {Object} seed - The seed image.
     * @param {string} orient - Target orientation.
     * @param {number[]} excludeIds - Image IDs to exclude (already selected).
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     * @returns {Object[]} All matching images as DB rows.
     */
    collectCandidates(seed, orient, excludeIds, poolIds = []) {
        if (this.supportsOrderByDistance()) {
            return this.#collectByDistance(seed, orient, excludeIds, poolIds)
        }
        return this.#collectByTolerance(seed, orient, excludeIds, poolIds)
    }

    /**
     * Core tolerance-expansion engine. Both collect and pick modes delegate here.
     * @param {Object} seed - The seed image.
     * @param {string} orient - Target orientation.
     * @param {number[]} excludeIds - Image IDs to exclude.
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     * @param {{targetCount?: number, earlyStopMin?: number, batchLimit?: number}} options
     *   - targetCount: undefined -> no hard cap (collect mode), N -> stop at N found (pick mode)
     *   - earlyStopMin: if set, stops at first viable tolerance with >= this count (collect mode)
     *   - batchLimit: SQL LIMIT per iteration (default 50 for collect, computed for pick)
     * @returns {Object[]} Array of matching images.
     */
    #toleranceExpand(seed, orient, excludeIds, poolIds, options = {}) {
        const { targetCount, earlyStopMin, batchLimit: defaultBatchLimit = 50 } = options
        const suffix = targetCount !== undefined ? `/${targetCount}` : ''

        const metricValues = this.getMetricValue(seed)
        let tolerance = this.getInitialTolerance()
        const maxTolerance = this.getMaxTolerance()
        const found = new Map()
        let lastSuccessfulTolerance = null
        let earlyStopTriggered = false

        while (tolerance <= maxTolerance) {
            // Determine batch limit for this iteration
            let batchLimit
            if (targetCount !== undefined) {
                batchLimit = Math.min(targetCount - found.size, defaultBatchLimit)
            } else {
                batchLimit = defaultBatchLimit
            }

            const { sql, params } = this.buildSimilarityQuery(
                metricValues, orient, [...excludeIds, ...found.keys()], batchLimit, tolerance, poolIds
            )

            const prevCount = found.size
            this.logger.debug(`[${orient}] Starting with tolerance: ${tolerance}, already found: ${prevCount}${suffix}`, this.selectorName)

            try {
                const results = this.db.execute(sql, params) || []
                if (results.length === 0) break
                for (const img of results) {
                    if (!found.has(img.id) && !excludeIds.includes(img.id)) {
                        found.set(img.id, img)
                    }
                }
                lastSuccessfulTolerance = tolerance
            } catch (err) {
                this.logger.warn(`Query error at tolerance ${tolerance}: ${err.message}`, this.selectorName)
            }

            // Pick mode: stop when we've reached the target count
            if (targetCount !== undefined && found.size >= targetCount) {
                break
            }

            // Collect mode: stop at first viable tolerance that returned >= earlyStopMin
            if (earlyStopMin !== undefined && prevCount < earlyStopMin && found.size >= earlyStopMin && !earlyStopTriggered) {
                //console.log(`[${this.selectorName}][${orient}][DEBUG] Loop stopped -- first viable tolerance ${tolerance}`)
                earlyStopTriggered = true
                break
            }

            tolerance *= 2
        }

        let result = Array.from(found.values())
        if (targetCount !== undefined) {
            result = result.slice(0, targetCount)
        }

        this.logger.debug(
            `[${orient}] Total: ${result.length}${suffix || ''}` +
            (lastSuccessfulTolerance !== null ? ` (final tolerance: ${lastSuccessfulTolerance})` : " (no matches)"),
            this.selectorName
        )
        return result
    }

    /**
     * Tolerance-expanding collection without a hard limit. Returns all matches.
     * Stops as soon as the first viable tolerance level returns >=2 images,
     * ensuring minimal tolerance is used while still getting a reasonable pool.
     */
    #collectByTolerance(seed, orient, excludeIds, poolIds) {
        return this.#toleranceExpand(seed, orient, excludeIds, poolIds, {
            earlyStopMin: 2,
            batchLimit: 50
        })
    }

    /**
     * Pick exactly N images via tolerance-expanding query within an optional pool.
     * @param {Object} seed - The seed image.
     * @param {string} orient - Target orientation.
     * @param {number[]} excludeIds - Image IDs to exclude.
     * @param {number} needed - How many images to pick.
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     * @returns {Object[]} Array of matching images (up to `needed`).
     */
    pickImages(seed, orient, excludeIds, needed, poolIds = []) {
        if (this.supportsOrderByDistance()) {
            return this.pickImagesNearest(seed, orient, excludeIds, needed, poolIds)
        }
        return this.#toleranceExpand(seed, orient, excludeIds, poolIds, {
            targetCount: needed,
            batchLimit: 10
        })
    }

    /**
     * Pick exactly N nearest images using a single ORDER BY distance query.
     * @param {Object} seed - The seed image.
     * @param {string} orient - Target orientation.
     * @param {number[]} excludeIds - Image IDs to exclude.
     * @param {number} needed - How many images to pick.
     * @param {number[]} [poolIds] - Optional pool of candidate IDs from previous chain step.
     * @returns {Object[]} Array of matching images (up to `needed`).
     */
    pickImagesNearest(seed, orient, excludeIds, needed, poolIds = []) {
        const metricValue = this.getMetricValue(seed)
        const { sql, params } = this.buildOrderByDistanceQuery(
            metricValue, orient, [...excludeIds], needed, poolIds
        )

        this.logger.log(`[${orient}] Nearest-by-distance, need ${needed}`, this.selectorName)

        try {
            const results = this.db.execute(sql, params) || []
            this.logger.log(
                `[${orient}] Found ${results.length}/${needed} ` +
                `(nearest-by-distance)`, this.selectorName
            )
            return results.slice(0, needed)
        } catch (err) {
            this.logger.warn(`Query error: ${err.message}`, this.selectorName)
            return []
        }
    }

    /**
     * Distance-based collection. Returns nearest images without a hard limit.
     */
    #collectByDistance(seed, orient, excludeIds, poolIds) {
        const metricValue = this.getMetricValue(seed)
        // Fetch all from the pool ordered by distance; caller decides how many to keep
        const { sql, params } = this.buildOrderByDistanceQuery(
            metricValue, orient, [...excludeIds], 9999, poolIds
        )

        try {
            const results = this.db.execute(sql, params) || []
            this.logger.log(`[${orient}][COLLECT] Nearest-by-distance candidates: ${results.length}`, this.selectorName)
            return results
        } catch (err) {
            this.logger.warn(`Collect query error: ${err.message}`, this.selectorName)
            return []
        }
    }


    /** Determine an image's natural orientation. */
    static getOrientation(img) {
        if (img.height > img.width) return "vertical"
        if (img.width > img.height) return "horizontal"
        return "square"
    }

    /** Fetch the pool for a given orientation. */
    getPool(orient) {
        if (orient === "vertical") return this.db.findAllVerticalSync()
        if (orient === "horizontal") return this.db.findAllHorizontalSync()
        return this.db.findAllSquareSync()
    }

    // --- Common select logic ---

    /**
     * Main selection entry point.
     * Picks ONE random seed from all pools, then finds similar images per orientation.
     * @param {{vertical: number, horizontal: number, square: number}} counts - Required counts.
     * @returns {Array<{image: Object, orientation: string}>} Selected images with orientations.
     */
    async select(counts) {
        const allDistinct = [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ]
        this.logger.log(`Total distinct images in catalog: ${allDistinct.length}`, this.selectorName)

        // Pick ONE random seed from ALL images that have valid metric data
        const allWithData = allDistinct.filter((img) => this.hasValidData(img))

        if (allWithData.length === 0) {
            this.logger.warn(`No images with valid metric data -- falling back to random`, this.selectorName)
            return this.randomSelector.selectSync(counts)
        }

        const seed = allWithData[Math.floor(Math.random() * allWithData.length)]
        this.logSeed(seed)

        const selectedImages = []
        // Track both IDs (for SQL exclusion in queries) and paths (for deduplication checks)
        const usedIds = new Set([seed.id])
        const usedPaths = new Set([seed.path])

        // Determine the seed's natural orientation and include it first
        const seedOrient = SelectorBase.getOrientation(seed)
        selectedImages.push({ image: seed, orientation: seedOrient, _isSeed: true })

        for (const orient of ["vertical", "horizontal", "square"]) {
            // Subtract 1 if this is the seed's orientation (already selected)
            let needed = (counts[orient] || 0) - (orient === seedOrient ? 1 : 0)
            if (needed <= 0) continue

            const pool = this.getPool(orient)
            const available = pool.filter((img) => !usedPaths.has(img.path))
            const poolWithData = available.filter((img) => this.hasValidData(img))

            this.logger.log(
                `Need ${needed} ${orient}, ` +
                `pool has ${available.length}, with data: ${poolWithData.length}`, this.selectorName
            )

            // No candidates at all in this orientation -- score across orientations, then random
            if (available.length === 0) {
                for (const entry of this.#fillCrossOrRandom(seed, orient, needed, usedIds, usedPaths)) {
                    selectedImages.push(entry)
                }
                continue
            }

            // Candidates exist but none have metric data -- score across orientations, then random
            if (poolWithData.length === 0) {
                this.logger.warn(`No ${orient} candidates have valid data -- scoring cross-orientation pool`, this.selectorName)
                for (const entry of this.#fillCrossOrRandom(seed, orient, needed, usedIds, usedPaths)) {
                    selectedImages.push(entry)
                }
                continue
            }

            // Not enough available images in this orientation -- find what we can, then fallback
            if (available.length < needed) {
                this.logger.warn(
                    `Only ${available.length}/${needed} distinct ${orient} images available`, this.selectorName
                )
                const found = this.#findBySimilarity(seed, Math.min(needed, available.length), orient, [...usedIds])
                for (const img of found) {
                    selectedImages.push({ image: img, orientation: orient })
                    usedIds.add(img.id)
                    usedPaths.add(img.path)
                }
                const stillNeeded = needed - found.length
                if (stillNeeded > 0) {
                    for (const entry of this.#fillCrossOrRandom(seed, orient, stillNeeded, usedIds, usedPaths)) {
                        selectedImages.push(entry)
                    }
                }
                continue
            }

            // Normal path: find similar images within tolerance
            const found = this.#findBySimilarity(seed, needed, orient, [...usedIds])
            for (const img of found) {
                selectedImages.push({ image: img, orientation: orient })
                usedIds.add(img.id)
                usedPaths.add(img.path)
            }
        }

        return selectedImages
    }

    /**
     * Fill slots that the matching-orientation pool could not cover by continuing THIS
     * strategy's own ranking logic across ALL orientations ("any"), falling back to
     * RandomSelector only for whatever remains unfilled. Mutates usedIds/usedPaths as picks land.
     * @param {Object} seed - The seed image (must have valid data for this strategy).
     * @param {string} orient - Requested orientation label; results are tagged with it and it is used in logs.
     * @param {number} needed - How many images are required.
     * @param {Set<number>} usedIds - IDs already selected (mutated).
     * @param {Set<string>} usedPaths - Paths already selected (mutated).
     * @returns {{image: Object, orientation: string}[]} Entries tagged with `orient`.
     */
    #fillCrossOrRandom(seed, orient, needed, usedIds, usedPaths) {
        const allDistinct = [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ]
        // Only rows this strategy can actually score, minus anything already assigned
        const crossPool = allDistinct.filter((img) => !usedPaths.has(img.path) && this.hasValidData(img))
        const entries = []

        if (crossPool.length > 0) {
            this.logger.log(
                `[CROSS] ${orient} pool exhausted -- scoring ${crossPool.length} cross-orientation candidates`,
                this.selectorName
            )
            try {
                const found = this.pickImages(seed, "any", [...usedIds], needed, crossPool.map((i) => i.id)) || []
                for (const img of found) {
                    if (!usedIds.has(img.id)) {
                        entries.push({ image: img, orientation: orient })
                        usedIds.add(img.id)
                        usedPaths.add(img.path)
                    }
                }
            } catch (err) {
                this.logger.warn(`[CROSS] scored pick failed (${err.message}) -- using random fallback`, this.selectorName)
            }
        } else {
            this.logger.warn("No scoreable images anywhere -- falling back to random", this.selectorName)
        }

        // Random last resort for any remaining shortfall
        const stillNeeded = needed - entries.length
        if (stillNeeded > 0) {
            const fallback = this.randomSelector.selectSync({ [orient]: stillNeeded }, [...usedPaths])
            for (const s of fallback) {
                entries.push(s)
                usedIds.add(s.image.id)
                usedPaths.add(s.image.path)
            }
        }
        return entries
    }

    /**
     * Find images similar to the seed. Uses ORDER BY distance query if supported,
     * otherwise falls back to expanding tolerance loop.
     * @param {Object} seed - The seed image.
     * @param {number} needed - How many images are required.
     * @param {string} orient - Target orientation ("vertical" | "horizontal" | "square").
     * @param {number[]} excludeIds - Image IDs to exclude from results.
     * @returns {Object[]} Array of matching images.
     */
    #findBySimilarity(seed, needed, orient, excludeIds) {
        // If selector supports order-by-distance, do a single sorted query
        if (this.supportsOrderByDistance()) {
            return this.#findByDistance(seed, needed, orient, excludeIds)
        }

        // Traditional tolerance-expanding approach
        const metricValues = this.getMetricValue(seed)
        let tolerance = this.getInitialTolerance()
        const maxTolerance = this.getMaxTolerance()
        let found = []

        while (found.length < needed && tolerance <= maxTolerance) {
            const limit = Math.min(needed - found.length, 10)
            const { sql, params } = this.buildSimilarityQuery(
                metricValues, orient, [...excludeIds, ...found.map((i) => i.id)], limit, tolerance
            )

            this.logger.log(`[${orient}] Tolerance: ${tolerance}, need ${needed - found.length}`, this.selectorName)

            try {
                const results = this.db.execute(sql, params)
                if (results && results.length > 0) {
                    for (const img of results) {
                        if (!found.some((f) => f.id === img.id) && !excludeIds.includes(img.id)) {
                            found.push(img)
                        }
                    }
                }
            } catch (err) {
                this.logger.warn(`Query error at tolerance ${tolerance}: ${err.message}`, this.selectorName)
            }

            if (found.length < needed) {
                tolerance *= 2
            }
        }

        this.logger.log(
            `[${orient}] Found ${found.length}/${needed} ` +
            `(final tolerance: ${tolerance})`, this.selectorName
        )

        return found.slice(0, needed)
    }

    /**
     * Find nearest images to the seed using a single ORDER BY distance query.
     * Used by selectors like EntropySelector where values are dense and continuous.
     * @param {Object} seed - The seed image.
     * @param {number} needed - How many images are required.
     * @param {string} orient - Target orientation ("vertical" | "horizontal" | "square").
     * @param {number[]} excludeIds - Image IDs to exclude from results.
     * @returns {Object[]} Array of matching images.
     */
    #findByDistance(seed, needed, orient, excludeIds) {
        const metricValue = this.getMetricValue(seed)
        const { sql, params } = this.buildOrderByDistanceQuery(metricValue, orient, [...excludeIds], needed)

        this.logger.log(`[${orient}] Nearest-by-distance, need ${needed}`, this.selectorName)

        try {
            const results = this.db.execute(sql, params) || []
            this.logger.log(
                `[${orient}] Found ${results.length}/${needed} ` +
                `(nearest-by-distance)`, this.selectorName
            )
            return results.slice(0, needed)
        } catch (err) {
            this.logger.warn(`Query error: ${err.message}`, this.selectorName)
            return []
        }
    }

}

export default SelectorBase
