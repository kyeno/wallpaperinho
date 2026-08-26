"use strict"
/**
 * GeminiQwenSelector - Pairwise Harmony Optimized Vector Proximity Selector.
 *
 * Built by Gemini AI + Qwen collaboration. Maps HSL color spaces alongside
 * structural complexity, lighting contrast, spatial entropy, and dominant palette
 * into a balanced, human-perception-weighted vector space. Uses greedy pairwise
 * harmony optimization so each pick maximizes overall group cohesion rather than
 * optimizing only against a single seed image.
 *
 * @extends {SelectorBase}
 * @author Ratan M. Kyeno (AI-assisted)
 * @license MIT
 */

import SelectorBase from "./selectorBase.js"

export default class GeminiQwenSelector extends SelectorBase {
    /**
     * Perceptual feature weights for composite distance calculation.
     * Tweak these to adjust the engine's balancing profile.
     * @private
     * @type {{hue: number, saturation: number, lightness: number, contrast: number, canny: number, entropy: number, palette: number}}
     */
    #weights = {
        hue: 5.0,         // Dominant color tone harmony (Critical)
        saturation: 1.2,  // Color vividness/intensity compatibility
        lightness: 2.0,   // Exposure/brightness matching (Crucial for dual monitors)
        contrast: 2.5,    // Chiaroscuro/lighting drama matching
        canny: 2.5,       // Geometric composition and line density matching
        entropy: 2.0,     // Micro-texture, film grain, and atmospheric busyness
        palette: 3.0      // Dominant color palette overlap (RGB histogram similarity)
    }

    /**
     * Accumulated list of all images selected so far during pairwise harmony runs.
     * Used as anchor references for greedy selection.
     * @private
     * @type {Object[]}
     */
    #selectedImages = []

    /**
     * Human-readable selector identifier used in log messages.
     * @returns {string}
     */
    get selectorName() { return "GeminiQwenSelector" }

    /**
     * Create a new GeminiQwenSelector instance.
     * @param {import("../services/databaseService.js").default} db - Database service instance.
     * @param {import("../services/configService.js").default} config - Configuration service instance.
     * @param {LoggerService} [logger] - Optional logger service instance.
     */
    constructor(db, config, logger) {
        super(db, config, logger)
        if (config.geminiSelectorWeights) {
            this.#weights = { ...this.#weights, ...config.geminiSelectorWeights }
        }
    }

    // ---------------------------------------------------------------
    // Abstract member implementations
    // ---------------------------------------------------------------

    /**
     * Checks if an image record contains all necessary statistical metrics.
     * @param {Object} img - Image record from the database.
     * @returns {boolean} True if the image has valid metric data.
     */
    hasValidData(img) {
        return img.hue != null &&
               img.saturation != null &&
               img.lightness != null &&
               img.contrast != null &&
               img.canny != null &&
               img.entropy != null
    }

    /**
     * Log the chosen seed image's metric values.
     * @param {Object} seed - The selected seed image.
     */
    logSeed(seed) {
        this.logger.log(
            `Seed: H=${seed.hue}, S=${seed.saturation}, ` +
            `L=${seed.lightness}, C=${seed.contrast}, E=${seed.entropy?.toFixed(3)}, K=${seed.canny}`,
            this.selectorName
        )
    }

    // ---------------------------------------------------------------
    // Composite distance calculation
    // ---------------------------------------------------------------

    /**
     * Unified Vector Space Distance with dynamic bounds normalization.
     * Combines HSL color matrices, structural metrics, lighting contrast,
     * spatial entropy, and palette similarity into a single perceptual score.
     * @param {Object} base - Source image record.
     * @param {Object} target - Candidate image record.
     * @returns {number} Composite Euclidean distance (lower = more similar).
     * @private
     */
    #calculateCompositeDistance(base, target) {
        // --- 1. COLOR MATRICES (HSL) ---
        const deltaHueRaw = 180 - Math.abs(180 - Math.abs((target.hue || 0) - (base.hue || 0)))
        const normHue = deltaHueRaw / 180 // Normalized to 0.0 - 1.0

        const normSat = Math.abs((target.saturation || 0) - (base.saturation || 0)) / 100
        const normLight = Math.abs((target.lightness || 0) - (base.lightness || 0)) / 100

        // --- 2. STRUCTURAL & LIGHTING MATRICES ---
        /* Contrast normalized by 50 (typical real-world operational maximum limit) */
        const normContrast = Math.abs((target.contrast || 0) - (base.contrast || 0)) / 50

        /* Canny normalized by 12 (true integer scale for edge density percentage) */
        const normCanny = Math.abs((target.canny || 0) - (base.canny || 0)) / 12

        /* Entropy natively operates on a clean 0.0 - 1.0 floating point scale */
        const normEntropy = Math.abs((target.entropy || 0) - (base.entropy || 0))

        /* Palette distance is already normalized to 0.0 - 1.0 */
        const normPalette = SelectorBase.calculatePaletteDistance(base, target)

        // --- 3. PERCEPTUAL DISTANCE SUMMATION ---
        const totalDistance =
            (normHue * normHue * this.#weights.hue) +
            (normSat * normSat * this.#weights.saturation) +
            (normLight * normLight * this.#weights.lightness) +
            (normContrast * normContrast * this.#weights.contrast) +
            (normCanny * normCanny * this.#weights.canny) +
            (normEntropy * normEntropy * this.#weights.entropy) +
            (normPalette * normPalette * this.#weights.palette)

        return Math.sqrt(totalDistance)
    }

    // ---------------------------------------------------------------
    // Selection algorithms
    // ---------------------------------------------------------------

    /**
     * Fisher-Yates shuffle - returns a new shuffled array without mutating the original.
     * @param {Object[]} array - Array to shuffle.
     * @returns {Object[]} New shuffled copy of the input array.
     * @private
     */
    #shuffle(array) {
        const arr = [...array]
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[arr[i], arr[j]] = [arr[j], arr[i]]
        }
        return arr
    }

    /**
     * Greedy pairwise harmony selection.
     *
     * Instead of scoring each candidate against a single seed, this builds the set
     * greedily: at each step it picks the image that minimizes its average distance
     * to ALL already-selected images. This prevents "drift" where later monitors get
     * images close to the seed but far from earlier monitors' images.
     *
     * @param {Object[]} candidates - Pool of candidate images to choose from.
     * @param {Set<string>} usedPaths - Set of file paths already assigned to displays.
     * @param {number} count - Number of images to pick.
     * @param {string} orientation - Target orientation label for logging.
     * @returns {{img: Object, avgDistance: number}[]} Array of picked image objects.
     * @private
     */
    #pairwiseHarmonySelect(candidates, usedPaths, count, orientation) {
        if (!candidates || candidates.length === 0 || count <= 0) return []

        const anchorGroup = this.#selectedImages || []
        this.logger.log(
            `Harmony: need=${count} orient=${orientation} anchors=${anchorGroup.length}`,
            this.selectorName
        )

        const picked = []
        const remaining = [...candidates].filter(img => !usedPaths.has(img.path))

        while (picked.length < count && remaining.length > 0) {
            const scored = remaining.map(img => {
                const refs = [...anchorGroup, ...picked.map(p => p.img)]
                if (refs.length === 0) {
                    return { img, avgDistance: Infinity }
                }
                let totalDist = 0
                for (const ref of refs) {
                    totalDist += this.#calculateCompositeDistance(ref, img)
                }
                return { img, avgDistance: totalDist / refs.length }
            })

            scored.sort((a, b) => a.avgDistance - b.avgDistance)

            const eliteSize = Math.min(remaining.length, Math.max(count - picked.length, 3))
            const elitePool = scored.slice(0, eliteSize)

            this.logger.log(
                `  Pick ${picked.length + 1}: ` +
                `avgDist=${scored[0].avgDistance.toFixed(4)} (from ${eliteSize})`,
                this.selectorName
            )

            const shuffled = this.#shuffle(elitePool).slice(0, 1)[0]
            picked.push(shuffled)
            usedPaths.add(shuffled.img.path)
            remaining.splice(remaining.findIndex(r => r.id === shuffled.img.id), 1)
        }

        return picked.map(p => p.img)
    }

    /**
     * Legacy single-seed selection (kept for chain mode compatibility).
     * Scores each candidate against one base image and picks from an elite pool.
     * @param {Object[]} pool - Candidate images to choose from.
     * @param {Object|null} baseImage - Reference image for scoring, or null for random pick.
     * @param {number} count - Number of images to select.
     * @param {string} _orientation - Target orientation label (unused but kept for signature compat).
     * @returns {Object[]} Array of selected image objects.
     * @private
     */
    #selectFromPool(pool, baseImage, count, _orientation) {
        if (!pool || pool.length === 0) return []

        let validPool = pool.filter(img => this.hasValidData(img))
        if (validPool.length === 0) return []

        if (!baseImage) {
            return this.#shuffle(validPool).slice(0, count)
        }

        this.logSeed(baseImage)

        const scoredPool = validPool.map(img => ({
            img,
            distance: this.#calculateCompositeDistance(baseImage, img)
        }))

        scoredPool.sort((a, b) => a.distance - b.distance)
        const sortedImages = scoredPool.map(item => item.img)

        const elitePoolSize = Math.min(sortedImages.length, count + 2)
        const elitePool = sortedImages.slice(0, elitePoolSize)

        this.logger.log(`Elite pool: size=${elitePoolSize}, picking=${count}`, this.selectorName)

        return this.#shuffle(elitePool).slice(0, count)
    }

    // ---------------------------------------------------------------
    // Public API - overrides of SelectorBase contract
    // ---------------------------------------------------------------

    /**
     * Override SelectorBase.select() to use pairwise harmony optimization.
     * Picks one random seed from all pools, then greedily selects images per orientation
     * that maximize overall group cohesion.
     * @param {{vertical: number, horizontal: number, square: number}} counts - Required image counts per orientation.
     * @returns {Promise<Array<{image: Object, orientation: string}>>} Selected images with orientations.
     */
    async select(counts) {
        const allDistinct = [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ]
        this.logger.log(`Catalog: ${allDistinct.length} images`, this.selectorName)

        const allWithData = allDistinct.filter((img) => this.hasValidData(img))

        if (allWithData.length === 0) {
            this.logger.warn(`No valid data -> random fallback`, this.selectorName)
            return this.randomSelector.selectSync(counts)
        }

        const seed = allWithData[Math.floor(Math.random() * allWithData.length)]
        this.logSeed(seed)

        const selectedImages = []
        const usedIds = new Set([seed.id])
        const usedPaths = new Set([seed.path])

        const seedOrient = SelectorBase.getOrientation(seed)
        selectedImages.push({ image: seed, orientation: seedOrient, _isSeed: true })

        this.#selectedImages = [...selectedImages.map(s => s.image)]

        for (const orient of ["vertical", "horizontal", "square"]) {
            let needed = (counts[orient] || 0) - (orient === seedOrient ? 1 : 0)
            if (needed <= 0) continue

            const pool = this.getPool(orient)
            const available = pool.filter((img) => !usedPaths.has(img.path))
            const poolWithData = available.filter((img) => this.hasValidData(img))

            this.logger.log(
                `Need ${needed} ${orient}: ` +
                `avail=${available.length}, valid=${poolWithData.length}`,
                this.selectorName
            )

            // No candidates at all in this orientation -- score across orientations, then random
            if (available.length === 0) {
                for (const entry of this.#fillCrossOrRandom(orient, needed, usedIds, usedPaths)) {
                    selectedImages.push(entry)
                }
                continue
            }

            // Candidates exist but none have metric data -- score across orientations, then random
            if (poolWithData.length === 0) {
                this.logger.warn(`No valid ${orient} data -> scoring cross-orientation pool`, this.selectorName)
                for (const entry of this.#fillCrossOrRandom(orient, needed, usedIds, usedPaths)) {
                    selectedImages.push(entry)
                }
                continue
            }

            // Short supply: pick what we can, then fallback for the rest
            if (available.length < needed) {
                this.logger.warn(
                    `Short supply: ${available.length}/${needed} for ${orient}`, this.selectorName
                )
                const found = this.#pairwiseHarmonySelect(
                    available, usedPaths, Math.min(needed, available.length), orient
                )
                for (const img of found) {
                    selectedImages.push({ image: img, orientation: orient })
                    usedIds.add(img.id)
                    usedPaths.add(img.path)
                    this.#selectedImages.push(img)
                }
                const stillNeeded = needed - found.length
                if (stillNeeded > 0) {
                    for (const entry of this.#fillCrossOrRandom(orient, stillNeeded, usedIds, usedPaths)) {
                        selectedImages.push(entry)
                    }
                }
                continue
            }

            // Normal path: pairwise harmony selection from valid pool
            const found = this.#pairwiseHarmonySelect(poolWithData, usedPaths, needed, orient)
            this.logger.log(`Picked ${found.length} for ${orient}`, this.selectorName)
            for (const img of found) {
                selectedImages.push({ image: img, orientation: orient })
                usedIds.add(img.id)
                usedPaths.add(img.path)
                this.#selectedImages.push(img)
            }
        }

        return selectedImages
    }

    /**
     * Fill slots the matching-orientation pool could not cover by continuing pairwise-harmony
     * ranking over ALL orientations ("cross"), falling back to RandomSelector for any remainder.
     * Cross picks are added to #selectedImages so subsequent anchors stay coherent.
     */
    #fillCrossOrRandom(orient, needed, usedIds, usedPaths) {
        const allDistinct = [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ]
        // Only rows gemini can actually score, minus anything already assigned
        const crossPool = allDistinct.filter((img) => !usedPaths.has(img.path) && this.hasValidData(img))
        const entries = []

        if (crossPool.length > 0) {
            this.logger.log(
                `[CROSS] ${orient} pool exhausted -- harmony-scoring ${crossPool.length} cross-orientation candidates`,
                this.selectorName
            )
            try {
                const found = this.#pairwiseHarmonySelect(crossPool, usedPaths, needed, `${orient}-cross`) || []
                for (const img of found) {
                    if (!usedIds.has(img.id)) {
                        entries.push({ image: img, orientation: orient })
                        usedIds.add(img.id)
                        // usedPaths already updated inside #pairwiseHarmonySelect
                        this.#selectedImages.push(img)
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
     * Pick images from a pool using composite distance. Used by chain mode.
     * @param {Object} seed - The seed/reference image.
     * @param {string} orient - Target orientation.
     * @param {(number|string)[]} excludeIds - Image IDs or paths to exclude.
     * @param {number} needed - Number of images to pick.
     * @param {(number|string)[]} [poolIds] - Optional pool of candidate IDs from previous step.
     * @returns {Object[]} Array of matching image objects.
     */
    pickImages(seed, orient, excludeIds, needed, poolIds = []) {
        let pool = orient === "any" ? [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ] : this.getPool(orient)

        pool = pool.filter(img => {
            const isExcluded = excludeIds.includes(img.id) || excludeIds.includes(img.path)
            return !isExcluded && this.hasValidData(img)
        })

        if (poolIds && poolIds.length > 0) {
            pool = pool.filter(img => poolIds.includes(img.id) || poolIds.includes(img.path))
        }

        return this.#selectFromPool(pool, seed, needed, orient)
    }

    /**
     * Collection interface for intermediate steps in complex multi-selector chains.
     * Returns the top-N nearest candidates scored by composite distance.
     * @param {Object|null} seed - The seed/reference image, or null.
     * @param {string} orient - Target orientation.
     * @param {(number|string)[]} excludeIds - Image IDs or paths to exclude.
     * @param {(number|string)[]} [poolIds] - Optional pool of candidate IDs from previous step.
     * @returns {Object[]} Array of candidate images sorted by proximity to seed.
     */
    collectCandidates(seed, orient, excludeIds, poolIds = []) {
        let pool = orient === "any" ? [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ] : this.getPool(orient)
        pool = pool.filter(img => {
            const isExcluded = excludeIds.includes(img.id) || excludeIds.includes(img.path)
            return !isExcluded && this.hasValidData(img)
        })

        if (poolIds && poolIds.length > 0) {
            pool = pool.filter(img => poolIds.includes(img.id) || poolIds.includes(img.path))
        }

        if (pool.length === 0 || !seed) return []

        const scoredPool = pool.map(img => ({
            img,
            distance: this.#calculateCompositeDistance(seed, img)
        }))
        scoredPool.sort((a, b) => a.distance - b.distance)

        const elitePoolSize = Math.max(15, this.config.elitePoolSize || 25)
        return scoredPool.slice(0, elitePoolSize).map((item) => item.img)
    }
}