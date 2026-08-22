"use strict"
/**
 * Wallpaper Generator
 *
 * Orchestrates the wallpaper generation pipeline:
 * 1. Loads profile configuration
 * 2. Assigns images to displays via DisplayAssignment
 * 3. Processes each image (upscale if needed, fit-exact resize)
 * 4. Optionally annotates debug overlay
 * 5. Delegates wallpaper setting to WallpaperSetter
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import ConfigService from "../services/configService.js"

/**
 * Wallpaper Generator Class
 *
 * Orchestrates the full wallpaper generation pipeline: loads profile configuration,
 * assigns images to displays via DisplayAssignment, processes each image
 * (upscale if needed, fit-exact resize), optionally annotates debug overlay,
 * and delegates wallpaper setting to WallpaperSetter.
 */
class WallpaperGenerator {
    /**
     * @param {Config} config
     * @param {Database} db
     * @param {ImageProcessor} imageProcessor
     * @param {ImageSelector} imageSelector
     * @param {DisplayAssignment} displayAssignment
     * @param {WallpaperSetter} wallpaperSetter
     * @param {LoggerService} [logger] - Optional logger service instance.
     */
    constructor(config, db, imageProcessor, imageSelector, displayAssignment, wallpaperSetter, logger) {
        this.config = config
        this.db = db
        this.imageProcessor = imageProcessor
        this.imageSelector = imageSelector
        this.displayAssignment = displayAssignment
        this.wallpaperSetter = wallpaperSetter
        this.logger = logger || console
    }

