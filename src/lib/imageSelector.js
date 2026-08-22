"use strict"
/**
 * Image Selector Router
 *
 * Routes image selection requests to the appropriate strategy-based selector
 * (random, colorHSL, colorPalette, contrast, canny, entropy, gemini) based on the configured matching
 * strategy. Supports both single-strategy and multi-step chain modes.
 *
 * Chain mode example: ["contrast", "entropy"] means first filter by contrast
 * similarity, then within that filtered pool pick nearest-by-entropy.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import CannySelector from "./selectors/cannySelector.js"
import ColorHSLSelector from "./selectors/colorSelector.js"
import ColorPaletteSelector from "./selectors/colorPaletteSelector.js"
import ContrastSelector from "./selectors/contrastSelector.js"
import EntropySelector from "./selectors/entropySelector.js"
import RandomSelector from "./selectors/randomSelector.js"
import GeminiQwenSelector from "./selectors/geminiSelector.js"

/** Shared base class for getOrientation helper */
import SelectorBase from "./selectors/selectorBase.js"

/**
 * Image Selector Router Class
 *
 * Routes image selection requests to the appropriate strategy-based selector
 * (random, colorHSL, colorPalette, contrast, canny, entropy, gemini).
 * Supports both single-strategy and multi-step chain modes.
 */
class ImageSelector {
    /**
     * Create a new ImageSelector router.
     * @param {DatabaseService} db - Database service instance.
     * @param {ConfigService} config - Configuration service instance.
     * @param {ImageProcessor} processor - Image processor for selector use.
     * @param {LoggerService} [logger] - Optional logger service instance.
     */
    constructor(db, config, processor, logger) {
        this.db = db
        this.config = config
        this.processor = processor
        this.logger = logger || console

        // Pre-instantiate all selectors
        this.selectors = {
            random: new RandomSelector(db, config, logger),
            colorHSL: new ColorHSLSelector(db, config, logger),
            colorPalette: new ColorPaletteSelector(db, config, logger),
            contrast: new ContrastSelector(db, config, logger),
            canny: new CannySelector(db, config, logger),
            entropy: new EntropySelector(db, config, logger),
            gemini: new GeminiQwenSelector(db, config, logger)
        }
    }

    /**
     * Select images for the given orientation counts using the configured strategy.
     * Supports both single-strategy and chain modes.
     * @param {{vertical: number, horizontal: number, square: number}} counts - Required image counts per orientation.
     * @returns {Promise<Array<{image: Object, orientation: string}>>} Selected images with their orientations.
     */
    async select(counts) {
        const chain = this.config.settings.imageMatchingStrategy

        if (Array.isArray(chain) && chain.length > 0) {
            this.logger.log(`Using chain: ${chain.join(" -> ")}`, 'ImageSelector')
            return this.#selectByChain(chain, counts)
        }

        // Single-strategy mode (backward compatible)
        const strategy = this.config.settings.imageMatchingStrategy || "random"
        this.logger.log(`Using strategy: ${strategy}`, 'ImageSelector')

        const selector = this.selectors[strategy] || this.selectors.random
        return selector.select(counts)
    }

    /**
     * Multi-step chain selection.
     * Intermediate steps collect candidates (no hard limit), final step picks concrete counts.
     * @param {string[]} chain - Array of strategy names, e.g. ["contrast", "entropy"].
     * @param {{vertical: number, horizontal: number, square: number}} counts - Required counts per orientation.
     * @returns {Array<{image: Object, orientation: string}>}
     */
    async #selectByChain(chain, counts) {
        const allDistinct = [
            ...this.db.findAllVerticalSync(),
            ...this.db.findAllHorizontalSync(),
            ...this.db.findAllSquareSync(),
        ]

        if (allDistinct.length === 0) {
            this.logger.warn('[CHAIN] Empty catalog -- returning nothing', 'ImageSelector')
            return []
        }

        // Resolve each strategy name to a selector instance
        const selectors = chain.map((name) => {
            const sel = this.selectors[name]
            if (!sel) {
                this.logger.warn(`[CHAIN] Unknown strategy "${name}", falling back to random`, 'ImageSelector')
                return this.selectors.random
            }
            return sel
        })

        // Validate: only the last step may be non-intermediate
        for (let i = 0; i < selectors.length - 1; i++) {
            if (!selectors[i].canBeIntermediate()) {
                this.logger.warn(
                    `[CHAIN] Strategy "${chain[i]}" cannot be intermediate, ` +
                    `moving it would break the chain. Falling back to single-strategy mode.`, 'ImageSelector'
                )
                return selectors[selectors.length - 1].select(counts)
            }
        }

