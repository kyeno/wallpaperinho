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
 * Drain buffered classified-stderr notes from the processor into a message payload so
 * the main thread can log them at proper levels (workers have no logger of their own).
 * @param {object} data - Result payload to extend with `notes` when present.
 * @param {{drainImNotes?: Function}} proc - ImageProcessor instance.
 */
function attachImNotes(data, proc) {
    if (!proc || typeof proc.drainImNotes !== "function") return
    const notes = proc.drainImNotes()
    if (Array.isArray(notes) && notes.length > 0) data.notes = notes
}

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
            data: (() => {
                const d = {
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
                }
                attachImNotes(d, processor)
                return d
            })(),
        })
    } catch (err) {
        // File may not exist or ImageMagick failed -- relay classified stderr notes so the
        // main thread can log them at proper levels.
        const failData = { path: filePath, error: err.message }
        attachImNotes(failData, processor)
        parentPort.postMessage({
            type: "result",
            success: false,
            data: failData,
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