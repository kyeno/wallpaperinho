"use strict"
/**
 * Quarantine Service
 *
 * Moves images that exist on disk but cannot be decoded by ImageMagick out of the
 * scanned library so they stop failing every indexing/generation cycle; callers are
 * expected to drop the matching catalog row afterwards. Enabled by default -- set
 * `quarantineBrokenImages: false` in config/profile to opt out.
 *
 * Safety rails (everything is best-effort -- failures never break the pipeline):
 *   - only files under one of the configured imageDirectories are ever moved
 *   - target name collisions get "<unixtime>_<name>" then "_2", "_3"... suffixes
 *   - cross-device moves fall back to copy+unlink (EXDEV)
 *   - the original file is removed only after the destination exists
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Default quarantine location when `quarantinedImagesDirectory` is unset/empty. */
export function defaultQuarantineDir() {
    return path.join(os.homedir(), "Pictures", "Quarantined")
}

class QuarantineService {
    /**
     * Create a new QuarantineService.
     * @param {ConfigService} config - Must expose settings.quarantineBrokenImages / quarantinedImagesDirectory / imageDirectories.
     * @param {LoggerService|object} logger - Logger with warn/error(message, tag).
     */
    constructor(config, logger) {
        this.config = config
        this.logger = logger || console
    }

    /** True unless explicitly disabled via `quarantineBrokenImages: false`. */
    get enabled() {
        return this.config?.settings?.quarantineBrokenImages !== false
    }

    /** Resolve (and create) the quarantine directory; null when it cannot be created. */
    #resolveDir() {
        const s = this.config?.settings ?? {}
        const configured = typeof s.quarantinedImagesDirectory === "string" && s.quarantinedImagesDirectory.trim() !== ""
            ? s.quarantinedImagesDirectory
            : defaultQuarantineDir()
        const dir = path.resolve(configured)
        try {
            fs.mkdirSync(dir, { recursive: true })
            return dir
        } catch (err) {
            this.logger.warn(`Quarantine unavailable (${dir}): ${err.message}`, 'Quarantine')
            return null
        }
    }

    /** True when p is an existing file inside one of the configured image directories. */
    #isInsideImageDirs(p) {
        if (!p) return false
        const dirs = this.config?.settings?.imageDirectories ?? []
        const target = path.resolve(p)
        for (const d of dirs) {
            if (typeof d !== "string" || !d.trim()) continue
            const base = path.resolve(d).replace(/[\\/]+$/, "")
            if (target === base || target.startsWith(base + path.sep)) return true
        }
        return false
    }

    /** Pick a non-colliding destination name inside dir for the given basename. */
    #uniqueTarget(dir, name) {
        let target = path.join(dir, name)
        if (!fs.existsSync(target)) return target
        // First collision -> "<unixtime>_<name>"; further collisions -> "_2", "_3"...
        const ts = Math.floor(Date.now() / 1000)
        const ext = path.extname(name)
        const stem = path.basename(name, ext)
        target = path.join(dir, `${ts}_${name}`)
        let n = 2
        while (fs.existsSync(target)) {
            target = path.join(dir, `${stem}_${n}${ext}`)
            n++
        }
        return target
    }

    /**
     * Check whether this file is eligible for quarantine: feature enabled, exists as a
     * regular file, and lives under one of the configured image directories.
     * @param {string} filePath - Absolute path to check.
     * @returns {boolean}
     */
    canQuarantine(filePath) {
        if (!this.enabled || !filePath) return false
        if (!this.#isInsideImageDirs(filePath)) return false
        try {
            return fs.statSync(filePath).isFile()
        } catch {
            return false
        }
    }

    /**
     * Move a broken image into the quarantine directory. Best-effort -- never throws.
     * @param {string} filePath - Absolute path to the offending file.
     * @returns {string|null} Destination path on success; null when skipped or failed.
     */
    quarantine(filePath) {
        if (!this.canQuarantine(filePath)) return null
        const dir = this.#resolveDir()
        if (!dir) return null
        try {
            const dest = this.#uniqueTarget(dir, path.basename(filePath))
            try {
                fs.renameSync(filePath, dest)
            } catch (err) {
                if (err.code !== "EXDEV") throw err
                // Cross-device move: copy first, remove original only after it exists at destination
                fs.copyFileSync(filePath, dest)
                fs.unlinkSync(filePath)
            }
            this.logger.warn(`Quarantined broken image ${filePath} -> ${dest}`, 'Quarantine')
            return dest
        } catch (err) {
            this.logger.error(`Failed to quarantine ${filePath}: ${err.message}`, 'Quarantine')
            return null
        }
    }
}

export default QuarantineService