        // Pick a global seed from images that have valid data for the FIRST strategy
        const firstSel = selectors[0]
        const firstWithData = allDistinct.filter((img) => firstSel.hasValidData(img))

        if (firstWithData.length === 0) {
            this.logger.warn('[CHAIN] No images with valid data for first strategy -- fallback to random', 'ImageSelector')
            return this.selectors.random.selectSync(counts)
        }

        const seed = firstWithData[Math.floor(Math.random() * firstWithData.length)]
        if (firstSel.logSeed) firstSel.logSeed(seed)

        const selectedImages = []
        const usedIds = new Set([seed.id])
        const usedPaths = new Set([seed.path])

        // Include the seed in results under its natural orientation
        const seedOrient = SelectorBase.getOrientation(seed)
        selectedImages.push({ image: seed, orientation: seedOrient, _isSeed: true })

        // Process each orientation independently
        for (const orient of ["vertical", "horizontal", "square"]) {
            let needed = (counts[orient] || 0) - (orient === seedOrient ? 1 : 0)
            if (needed <= 0) continue

            const pool = this.#getPool(orient)
            const availableInOrient = pool.filter((img) => !usedPaths.has(img.path))

            if (availableInOrient.length === 0) {
                // No matching-orientation candidates -- score across orientations, then random
                this.#fillCrossOrRandom(selectors, seed, counts, orient, needed, usedIds, usedPaths, selectedImages)
                continue
            }

            // --- Chain filtering ---
            let candidateIds = null // null means "no restriction from previous step"

            // Run intermediate steps (all except last), collecting candidates per tolerance
            for (let i = 0; i < selectors.length - 1; i++) {
                const sel = selectors[i]
                this.logger.log(
                    `[CHAIN] Running intermediate step ${i}/${selectors.length - 1} (${chain[i]}) for ${orient}` +
                    (candidateIds ? `, scoped to ${candidateIds.length} prior candidates` : ""), 'ImageSelector'
                )
                const candidates = sel.collectCandidates(seed, orient, [...usedIds], candidateIds ? candidateIds : [])

                if (candidates.length === 0) {
                    this.logger.warn(`[CHAIN] Step ${i} (${chain[i]}) returned no candidates for ${orient}, aborting chain`, 'ImageSelector')
                    break
                }

                candidateIds = candidates.map((c) => c.id)
                this.logger.debug(
                    `[CHAIN] After step ${i} (${chain[i]}): ` +
                    `${candidateIds.length} candidates for ${orient}`, 'ImageSelector'
                )
            }

            // --- Final step: pick concrete count from the filtered pool ---
            const finalSel = selectors[selectors.length - 1]
            const finalPoolIds = candidateIds // may be null (unrestricted) or filtered IDs

            // Check how many of the candidates have valid data for the final strategy
            const finalCandidates = finalPoolIds
                ? allDistinct.filter((img) => finalPoolIds.includes(img.id) && !usedIds.has(img.id))
                : availableInOrient

            const finalWithData = finalCandidates.filter((img) => finalSel.hasValidData(img))

            this.logger.log(
                `[CHAIN] Final step (${chain[selectors.length - 1]}) for ${orient}:` +
                ` pool=${finalPoolIds ? candidateIds.length : "all"}, ` +
                `available=${finalCandidates.length}, with_valid_data=${finalWithData.length}, needed=${needed}`, 'ImageSelector'
            )

            if (finalWithData.length === 0) {
                this.logger.warn(
                    `[CHAIN] No candidates with valid "${chain[selectors.length - 1]}" data -- scoring cross-orientation pool`, 'ImageSelector'
                )
                this.#fillCrossOrRandom(selectors, seed, counts, orient, needed, usedIds, usedPaths, selectedImages)
                continue
            }

            // Use the original global seed for all steps in chain mode.
            // If the original seed lacks valid data for this strategy, fall back to random selection.
            if (!finalSel.hasValidData(seed)) {
                this.logger.warn(
                    `[CHAIN] Original seed lacks valid "${chain[selectors.length - 1]}" data -- fallback to random`, 'ImageSelector'
                )
                this.#fillCrossOrRandom(selectors, seed, counts, orient, needed, usedIds, usedPaths, selectedImages)
                continue
            }

            // Log seed for final step's metric values
            if (finalSel.logSeed) finalSel.logSeed(seed)

            // Pick images scoped to the chain pool using the original seed
            const method = finalSel.supportsOrderByDistance() ? "distance" : "tolerance"
            this.logger.log(`[CHAIN] Picking ${needed} for ${orient} using ${method} method`, 'ImageSelector')
            const found = finalSel.pickImages(seed, orient, [...usedIds], needed, finalPoolIds || [])

            for (const img of found) {
                selectedImages.push({ image: img, orientation: orient })
                usedIds.add(img.id)
                usedPaths.add(img.path)
            }

            // Fill any shortfall by scoring across orientations, then random as last resort
            const stillNeeded = needed - found.length
            if (stillNeeded > 0) {
                this.logger.log(`[CHAIN] Shortfall ${stillNeeded} for ${orient}, scoring cross-orientation pool`, 'ImageSelector')
                this.#fillCrossOrRandom(selectors, seed, counts, orient, stillNeeded, usedIds, usedPaths, selectedImages)
            }
        }

