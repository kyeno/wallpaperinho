"use strict"
/**
 * Image Indexer
 *
 * Scans directories for image files, extracts metadata using worker threads,
 * and stores results in the database. Handles incremental indexing by comparing
 * file sizes to skip unchanged images. Also cleans up stale entries for deleted files.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import fs from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { Worker } from "node:worker_threads"

import { emitClassified } from "./commandRunner.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Image Indexer Class
 *
 * Coordinates directory walking, worker thread management, and database insertion
 * for image metadata extraction (dimensions, HSL, contrast, entropy, canny edges).
 */
class ImageIndexer {
    #workers = []
    #busyWorkers = new Set()
    #nextIndex = 0

    /**
     * Create a new ImageIndexer.
     * @param {DatabaseService} db - Database service instance.
     * @param {ConfigService} config - Configuration service instance.
     * @param {LoggerService} [logger] - Optional logger service instance.
     * @param {SystemService|null} [system=null] - Optional system service (provides cached CPU count).
     * @param {QuarantineService|null} [quarantine=null] - Optional quarantine service for broken images.
     */
    constructor(db, config, logger, system = null, quarantine = null) {
        this.db = db
        this.config = config
        this.logger = logger || console
        this.system = system
        this.quarantine = quarantine
    }

    /**
     * Recursively scan directories for image files matching the given extensions.
     * @param {string[]} directories - Directories to scan.
     * @param {string[]} extensions - Allowed file extensions (e.g., ['.jpg', '.png']).
     * @returns {string[]} Absolute paths to discovered image files.
     */
    #scanImageFiles(directories, extensions) {
        const imageFiles = []
        for (const dir of directories) {
            this.#walkDirectory(dir, extensions, imageFiles)
        }
        return imageFiles
    }

    /**
     * Recursively walk a directory tree, collecting image file paths.
     * Skips directories listed in IMAGE_DIRECTORY_EXCLUSIONS config.
     * @param {string} dir - Directory to walk.
     * @param {string[]} extensions - Allowed file extensions.
     * @param {string[]} results - Accumulator array pushed with found paths.
     */
    #walkDirectory(dir, extensions, results) {
        const exclusions = this.config.settings.imageDirectoryExclusions
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
                if (entry.name === "." || entry.name === ".." ||
                    (entry.isDirectory() && exclusions.includes(entry.name))) {
                    continue
                }
                const fullPath = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    this.#walkDirectory(fullPath, extensions, results)
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase()
                    if (extensions.includes(ext)) {
                        results.push(path.resolve(fullPath))
                    }
                }
            }
        } catch (err) {
            this.logger.warn(`Could not read directory: ${dir} (${err.message})`, 'ImageIndexer')
        }
    }

    /**
     * Determine which images need processing by comparing current file sizes against stored values.
     * Files missing from the database or with changed sizes are included.
     * @param {string[]} imagePaths - All discovered image paths.
     * @returns {string[]} Paths that need indexing.
     */
    #getFilesToProcess(imagePaths) {
        const needsProcessing = []
        for (const imgPath of imagePaths) {
            try {
                const stat = fs.statSync(imgPath)
                const currentSize = stat.size
                const storedSize = this.db.getImageFilesize(imgPath)
                if (storedSize !== null && storedSize === currentSize) {
                    continue
                }
                needsProcessing.push(imgPath)
            } catch {
                needsProcessing.push(imgPath)
            }
        }
        return needsProcessing
    }

    /**
     * Spawn worker threads and dispatch image files for parallel metadata extraction.
     * @param {number} numWorkers - Number of worker threads to spawn.
     * @param {string[]} queue - File paths to process.
     * @returns {Promise<void>} Resolves when all workers finish.
     */
    #processQueue(numWorkers, queue) {
        return new Promise((resolve) => {
            const totalItems = queue.length
            let completed = 0
            if (totalItems === 0) {
                resolve()
                return
            }
            const workerPath = path.resolve(__dirname, "..", "workers", "imageIndexerWorker.cjs")
            for (let i = 0; i < numWorkers; i++) {
                const worker = new Worker(workerPath)
                this.#workers.push(worker)
                this.#busyWorkers.add(worker)
                // Send init message with relevant config settings to the worker
                worker.postMessage({
                    type: "init",
                    config: {
                        imagickBin: this.config.settings.imagickBin,
                    },
                })
                worker.on("message", (msg) => {
                    if (msg.type === "result") {
                        if (msg.success) {
                            this.#emitNotes(msg.data.notes)
                            this.db.insertImage(msg.data)
                        } else {
                            // Surface classified child-process output at proper levels first
                            this.#emitNotes(msg.data.notes)
                            this.logger.warn(`Failed to index: ${msg.data.path} (${msg.data.error})`, 'ImageIndexer')
                            this.#quarantineIfBroken(msg.data.path)
                        }
                        completed++
                        this.#busyWorkers.delete(worker)
                        this.#dispatchNext(worker, queue)
                        if (completed >= totalItems) {
                            this.terminateAllWorkers()
                            resolve()
                        }
                    }
                })
                worker.on("error", (err) => {
                    this.logger.error(`Worker error: ${err.message}`, 'ImageIndexer')
                    completed++
                    this.#busyWorkers.delete(worker)
                    if (completed >= totalItems) {
                        this.terminateAllWorkers()
                        resolve()
                    }
                })
            }
            for (const worker of this.#workers) {
                this.#dispatchNext(worker, queue)
            }
        })
    }

    /**
     * Dispatch the next file from the queue to a specific worker thread.
     * @param {Worker} worker - Target worker instance.
     * @param {string[]} queue - Remaining file paths.
     */
    #dispatchNext(worker, queue) {
        const idx = this.#nextIndex
        if (idx < queue.length) {
            worker.postMessage({ type: "index", path: queue[idx] })
            this.#nextIndex = idx + 1
        }
    }

    /**
     * Terminate all active worker threads and reset internal state.
     */
    terminateAllWorkers() {
        for (const worker of this.#workers) {
            try { worker.terminate() } catch {}
        }
        this.#workers = []
        this.#busyWorkers.clear()
        this.#nextIndex = 0
    }

    /**
     * Relay classified child-process stderr notes from a worker through the logger.
     * @param {Array<{context?: string, errors: string[], warnings: string[]}>|undefined} notes
     */
    #emitNotes(notes) {
        for (const note of notes ?? []) {
            emitClassified(this.logger, { errors: note.errors || [], warnings: note.warnings || [] }, 'ImageIndexer')
        }
    }

    /**
     * Move an image that exists but failed to decode into quarantine and drop its catalog row.
     * Best-effort -- never throws; no-op when quarantine is disabled/unavailable.
     * @param {string|null} filePath - Path reported by the worker.
     */
    #quarantineIfBroken(filePath) {
        if (!this.quarantine || !filePath) return
        try {
            if (!this.quarantine.canQuarantine(filePath)) return
            const dest = this.quarantine.quarantine(filePath)
            if (dest) void this.db.removeImage(filePath)
        } catch (err) {
            this.logger.warn(`Quarantine check skipped for ${filePath}: ${err.message}`, 'ImageIndexer')
        }
    }

    /**
     * Perform a full indexing pass: scan directories, detect changed files,
     * extract metadata via workers, insert into database, then clean stale entries.
     * @param {string[]|null} [directories=null] - Optional directory override (from CLI --dir).
     */
    async reIndex(directories) {
        await this.db.initialize()
        const s = this.config.settings
        const dirsToScan = directories && directories.length > 0
            ? directories : s.imageDirectories
        if (dirsToScan !== s.imageDirectories) {
            this.logger.log(`Using CLI directory override: ${dirsToScan.join(", ")}`, 'ImageIndexer')
        }
        const extensions = s.imageExtensions
        const allImages = this.#scanImageFiles(dirsToScan, extensions)
        this.logger.log(`Found ${allImages.length} image file(s)`, 'ImageIndexer')
        if (allImages.length === 0) return
        const toProcess = this.#getFilesToProcess(allImages)
        this.logger.log(`${toProcess.length} file(s) need indexing (${allImages.length - toProcess.length} unchanged)`, 'ImageIndexer')
        if (toProcess.length > 0) {
            const cpuCount = this.system.cpu.cores
            this.logger.log(`Using ${cpuCount} CPU core(s)`, 'ImageIndexer')
            await this.#processQueue(cpuCount, toProcess)
        }
        this.logger.log('Indexing complete', 'ImageIndexer')
        await this.cleanupStaleEntries()
    }

    /**
     * Remove database entries for image files that no longer exist on disk.
     */
    async cleanupStaleEntries() {
        await this.db.initialize()
        const rows = this.db.execute("SELECT path FROM images")
        if (rows.length === 0) return
        let removed = 0
        for (const row of rows) {
            try {
                fs.accessSync(row.path, fs.constants.F_OK)
            } catch {
                await this.db.removeImage(row.path)
                removed++
                this.logger.log(`Removed stale entry: ${row.path}`, 'ImageIndexer')
            }
        }
        this.logger.log(`Cleanup complete: ${removed} stale entr${removed === 1 ? "y" : "ies"} removed`, 'ImageIndexer')
    }
}

export default ImageIndexer