    /**
     * Generate wallpapers for all displays using the specified profile.
     * @param {string} profileName - Profile name from config.
     * @returns {Promise<string|null>} Full path to composite wallpaper on success, null on failure.
     */
    async generate(profileName) {
        await this.db.initialize()

        // Validate profile exists (skip if using directory override mode with no profile)
        if (profileName !== null) {
            const availableProfiles = ConfigService.listProfiles()
            if (!availableProfiles.includes(profileName)) {
                this.logger.error(`Unknown profile: ${profileName}. Available: ${availableProfiles.join(", ")}`, 'WallpaperGenerator')
                return null
            }
        }

        const outputDir = this.config.settings.wallpaperOutputDirectory
        const tempDir = this.config.settings.tempDirectory
        fs.mkdirSync(outputDir, { recursive: true })
        fs.mkdirSync(tempDir, { recursive: true })

        const displays = this.config.settings.displays
        this.logger.log(`Generating for ${displays.length} display(s), profile "${profileName || "(none)"}"`, 'WallpaperGenerator')

        // Generate a unique run prefix for all temp files in this generation cycle
        const runPrefix = `wallpaperinho-${randomBytes(6).toString("hex")}`

        // Slots were already created in DisplayAssignment constructor via config.getDisplays()
        const slots = this.displayAssignment.slots

        // Build orientation counts from slots
        const counts = { vertical: 0, horizontal: 0, square: 0 }
        for (const slot of slots) {
            counts[slot.orientation]++
        }

        // Select images once for all orientations
        const selectedImages = await this.imageSelector.select(counts)
        if (!selectedImages || selectedImages.length === 0) {
            this.logger.warn('No images selected', 'WallpaperGenerator')
            return null
        }

        // Group selections by orientation for best-fit assignment
        // Preserve _isSeed flag from chain mode so debug overlay knows which image was the seed
        const seedImageIds = new Set()
        const poolByOrientation = { vertical: [], horizontal: [], square: [] }
        for (const s of selectedImages) {
            if (!(s.orientation in poolByOrientation)) continue
            const img = s.image
            // Defense-in-depth: drop malformed selections instead of crashing deep in ImageMagick later
            if (!img || typeof img.path !== "string" || !Number.isFinite(img.width) || !Number.isFinite(img.height)) {
                this.logger.warn(
                    `Dropping malformed ${s.orientation} selection: ${JSON.stringify(s).slice(0, 200)}`,
                    'WallpaperGenerator'
                )
                continue
            }
            if (s._isSeed) seedImageIds.add(img.id)
            poolByOrientation[s.orientation].push(img)
        }
        this.logger.debug(`Seed image IDs captured: ${seedImageIds.size > 0 ? [...seedImageIds].join(", ") : "(none)"}`, 'WallpaperGenerator')

        // Assign images to displays within each orientation group.
        // Best-fit by aspect-ratio distance (minimal crop/distortion), tie-broken by pixel area --
        // this also ranks cross-orientation fallback images sensibly (e.g., a near-square source
        // is preferred over an extreme portrait for a landscape slot).
        const orientGroups = { vertical: [], horizontal: [], square: [] }
        for (const slot of slots) {
            orientGroups[slot.orientation].push(slot)
        }
        // Sort each group by pixel area descending so the biggest display gets first pick
        for (const list of Object.values(orientGroups)) {
            list.sort((a, b) => b.pixelArea - a.pixelArea)
        }

        for (const orient of ["vertical", "horizontal", "square"]) {
            const slotList = orientGroups[orient]
            const free = [...poolByOrientation[orient]]
            for (const slot of slotList) {
                let bestIdx = -1
                let bestScore = Infinity
                let bestArea = -1
                for (let i = 0; i < free.length; i++) {
                    const score = this.#aspectDistance(free[i], slot)
                    const area = free[i].width * free[i].height
                    if (score < bestScore || (score === bestScore && area > bestArea)) {
                        bestScore = score
                        bestArea = area
                        bestIdx = i
                    }
                }
                if (bestIdx >= 0) {
                    const [img] = free.splice(bestIdx, 1)
                    slot.assignedImage = img
                    // Propagate _isSeed flag so annotate() can display it
                    slot._isSeed = seedImageIds.has(img.id)
                } else {
                    this.logger.warn(
                        `No ${orient} image available for ` +
                        `display ${slot.displayIndex}`, 'WallpaperGenerator'
                    )
                }
            }
        }

        // Process each assigned slot -- outputs go to TEMP_DIR with prefixed names
        /** @type {string[]} */
        const upscaleTempFiles = []
        let allSuccess = true
        for (const slot of slots) {
            if (!slot.assignedImage) {
                allSuccess = false
                continue
            }
            try {
                const ok = await this.#processDisplay(slot, tempDir, runPrefix, upscaleTempFiles)
                if (!ok) allSuccess = false
            } catch (err) {
                this.logger.error(`Error for display ${slot.displayIndex}: ${err.message}`, 'WallpaperGenerator')
                allSuccess = false
            }
        }

        if (!allSuccess) {
            this.logger.warn('Some displays failed, skipping wallpaper setting', 'WallpaperGenerator')
            this.#cleanupTempFiles(upscaleTempFiles)
            return null
        }

        // Combine per-display tiles into a single composite wallpaper
        // Slots must be sorted by display index so left-to-right order is preserved
        const sortedSlots = [...slots].sort((a, b) => a.displayIndex - b.displayIndex)
        const tiles = sortedSlots.map((slot) => ({
            path: path.join(tempDir, `${runPrefix}-display${slot.displayIndex}.jpg`),
            width: slot.width,
            height: slot.height,
        }))

        // Composite goes to WALLPAPER_OUTPUT_DIR with proper naming convention
        const timestamp = Date.now()
        const compositeFileName = `${runPrefix}-${timestamp}.jpg`
        const compositePath = path.join(outputDir, compositeFileName)

        await this.imageProcessor.combine(tiles, compositePath, {
            alignment: this.config.settings.monitorAlignment,
            quality: this.config.settings.wallpaperOutputJpegQuality,
        })

        // DE-aware cleanup of per-display files
        const detectedEnv = this.wallpaperSetter.system.desktop.environment
        const perDisplayPaths = sortedSlots.map((slot) =>
            path.join(tempDir, `${runPrefix}-display${slot.displayIndex}.jpg`)
        )

        if (detectedEnv === "hyprland" || detectedEnv === "kde") {
            // Move per-display files to output dir for WMs that support per-monitor wallpapers
            this.logger.log(`${detectedEnv} detected -- moving per-display files to output directory`, 'WallpaperGenerator')
            for (const srcPath of perDisplayPaths) {
                if (fs.existsSync(srcPath)) {
                    const destName = path.basename(srcPath)
                    const destPath = path.join(outputDir, destName)
                    fs.renameSync(srcPath, destPath)
                    this.logger.log(`Moved ${srcPath} -> ${destPath}`, 'WallpaperGenerator')
                }
            }
        } else {
            // Delete per-display temp files (Cinnamon and others only use the composite)
            this.logger.debug(
                `${detectedEnv || "unknown"} detected -- ` +
                `cleaning up per-display temp files`, 'WallpaperGenerator'
            )
            for (const p of perDisplayPaths) {
                this.#unlinkIfExists(p)
            }
        }

        // Always clean up upscale intermediates
        this.#cleanupTempFiles(upscaleTempFiles)

        // Set wallpaper
        const ok = await this.wallpaperSetter.set(compositePath)
        if (!ok) {
            this.logger.error('Failed to set composite wallpaper', 'WallpaperGenerator')
            return null
        }

        this.logger.log(`Wallpaper set successfully: ${compositePath}`, 'WallpaperGenerator')
        return compositePath
    }

