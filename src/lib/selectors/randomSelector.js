"use strict"
/**
 * Random Image Selector
 *
 * Selects images randomly from orientation pools, excluding already-used paths.
 * Falls back to cross-orientation pools when not enough candidates are available
 * within a single orientation group.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

/**
 * Random Selector Class
 *
 * Picks images randomly from orientation pools, excluding already-used paths.
 * Falls back to cross-orientation pools when not enough candidates are available.
 */
class RandomSelector {
    /**
     * Create a new RandomSelector.
     * @param {DatabaseService} db - Database service instance.
     * @param {ConfigService} config - Configuration service instance.
     * @param {LoggerService} [logger] - Optional logger service instance.
     */
    constructor(db, config, logger) {
        this.db = db
        this.config = config
        this.logger = logger || console
    }

    /**
     * Main selection entry point (async).
     * Picks random images for each orientation independently.
     * @param {{vertical: number, horizontal: number, square: number}} counts - Required image counts per orientation.
     * @returns {Array<{image: Object, orientation: string}>} Selected images with their orientations.
     */
    async select(counts) {
        return this.selectSync(counts)
    }

    /**
     * Synchronous version of select(). Used as fallback by other selectors.
     * @param {{vertical: number, horizontal: number, square: number}} counts - Required image counts per orientation.
     * @returns {Array<{image: Object, orientation: string}>} Selected images with their orientations.
     */
    selectSync(counts) {
        const selectedImages = []
        const usedPaths = new Set()

        // Collect all distinct images upfront so we can exclude them across strategies
        const allDistinctImages = [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ]
        this.logger.log(`Total distinct images in catalog: ${allDistinctImages.length}`, 'RandomSelector')

        for (const orient of ["vertical", "horizontal", "square"]) {
            const needed = counts[orient] || 0
            if (needed === 0) continue

            const poolKey = `${orient}s`
            let pool
            if (orient === "vertical") pool = this.db.findAllVerticalSync()
            else if (orient === "horizontal") pool = this.db.findAllHorizontalSync()
            else pool = this.db.findAllSquareSync()

            this.logger.log(
                `Need ${needed} ${orient} images, ` +
                `pool has ${pool.length}, already-used: ${usedPaths.size}`, 'RandomSelector'
            )

            const picked = this.#pickFromPool(pool, allDistinctImages, usedPaths, needed, orient)
            for (const img of picked) {
                selectedImages.push({ image: img, orientation: orient })
                usedPaths.add(img.path)
            }
        }

        return selectedImages
    }

    /**
     * Pick images from an orientation-specific pool. If the pool is exhausted after
     * excluding used paths, fall back to cross-orientation pools via random selection.
     * @param {Array<Object>} pool - Orientation-specific pool.
     * @param {Array<Object>} allDistinctImages - Full catalog for fallback queries.
     * @param {Set<string>} usedPaths - Paths already assigned to other displays.
     * @param {number} needed - How many images we need.
     * @param {string} orient - Current orientation label ("vertical" | "horizontal" | "square").
     * @returns {Array<Object>} Picked image records.
     */
    #pickFromPool(pool, allDistinctImages, usedPaths, needed, orient) {
        // Filter out already-used paths
        let available = pool.filter((img) => !usedPaths.has(img.path))

        if (available.length === 0 && allDistinctImages.length > 0) {
            this.logger.warn(
                `${orient} pool exhausted (${pool.length} total, ` +
                `${usedPaths.size} used), falling back to random across orientations`, 'RandomSelector'
            )
            return this.#fallbackAcrossOrientations(allDistinctImages, usedPaths, needed, orient)
        } else if (available.length < needed) {
            this.logger.warn(
                `Only ${available.length}/${needed} distinct ${orient} images available, ` +
                `falling back to cross-orientation for remaining ${needed - available.length}`, 'RandomSelector'
            )
            const picked = this.#randomPick(available, available.length, orient)
            const fallbackCount = needed - available.length
            const fallbackResults = this.#fallbackAcrossOrientations(
                allDistinctImages, usedPaths, fallbackCount, orient
            )
            return [...picked, ...fallbackResults.map((r) => r.image)]
        }

        return this.#randomPick(available, needed, orient)
    }

    /**
     * Fallback: when the orientation-specific pool is exhausted, pick randomly from any
     * orientation while excluding already-used paths. Uses DatabaseService's built-in
     * exclusion logic with proper availability tracking.
     * @param {Array<Object>} allDistinctImages - Full catalog of distinct images.
     * @param {Set<string>} usedPaths - Paths already assigned.
     * @param {number} needed - How many more we need.
     * @param {string} orient - Orientation that triggered the fallback (for logging).
     * @returns {Array<{image: Object}>} Fallback selections.
     */
    #fallbackAcrossOrientations(allDistinctImages, usedPaths, needed, orient) {
        // Count truly-available candidates across ALL orientations after exclusions
        const totalAvailable = allDistinctImages.filter((img) => !usedPaths.has(img.path)).length

        if (totalAvailable === 0) {
            this.logger.warn(`All pools exhausted for ${orient}, allowing duplicates`, 'RandomSelector')
            const picked = this.#randomPick(allDistinctImages, needed, `${orient}-dup-fallback`)
            return picked.map((img) => ({ image: img }))
        }

        this.logger.log(
            `Cross-orientation pool has ${totalAvailable}/${needed} ` +
            `candidates available`, 'RandomSelector'
        )

        // Use DB's built-in exclusion logic with proper availability tracking
        const excludeArr = Array.from(usedPaths)
        const { results, totalAvailable: dbTotal } = this.db.findRandomExcluding(excludeArr, needed)

        if (dbTotal < needed && dbTotal > 0) {
            this.logger.warn(
                `Only ${dbTotal}/${needed} images found in cross-orientation pool, ` +
                `allowing duplicates to fill remaining slots`, 'RandomSelector'
            )
            // Take what we got and duplicate-randomly-pick the rest
            const shortfall = needed - dbTotal
            const dupPicks = this.#randomPick(allDistinctImages, shortfall, `${orient}-dup-fill`)
            return [
                ...results.map((img) => ({ image: img })),
                ...dupPicks.map((img) => ({ image: img })),
            ]
        }

        return results.map((img) => ({ image: img }))
    }

    /**
     * Randomly pick N items from a pool. Items may be duplicated when the pool is smaller
     * than the requested count.
     * @param {Array<Object>} pool - Pool of candidate images.
     * @param {number} count - How many to pick.
     * @param {string} label - Label for logging context.
     * @returns {Array<Object>} Picked images.
     */
    #randomPick(pool, count, label) {
        if (pool.length === 0) return []

        const picked = [...pool]
        // Shuffle in-place (Fisher-Yates)
        for (let i = picked.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[picked[i], picked[j]] = [picked[j], picked[i]]
        }

        let result = picked.slice(0, count)

        // If we need more than available, duplicate randomly
        while (result.length < count && picked.length > 0) {
            const extra = picked[Math.floor(Math.random() * picked.length)]
            result.push(extra)
        }

        this.logger.log(`[${label}] Picked ${result.length}/${count}`, 'RandomSelector')
        return result
    }
}

export default RandomSelector