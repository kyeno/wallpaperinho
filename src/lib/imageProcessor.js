"use strict"
/**
 * Image Processor
 *
 * Wrapper around ImageMagick v7+ (`magick` command) for image manipulation,
 * and Real-ESRGAN ncnn-vulkan (`realesrgan-ncnn-vulkan`) for AI-based upscaling.
 * Provides fit-exact (cover + center-crop), conditional upscaling via stored DB
 * dimensions, dimension extraction, HSL color extraction, contrast measurement,
 * and uses a fixed binary path from ConfigService.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { runCommand, runCommandSync, classifyStderr, emitClassified } from "./commandRunner.js"

/**
 * Check if ImageMagick v7+ is available and executable.
 * Runs `magick --version` and validates the major version is >= 7.
 * @param {string} binPath - Path to the magick binary.
 * @returns {{available: boolean, version?: string}} Result with availability status and detected version.
 */
function checkImageMagickVersion(binPath) {
    try {
        const output = execFileSync(binPath, ["--version"]).toString().trim()
        // Example output: "Version: ImageMagick 7.1.1-35 Q16-hdri https://imagemagick.org"
        const firstLine = output.split("\n")[0]
        const match = firstLine.match(/ImageMagic[k]?s?\s+(\d+)\./i)
        if (match) {
            const majorVersion = parseInt(match[1], 10)
            return {
                available: majorVersion >= 7,
                version: `${majorVersion}.`,
            }
        }
        return { available: false, version: "unknown" }
    } catch {
        return { available: false }
    }
}

/**
 * Image Processor Class
 *
 * Wraps ImageMagick and Real-ESRGAN ncnn-vulkan for image manipulation tasks:
 * fit-exact resizing, conditional upscaling, dimension/HSL/contrast extraction.
 */
class ImageProcessor {
    /**
     * Create a new ImageProcessor.
     * @param {Config} config - Configuration instance.
     * @param {LoggerService} [logger] - Optional logger service instance.
     * @param {SystemService|null} [system=null] - Optional system service (provides cached detection results).
     */
    constructor(config, logger, system = null) {
        this.config = config
        this.logger = logger || console
        this.system = system
        /** Classified stderr notes from failed child-process calls (drained by callers). */
        this._imNotes = []
    }

