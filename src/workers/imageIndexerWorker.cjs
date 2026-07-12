"use strict"

/**
 * Index Worker
 *
 * Runs in a worker thread. Receives image paths one at a time from the main
 * thread, checks file stats, spawns ImageMagick to read dimensions, average
 * HSL color values, contrast, entropy, canny edge density, and palette via ImageProcessorService,
 * and sends results back via postMessage.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

const { parentPort } = require("node:worker_threads")
const fs = require("node:fs")
const { createRequire } = require("node:module")

const _require = createRequire(__filename)
const { default: ImageProcessor } = _require("../lib/imageProcessor.js")

// Deferred initialization: wait for "init" message from main thread
let processor = null

/**
 * Process a single image: read file stats and extract dimensions + HSL via ImageProcessorService.
 * @param {string} filePath - Absolute path to the image file.
 */
function processImage(filePath) {
    if (!processor) {
        parentPort.postMessage({
            type: "result",
            success: false,
            data: {
                path: filePath,
                error: "ImageProcessor not initialized (missing init message)",
            },
        })
        return
    }

    try {
        // Get file stats
        const stat = fs.statSync(filePath)
        const filesize = stat.size

        // Extract dimensions, HSL, contrast, entropy, canny edge density, and palette
        const { width, height } = processor.getDimensions(filePath)
        const { hue, saturation, lightness } = processor.getHslValues(filePath)
        const { contrast } = processor.getContrast(filePath)
        const { entropy } = processor.getEntropy(filePath)
        const { canny } = processor.getCannyEdgeDensity(filePath)
        const { palette } = processor.getDominantPalette(filePath)

        parentPort.postMessage({
            type: "result",
            success: true,
            data: {
                path: filePath,
                width,
                height,
                filesize,
                hue,
                saturation,
                lightness,
                contrast,
                entropy,
                canny,
                palette,
            },
        })
    } catch (err) {
        // File may not exist or ImageMagick failed
        parentPort.postMessage({
            type: "result",
            success: false,
            data: {
                path: filePath,
                error: err.message,
            },
        })
    }
}

// Listen for messages from the main thread
parentPort.on("message", (msg) => {
    if (msg.type === "init") {
        // Initialize with config passed as a plain object (no method serialization needed)
        const config = { settings: msg.config || {} }
        processor = new ImageProcessor(config)
    } else if (msg.type === "index") {
        processImage(msg.path)
    } else if (msg.type === "shutdown") {
        parentPort.close()
    }
})