    /**
     * Aspect-ratio distance between an image and a target slot (log domain).
     * Lower is better -- 0 means identical aspect ratio (no crop waste).
     * @param {{width: number, height: number}} img - Image record.
     * @param {Slot} slot - Display slot with target dimensions.
     * @returns {number} Non-negative distance; Infinity when either side has invalid dims.
     */
    #aspectDistance(img, slot) {
        if (!img || !Number.isFinite(img.width) || !Number.isFinite(img.height) ||
            img.width <= 0 || img.height <= 0 || slot.width <= 0 || slot.height <= 0) {
            return Infinity
        }
        return Math.abs(Math.log((img.width / img.height) / (slot.width / slot.height)))
    }

    /**
     * Process a single display slot: upscale if needed, fit-exact resize, annotate.
     * Expects slot.assignedImage to already be populated.
     * @param {Slot} slot - Display slot with assignedImage set.
     * @param {string} outputDir - Output directory path (TEMP_DIR).
     * @param {string} runPrefix - Unique prefix for this generation run.
     * @param {string[]} upscaleTempFiles - Array to collect upscale intermediate paths.
     * @returns {Promise<boolean>} True if successful.
     */
    async #processDisplay(slot, outputDir, runPrefix, upscaleTempFiles) {
        const { displayIndex: id, width, height, orientation } = slot
        const chosen = slot.assignedImage
        const isSeed = slot._isSeed === true

        this.logger.log(
            `Display ${id}: processing ` +
            `${chosen.width}x${chosen.height} -> ${width}x${height} [${orientation}]`, 'WallpaperGenerator'
        )
        this.logger.log(`Source: ${chosen.path}`, 'WallpaperGenerator')

        const outputPath = path.join(outputDir, `${runPrefix}-display${id}.jpg`)
        let currentPath = chosen.path
        let upscaled = false
        let upscalePasses = 0
        let origW = chosen.width
        let origH = chosen.height
        let upscaleW = null
        let upscaleH = null

        // Iterative NCNN upscaling -- chain passes until within tolerance of target size;
        // without NCNN the input is used as-is and ImageMagick closes the gap in fitExact()
        if (this.imageProcessor.isNcnnAvailable()) {
            const baseName = path.join(outputDir, `${runPrefix}-upscale${id}`)
            const result = await this.imageProcessor.upscaleToTarget(
                chosen.path, baseName, width, height
            )
            if (result.passes > 0) {
                for (const f of result.intermediates) upscaleTempFiles.push(f)
                currentPath = result.path
                upscaleW = result.width
                upscaleH = result.height
                upscalePasses = result.passes
                upscaled = true
            }
        }

        // Resize to exact display dimensions
        await this.imageProcessor.fitExact(currentPath, outputPath, width, height)

        // Extract metadata for debug overlay
        const hsl = this.imageProcessor.getHslValues(outputPath)
        const contrast = this.imageProcessor.getContrast(outputPath)
        const entropy = this.imageProcessor.getEntropy(outputPath)
        const canny = this.imageProcessor.getCannyEdgeDensity(outputPath)

        // Debug overlay
        if (this.config.settings.debugOverlay) {
            await this.imageProcessor.annotate(outputPath, {
                originalPath: chosen.path,
                upscaled,
                originalWidth: origW,
                originalHeight: origH,
                upscaledWidth: upscaleW,
                upscaledHeight: upscaleH,
                upscalePasses,
                upscalerModel: this.config.settings.ncnnUpscalerModel,
                isSeed,
                ...hsl,
                ...contrast,
                ...entropy,
                ...canny,
            })
        }

        return true
    }

    /**
     * Remove a file silently if it exists.
     * @param {string} filePath
     */
    #unlinkIfExists(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
            }
        } catch (err) {
            this.logger.warn(`Failed to remove temp file ${filePath}: ${err.message}`, 'WallpaperGenerator')
        }
    }

    /**
     * Clean up all collected temp files.
     * @param {string[]} paths
     */
    #cleanupTempFiles(paths) {
        for (const p of paths) {
            this.#unlinkIfExists(p)
        }
    }
}

export default WallpaperGenerator