    /**
     * Record classified output from a failed external command so the caller (worker
     * thread or main pipeline) can relay it through its own logger at proper levels.
     * @param {Error} err - Thrown error; CommandError instances carry .classified/.stderr.
     * @param {string} context - Short label for what was attempted (e.g., "identify").
     */
    #noteFailure(err, context) {
        const c = err?.classified ?? classifyStderr(err?.stderr, { failed: true })
        if ((c.errors.length > 0) || (c.warnings.length > 0)) {
            this._imNotes.push({ context, errors: c.errors, warnings: c.warnings })
        }
    }

    /**
     * Collect and clear buffered failure notes since the last drain.
     * @returns {Array<{context: string, errors: string[], warnings: string[]}>}
     */
    drainImNotes() {
        const notes = [...this._imNotes]
        this._imNotes.length = 0
        return notes
    }

    // ========================
    // Sync methods for worker threads
    // ========================

    /** @returns {string} ImageMagick binary path */
    #getBin() {
        if (this.config && this.config.settings) {
            return this.config.settings.imagickBin || "magick"
        }
        return "magick"
    }

    /**
     * Get image dimensions synchronously via ImageMagick identify.
     * @param {string} filePath
     * @returns {{width: number, height: number}}
     */
    getDimensions(filePath) {
        let stdout
        try {
            stdout = runCommandSync(this.#getBin(), [
                "identify", "-format", "%w %h", filePath
            ]).stdout
        } catch (err) {
            // Corrupt/unreadable image -- keep throwing (callers rely on it), but carry
            // classified stderr lines so they can be logged at proper levels upstream.
            this.#noteFailure(err, `identify ${filePath}`)
            throw err
        }
        const output = stdout.trim()
        const parts = output.split(/\s+/)

        return {
            width: parseInt(parts[0], 10),
            height: parseInt(parts[1], 10),
        }
    }

    /**
     * Extract contrast metric from an image using standard deviation in grayscale.
     * @param {string} filePath
     * @returns {{contrast: number|null}}
     */
    getContrast(filePath) {
        const formatStr = '%[fx:int(standard_deviation*100)]'

        try {
            const output = runCommandSync(this.#getBin(), [
                filePath, "-colorspace", "Gray",
                "-format", formatStr, "info:",
            ]).stdout.trim()

            const contrast = parseInt(output, 10)
            return { contrast: Number.isNaN(contrast) ? null : contrast }
        } catch (err) {
            this.#noteFailure(err, `contrast ${filePath}`)
            return { contrast: null }
        }
    }

    /**
     * Extract image entropy via ImageMagick.
     * @param {string} filePath
     * @returns {{entropy: number|null}}
     */
    getEntropy(filePath) {
        try {
            const output = runCommandSync(this.#getBin(), [
                filePath, "-colorspace", "Gray",
                "-statistic", "StandardDeviation", "5x5",
                "-format", "%[entropy]", "info:",
            ]).stdout.trim()

            const entropy = parseFloat(output)
            return { entropy: Number.isNaN(entropy) ? null : entropy }
        } catch (err) {
            this.#noteFailure(err, `entropy ${filePath}`)
            return { entropy: null }
        }
    }

    /**
     * Extract Canny edge density by resizing to 400x400, applying Canny filter.
     * @param {string} filePath
     * @returns {{canny: number|null}}
     */
    getCannyEdgeDensity(filePath) {
        const formatStr = '%[fx:int(mean*100)]'

        try {
            const output = runCommandSync(this.#getBin(), [
                filePath, "-resize", "400x400",
                "-canny", "0x1+10%+30%",
                "-format", formatStr, "info:",
            ]).stdout.trim()

            const canny = parseInt(output, 10)
            return { canny: Number.isNaN(canny) ? null : canny }
        } catch (err) {
            this.#noteFailure(err, `canny ${filePath}`)
            return { canny: null }
        }
    }

    /**
     * Extract dominant color palette from an image using ImageMagick histogram.
     * Resizes to x100!, quantizes to top-5 colors, and returns RGB values with pixel counts.
     * @param {string} filePath
     * @returns {{palette: string|null}} JSON string of [{r,g,b,count},...] or null on failure
     */
    getDominantPalette(filePath) {
        try {
            const output = runCommandSync(this.#getBin(), [
                filePath, "-resize", "x100!", "-colors", "5",
                "-format", "%c", "histogram:info:",
            ]).stdout.trim()

            // Output lines look like: "282708: (17.34,22.33,13.94) #11160E srgb(17.34%,22.33%,13.94%)"
            const lines = output.split("\n").filter(l => l.trim())
            const palette = []

            for (const line of lines) {
                const match = line.match(/(\d+):\s*\(([\d.]+),([\d.]+),([\d.]+)\)/)
                if (match) {
                    palette.push({
                        count: parseInt(match[1], 10),
                        r: Math.round(parseFloat(match[2])),
                        g: Math.round(parseFloat(match[3])),
                        b: Math.round(parseFloat(match[4]))
                    })
                }
            }

            return { palette: palette.length > 0 ? JSON.stringify(palette) : null }
        } catch (err) {
            this.#noteFailure(err, `palette ${filePath}`)
            return { palette: null }
        }
    }

    /**
     * Extract average HSL values from an image.
     * @param {string} filePath
     * @returns {{hue: number|null, saturation: number|null, lightness: number|null}}
     */
    getHslValues(filePath) {
        const formatStr = '%[fx:int(hue*360)],%[fx:int(saturation*100)],%[fx:int(lightness*100)]'

        const output = execFileSync(this.#getBin(), [
            filePath, "-resize", "1x1!",
            "-format", formatStr, "info:",
        ]).toString().trim()

        const parts = output.split(",")
        return {
            hue: parts.length >= 1 ? parseInt(parts[0], 10) : null,
            saturation: parts.length >= 2 ? parseInt(parts[1], 10) : null,
            lightness: parts.length >= 3 ? parseInt(parts[2], 10) : null,
        }
    }

    // ========================
    // Async methods for main thread
    // ========================

    /**
     * Execute an ImageMagick convert command.
     * @param {Array<string>} args
     * @returns {Promise<string>} Stdout.
     */
    async #run(args) {
        let result
        try {
            result = await runCommand(this.#getBin(), ["convert", ...args])
        } catch (err) {
            // Emit each line at its proper level first, then rethrow a concise error so
            // upstream handlers log one clean line instead of a multi-line dump.
            emitClassified(this.logger, err.classified, 'ImageProcessor')
            const inputLabel = typeof args[0] === "string" ? path.basename(args[0]) : "input"
            throw new Error(`magick convert failed for ${inputLabel}: ${err.message}`)
        }
        emitClassified(this.logger, classifyStderr(result.stderr), 'ImageProcessor')
        return result.stdout
    }

    /**
     * Resize using "cover" mode then center-crop to exact dimensions.
     * @param {string} inputPath
     * @param {string} outputPath
     * @param {number} width
     * @param {number} height
     */
    async fitExact(inputPath, outputPath, width, height) {
        await this.#run([
            inputPath, "-background", "black", "-flatten",
            "-resize", `${width}x${height}^`,
            "-gravity", "center",
            "-extent", `${width}x${height}`,
            outputPath,
        ])
        this.logger.log(`Fit exact ${inputPath} -> ${outputPath} (${width}x${height})`, 'ImageProcessor')
    }

    /**
     * Draw a debug overlay on the processed image.
     * @param {string} filePath
     *
     */
    async annotate(filePath, info) {
        const hslStr = info.hue !== null && info.saturation !== null && info.lightness !== null
            ? `H:${info.hue}, S:${info.saturation}, L:${info.lightness}` : "N/A"
        const contrastStr = info.contrast !== null ? String(info.contrast) : "N/A"

        let pth = info.originalPath
        if (pth.length > 80) pth = "..." + pth.slice(-77)

        const lines = [`path: ${pth}`]

        if (info.originalWidth != null && info.originalHeight != null) {
            const orient = info.originalHeight > info.originalWidth ? "vertical"
                : info.originalWidth > info.originalHeight ? "horizontal" : "square"
            lines.push(`size: ${info.originalWidth}x${info.originalHeight} (${orient})`)
        }

        if (info.upscaled && info.upscaledWidth != null && info.upscaledHeight != null) {
            const modelLabel = info.upscalerModel ? ` (${info.upscalerModel})` : ""
            const passLabel = Number(info.upscalePasses) > 1 ? `, ${info.upscalePasses} passes` : ""
            lines.push(`upscale: ${info.upscaledWidth}x${info.upscaledHeight}${passLabel}${modelLabel}`)
        } else {
            lines.push(`upscale: no`)
        }

        lines.push(`seed: ${info.isSeed ? "yes" : "no"}`)
        lines.push(`hsl: ${hslStr}`)
        lines.push(`contrast: ${contrastStr}`)
        lines.push(`entropy: ${info.entropy !== null ? String(info.entropy) : "N/A"}`)
        lines.push(`canny: ${info.canny !== null ? String(info.canny) : "N/A"}`)

        const fontSize = 16
        const padding = 10
        const lineHeight = fontSize + 4
        const boxHeight = lines.length * lineHeight + padding * 2
        const maxLineLen = Math.max(...lines.map((l) => l.length))
        const boxWidth = maxLineLen * 9 + padding * 2

        const args = [
            filePath,
            "-fill", "rgba(0,0,0,0.7)",
            "-draw", `rectangle ${padding},${padding} ${padding + boxWidth},${padding + boxHeight}`,
            "-fill", "white", "-pointsize", String(fontSize),
        ]

        for (let i = 0; i < lines.length; i++) {
            const x = padding + 5
            const y = padding + fontSize + i * lineHeight
            args.push("-gravity", "northwest")
            args.push("-annotate", `+${x}+${y}`, lines[i])
        }

        args.push(filePath)

        await this.#run(args)
        this.logger.log(`Debug overlay annotated: ${filePath}`, 'ImageProcessor')
    }

    // ========================
    // NCNN upscaling
    // ========================

    /**
     * Legacy method kept for backward compatibility (used in combine()).
     * Uses cached SystemService results when available.
     */
    checkImageMagickVersion(binPath) {
        if (this.system && this.system.imagick) {
            return { available: this.system.imagick.available, version: this.system.imagick.version }
        }
        return checkImageMagickVersion(binPath)
    }

    /** @returns {boolean} True if ImageMagick v7+ is configured and accessible */
    isImageMagickAvailable() {
        if (this.system && this.system.imagick) {
            return this.system.imagick.available
        }
        const binPath = this.config?.settings?.imagickBin
        if (!binPath || typeof binPath !== "string" || binPath.trim() === "") {
            this.logger.error('ImageMagick binary path not configured.', 'ImageProcessor')
            return false
        }
        try {
            fs.accessSync(binPath, fs.constants.X_OK)
        } catch {
            this.logger.error(`ImageMagick binary not found or not executable: ${binPath}`, 'ImageProcessor')
            return false
        }
        return checkImageMagickVersion(binPath).available
    }

    /** @returns {boolean} True if ncnn upscaler is available */
    isNcnnAvailable() {
        if (this.system && this.system.ncnn) {
            return this.system.ncnn.accessible
        }
        const bin = this.config?.settings?.ncnnUpscalerBin
        if (!bin || typeof bin !== "string" || bin.trim() === "") return false
        try {
            fs.accessSync(bin, fs.constants.X_OK)
            return true
        } catch {
            return false
        }
    }

    /**
     * Determine whether an image needs ncnn upscaling.
     * @param {string} inputPath
     * @param {number} imgWidth
     * @param {number} imgHeight
     * @param {number} targetWidth
     * @param {number} targetHeight
     * @returns {boolean|null}
     */
    shouldUpscale(inputPath, imgWidth, imgHeight, targetWidth, targetHeight) {
        if (!this.isNcnnAvailable()) return null

        if (imgWidth >= targetWidth && imgHeight >= targetHeight) return false

        this.logger.log(
            `Image ${inputPath} (${imgWidth}x${imgHeight}) is smaller than ` +
            `target ${targetWidth}x${targetHeight}. Upscaling with ncnn.`, 'ImageProcessor'
        )
        return true
    }

    /**
     * Upscale an image using Real-ESRGAN ncnn-vulkan.
     * @param {string} inputPath
     * @param {string} outputPath
     */
    async upscale(inputPath, outputPath) {
        const bin = this.config?.settings?.ncnnUpscalerBin
        if (!bin || typeof bin !== "string" || bin.trim() === "") {
            this.logger.warn('NCNN upscaler disabled (BIN not set). Skipping upscale.', 'ImageProcessor')
            return
        }

        // Fail fast with a clear message instead of letting the binary choke on bad input
        if (!inputPath || typeof inputPath !== "string") {
            throw new Error(`NCNN upscale: invalid input path (${String(inputPath)})`)
        }
        if (!fs.existsSync(inputPath)) {
            throw new Error(`NCNN upscale: input file not found: ${inputPath}`)
        }

        const args = this.config.getNcnnUpscalerCommand(inputPath, outputPath)
        if (args.length === 0) {
            this.logger.warn('No NCNN arguments available. Skipping upscale.', 'ImageProcessor')
            return
        }

        this.logger.debug(`Running ncnn upscale: ${bin} ${args.join(" ")}`, 'ImageProcessor')
        try {
            await runCommand(bin, args)
        } catch (err) {
            emitClassified(this.logger, err.classified, 'ImageProcessor')
            throw new Error(`NCNN upscaler failed for ${inputPath}: ${err.message}`)
        }

        // realesrgan-ncnn-vulkan can exit 0 without writing anything -- verify before trusting it
        if (!fs.existsSync(outputPath)) {
            throw new Error(`NCNN upscaler produced no output at ${outputPath} (input: ${inputPath})`)
        }

        this.logger.log(`Upscaled ${inputPath} -> ${outputPath}`, 'ImageProcessor')
    }

    /**
     * Iteratively upscale an image with NCNN until BOTH dimensions reach at least
     * `ncnnUpscaleTolerance` (default 95%) of the target size. Each pass applies the
     * profile's fixed scale factor (`ncnnUpscalerScale`), so small sources may chain
     * multiple passes; ImageMagick then only needs to close a small gap in fitExact().
     * Without a usable NCNN setup the input is returned unchanged (passes=0) and the
     * remaining scaling is left to ImageMagick.
     * @param {string} inputPath - Source image path.
     * @param {string} outputPathBase - Base name for intermediates; pass N writes `${base}-p${N}.png`.
     * @param {number} targetWidth - Target width in pixels.
     * @param {number} targetHeight - Target height in pixels.
     * @returns {Promise<{path: string, passes: number, width: number, height: number, intermediates: string[]}>}
     *   Final path plus statistics. `intermediates` lists temp files the caller must clean up.
     */
    async upscaleToTarget(inputPath, outputPathBase, targetWidth, targetHeight) {
        const s = this.config?.settings ?? {}

        let tolerance = parseFloat(s.ncnnUpscaleTolerance)
        if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) tolerance = 0.95

        let maxPasses = parseInt(s.ncnnMaxUpscalePasses, 10)
        if (!Number.isInteger(maxPasses) || maxPasses < 1) maxPasses = 3

        // Measure real dimensions -- trusted over values passed from elsewhere
        let dims = this.getDimensions(inputPath)

        const minW = Math.ceil(targetWidth * tolerance)
        const minH = Math.ceil(targetHeight * tolerance)

        if (dims.width >= minW && dims.height >= minH) {
            this.logger.log(
                `No NCNN pass needed: ${dims.width}x${dims.height} already within ` +
                `${Math.round(tolerance * 100)}% of target ${targetWidth}x${targetHeight}`, 'ImageProcessor'
            )
            return { path: inputPath, passes: 0, width: dims.width, height: dims.height, intermediates: [] }
        }

        this.logger.log(
            `NCNN iterative upscale: ${dims.width}x${dims.height} -> need >= ${minW}x${minH} ` +
            `(tolerance=${tolerance}, max ${maxPasses} pass(es))`, 'ImageProcessor'
        )

        let curPath = inputPath
        const intermediates = []
        let passes = 0

        while ((dims.width < minW || dims.height < minH) && passes < maxPasses) {
            passes++
            const out = `${outputPathBase}-p${passes}.png`
            await this.upscale(curPath, out)
            const next = this.getDimensions(out)

            // Guard against a no-op pass (e.g., scale factor effectively 1) -- avoid spinning
            if (next.width <= dims.width && next.height <= dims.height) {
                this.logger.warn(
                    `NCNN pass did not increase size (${dims.width}x${dims.height}) -- stopping early`,
                    'ImageProcessor'
                )
                break
            }

            dims = next
            curPath = out
            intermediates.push(out)
            this.logger.log(`NCNN pass ${passes}/${maxPasses} done: now ${dims.width}x${dims.height}`, 'ImageProcessor')
        }

        return { path: curPath, passes, width: dims.width, height: dims.height, intermediates }
    }

    /**
     * Combine multiple per-display images into a single composite wallpaper.
     *
     * Displays are arranged left-to-right in displayIndex order. Each image is placed at its
     * cumulative X offset and vertically positioned according to the alignment strategy.
     *
     * ImageMagick command pattern (uses sub-expressions):
     *   magick convert -size WxH xc:black \
     *     \( tile1 \) -geometry +x1+y1 -composite \
     *     \( tile2 \) -geometry +x2+y2 -composite \
     *     -quality Q output.jpg
     *
     * @param {Array<{path: string, width: number, height: number}>} tiles - Per-display images sorted by display index.
     * @param {string} outputPath - Output path for the combined composite.
     * @param {Object} [options] - Optional configuration.
     * @param {"top"|"bottom"|"center"} [options.alignment="bottom"] - Vertical alignment for shorter monitors.
     * @param {number} [options.quality=95] - JPEG quality for the output (1-100).
     */
    async combine(tiles, outputPath, options = {}) {
        const bin = this.#getBin()
        if (!this.checkImageMagickVersion(bin).available) {
            throw new Error("ImageMagick v7+ not found")
        }

        const alignment = options?.alignment ?? "bottom"
        const quality = options?.quality ?? 95

        // Compute composite dimensions
        let totalWidth = 0
        let maxHeight = 0
        for (const tile of tiles) {
            totalWidth += tile.width
            maxHeight = Math.max(maxHeight, tile.height)
        }

        // Compute per-tile offsets (left-to-right, vertical position depends on alignment)
        const offsets = []
        let cursorX = 0
        for (const tile of tiles) {
            let y
            switch (alignment) {
                case "top":
                    y = 0
                    break
                case "center":
                    y = Math.round((maxHeight - tile.height) / 2)
                    break
                case "bottom":
                default:
                    y = maxHeight - tile.height
                    break
            }
            offsets.push({ x: cursorX, y })
            cursorX += tile.width
        }

        this.logger.log(
            `Combining ${tiles.length} tile(s) into ` +
            `${totalWidth}x${maxHeight} composite (alignment=${alignment}) -> ${outputPath}`, 'ImageProcessor'
        )

        // Build command using sub-expressions: magick convert -size WxH xc:black \
        //   \( tile1 \) -geometry +x1+y1 -composite \
        //   \( tile2 \) -geometry +x2+y2 -composite ... -quality Q output.jpg
        const cmdArgs = [
            "-size", `${totalWidth}x${maxHeight}`, "xc:black",
        ]
        for (let i = 0; i < tiles.length; i++) {
            cmdArgs.push("(", tiles[i].path, ")")
            cmdArgs.push("-geometry", `+${offsets[i].x}+${offsets[i].y}`)
            cmdArgs.push("-composite")
        }
        cmdArgs.push("-quality", String(quality))
        cmdArgs.push(outputPath)

        let result
        try {
            result = await runCommand(bin, ["convert", ...cmdArgs])
        } catch (err) {
            emitClassified(this.logger, err.classified, 'ImageProcessor')
            throw new Error(`composite assembly failed (${tiles.length} tiles): ${err.message}`)
        }
        emitClassified(this.logger, classifyStderr(result.stderr), 'ImageProcessor')
        this.logger.log(`Composite written: ${outputPath}`, 'ImageProcessor')
    }
}

export default ImageProcessor