        return selectedImages
    }

    /** Fill remaining slots using RandomSelector fallback. */
    #fillRandom(counts, orient, stillNeeded, usedIds, usedPaths, selectedImages) {
        const fallback = this.selectors.random.selectSync({ [orient]: stillNeeded }, [...usedPaths])
        for (const s of fallback) {
            selectedImages.push(s)
            usedIds.add(s.image.id)
            usedPaths.add(s.image.path)
        }
    }

    /**
     * Fill slots an orientation pool could not cover by re-running the chain's own scoring
     * across ALL orientations ("any"), degrading to random for whatever remains unfilled.
     * @param {Object[]} selectors - Resolved selector instances for the chain (in order).
     * @param {Object} seed - The global seed image.
     * @param {{vertical: number, horizontal: number, square: number}} counts - Original request (for logging parity with #fillRandom).
     * @param {string} orient - Requested orientation label; results are tagged with it.
     * @param {number} stillNeeded - How many images are required.
     * @param {Set<number>} usedIds - IDs already selected (mutated).
     * @param {Set<string>} usedPaths - Paths already selected (mutated).
     * @param {Array<{image: Object, orientation: string}>} selectedImages - Accumulator (mutated).
     */
    #fillCrossOrRandom(selectors, seed, counts, orient, stillNeeded, usedIds, usedPaths, selectedImages) {
        let filled = 0
        try {
            const found = this.#pickChainAcrossOrientations(selectors, seed, [...usedIds], stillNeeded) || []
            for (const img of found) {
                if (!usedIds.has(img.id)) {
                    selectedImages.push({ image: img, orientation: orient })
                    usedIds.add(img.id)
                    usedPaths.add(img.path)
                    filled++
                }
            }
        } catch (err) {
            this.logger.warn(`[CHAIN][CROSS] scored cross-pick failed (${err.message}) -- using random`, 'ImageSelector')
        }

        const remaining = stillNeeded - filled
        if (remaining > 0) {
            this.#fillRandom(counts, orient, remaining, usedIds, usedPaths, selectedImages)
        }
    }

    /**
     * Run the chain's intermediate collect steps + final pick with orient="any" so that
     * candidates from every orientation are scoreable. Returns [] when any step yields
     * nothing or the strategy cannot rank an "any" pool.
     * @param {Object[]} selectors - Resolved selector instances for the chain (in order).
     * @param {Object} seed - The global seed image.
     * @param {(number|string)[]} excludeIds - IDs/paths already selected.
     * @param {number} needed - How many images to pick.
     * @returns {Object[]} Raw DB rows picked across orientations.
     */
    #pickChainAcrossOrientations(selectors, seed, excludeIds, needed) {
        const finalSel = selectors[selectors.length - 1]
        // Cheap pre-check: no point running intermediates if the final step can't anchor on the seed
        if (!finalSel || typeof finalSel.pickImages !== "function") return []
        if (typeof finalSel.hasValidData === "function" && !finalSel.hasValidData(seed)) return []

        let candidateIds = null
        for (let i = 0; i < selectors.length - 1; i++) {
            const sel = selectors[i]
            if (typeof sel.collectCandidates !== "function") continue   // e.g., RandomSelector in a chain
            this.logger.log(`[CHAIN][CROSS] Step ${i} (${sel.selectorName}) scoring all orientations`, 'ImageSelector')
            const candidates = sel.collectCandidates(seed, "any", [...excludeIds], candidateIds || [])
            if (!candidates || candidates.length === 0) return []
            candidateIds = candidates.map((c) => c.id)
        }

        return finalSel.pickImages(seed, "any", [...excludeIds], needed, candidateIds || [])
    }

    /** Fetch the pool for a given orientation. */
    #getPool(orient) {
        if (orient === "vertical") return this.db.findAllVerticalSync()
        if (orient === "horizontal") return this.db.findAllHorizontalSync()
        return this.db.findAllSquareSync()
    }
}

export default ImageSelector