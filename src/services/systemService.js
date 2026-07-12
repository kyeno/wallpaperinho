"use strict"
/**
 * System Service
 *
 * Centralized system detection and validation service. Runs early in the
 * application lifecycle (after ConfigService) and caches all results so that
 * downstream services can consume them without re-detecting.
 *
 * Detections performed:
 *   - ImageMagick: binary configured, accessible, executable, version >= 7
 *   - NCNN upscaler: binary configured, accessible, model dir exists, model files present
 *   - CPU: number of cores available
 *   - Desktop environment: detected from $XDG_CURRENT_DESKTOP + setter tool availability
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import fs from "node:fs"
import os from "node:os"
import { execFileSync } from "node:child_process"

class SystemExitError extends Error {}

class SystemService {
    // ---- Immutable detection results ----

    /** @type {{available: boolean; path: string; version: string|null}} */
    imagick = null

    /** @type {{configured: boolean; accessible: boolean; modelDirExists: boolean; modelFilesExist: boolean; path?: string; model?: string}} */
    ncnn = null

    /** @type {{cores: number}} */
    cpu = null

    /** @type {{environment: string|null; supported: boolean; isCinnamon: boolean; canSetWallpaper: boolean; setterBinary?: string}} */
    desktop = null


    // ========================================================================
    // Public initialization
    // ========================================================================

    /**
     * Run all system checks and cache results.
     * @param {ConfigService} config - Must expose settings.*
     * @param {*} logger - Logger with .log(), .warn(), .error() methods (may be console as fallback)
     * @throws {SystemExitError} On fatal misconfigurations (e.g., bad ImageMagick)
     */
    initialize(config, logger) {
        const s = config.settings
        this.imagick  = this.#detectImageMagick(s, logger)
        this.ncnn     = this.#detectNcnn(s, logger)
        this.cpu      = this.#detectCPU(logger)
        this.desktop  = this.#detectDesktop(logger)

        // ---- Fatal checks ----
        if (!this.imagick.available) {
            const msg = this.imagick.version
                ? `ImageMagick version ${this.imagick.version} detected. ImageMagick 7.x or higher is required.`
                : "ImageMagick is not configured, not found, or not executable."
            logger.error(`FATAL: ${msg}`, 'SystemService')
            throw new SystemExitError(msg)
        }

        return this
    }

    // ========================================================================
    // ImageMagick detection
    // ========================================================================

    /**
     * @param {object} settings
     * @param {*} logger
     * @returns {{available: boolean; path: string; version: string|null}}
     */
    #detectImageMagick(settings, logger) {
        const binPath = settings.imagickBin

        if (!binPath || typeof binPath !== "string" || binPath.trim() === "") {
            return { available: false, path: "", version: null }
        }

        // Check accessible + executable
        try {
            fs.accessSync(binPath, fs.constants.X_OK)
        } catch {
            logger.error(`ImageMagick binary not found or not executable: ${binPath}`, 'SystemService')
            return { available: false, path: binPath, version: null }
        }

        // Check version
        try {
            const output = execFileSync(binPath, ["--version"]).toString().trim()
            const firstLine = output.split("\n")[0]
            // "Version: ImageMagick 7.1.1-35 Q16-hdri https://imagemagick.org"
            const match = firstLine.match(/ImageMagic[k]?s?\s+(\d+)\./i)
            if (match) {
                const major = parseInt(match[1], 10)
                const ok = major >= 7
                logger.log(
                    `ImageMagick ${major}. detected at ${binPath} ` +
                    `(${ok ? "OK" : "- requires v7+"})`, 'SystemService'
                )
                return { available: ok, path: binPath, version: `${major}.` }
            }
            logger.warn(`Could not parse ImageMagick version from: ${firstLine}`, 'SystemService')
            return { available: false, path: binPath, version: "unknown" }
        } catch (err) {
            logger.error(`Failed to query ImageMagick version: ${err.message}`, 'SystemService')
            return { available: false, path: binPath, version: null }
        }
    }

    // ========================================================================
    // NCNN upscaler detection
    // ========================================================================

    /**
     * @param {object} settings
     * @param {*} logger
     * @returns {{configured: boolean; accessible: boolean; modelDirExists: boolean; modelFilesExist: boolean; path?: string; model?: string}}
     */
    #detectNcnn(settings, logger) {
        const bin = settings.ncnnUpscalerBin
        const configured = typeof bin === "string" && bin.trim() !== ""

        if (!configured) {
            logger.log("NCNN upscaler not configured - images will not be AI-upscaled", 'SystemService')
            return { configured: false, accessible: false, modelDirExists: false, modelFilesExist: false }
        }

        const result = {
            configured: true,
            accessible: false,
            modelDirExists: false,
            modelFilesExist: false,
            path: bin,
            model: settings.ncnnUpscalerModel || null,
        }

        // Check binary accessible + executable
        try {
            fs.accessSync(bin, fs.constants.X_OK)
            result.accessible = true
        } catch {
            logger.warn(`NCNN upscaler binary not found or not executable: ${bin}`, 'SystemService')
        }

        // Check model directory exists
        const modelDir = settings.ncnnUpscalerModelDir
        if (modelDir) {
            try {
                const stat = fs.statSync(modelDir)
                if (stat.isDirectory()) {
                    result.modelDirExists = true
                } else {
                    logger.warn(`NCNN model path is not a directory: ${modelDir}`, 'SystemService')
                }
            } catch {
                logger.warn(`NCNN model directory does not exist: ${modelDir}`, 'SystemService')
            }

            // Check model files (.bin and .param)
            const model = settings.ncnnUpscalerModel
            if (model && result.modelDirExists) {
                const binFile  = `${model}.bin`
                const paramFile = `${model}.param`
                const binPath  = `${modelDir}/${binFile}`
                const paramPath = `${modelDir}/${paramFile}`

                let binOk = false, paramOk = false
                try { fs.accessSync(binPath, fs.constants.F_OK); binOk = true } catch {}
                try { fs.accessSync(paramPath, fs.constants.F_OK); paramOk = true } catch {}

                if (binOk && paramOk) {
                    result.modelFilesExist = true
                    logger.log(`NCNN upscaler OK - binary at ${bin}, model "${model}" found in ${modelDir}`, 'SystemService')
                } else {
                    const missing = []
                    if (!binOk) missing.push(binFile)
                    if (!paramOk) missing.push(paramFile)
                    logger.warn(
                        `NCNN model "${model}" incomplete - missing: ${missing.join(", ")} ` +
                        `(expected in ${modelDir})`, 'SystemService'
                    )
                }
            }
        } else if (result.accessible) {
            logger.log(`NCNN upscaler binary accessible at ${bin} (no model dir configured)`, 'SystemService')
        }

        // Summary warning if configured but not fully usable
        if (configured && !result.accessible) {
            logger.warn("NCNN upscaler is configured but not accessible - quality may be compromised", 'SystemService')
        }

        return result
    }

    // ========================================================================
    // CPU detection
    // ========================================================================

    /**
     * @param {*} logger
     * @returns {{cores: number}}
     */
    #detectCPU(logger) {
        let cores
        try {
            const content = fs.readFileSync("/proc/cpuinfo", "utf8")
            const count = (content.match(/^processor/gm) || []).length
            cores = Math.max(count, 1)
        } catch {
            cores = os.cpus().length || 1
        }
        logger.log(`Detected ${cores} CPU core(s)`, 'SystemService')
        return { cores }
    }

    // ========================================================================
    // Desktop environment detection
    // ========================================================================

    /**
     * Map of DE identifiers to the binaries they need for wallpaper setting.
     * Exposed publicly so WallpaperSetter can validate tool availability without
     * duplicating this mapping.
     */
    /** @type {object} Map of DE identifiers to required setter binaries */
    static DE_TOOLS = Object.freeze({
        cinnamon: ["gsettings"],
        gnome:    ["gsettings"],
        kde:      ["plasma-apply-wallpaperimage", "qdbus"],   // either works
        xfce:     ["xfconf-query"],
        hyprland: ["hyprctl"],
    })

    /**
     * Check if any required setter tool is available for a given desktop environment.
     * @param {string} env - Normalized environment identifier (e.g., "cinnamon", "kde").
     * @returns {{available: boolean, binary?: string}} Result with first working binary.
     */
    static checkDeTools(env) {
        const tools = SystemService.DE_TOOLS[env]
        if (!tools || tools.length === 0) {
            return { available: false }
        }

        for (const tool of tools) {
            try {
                execFileSync(tool, ["--version"], { timeout: 5000 })
                return { available: true, binary: tool }
            } catch {
                // Try next fallback tool
            }
        }

        return { available: false }
    }

    /**
     * @param {*} logger
     * @returns {{environment: string|null; supported: boolean; isCinnamon: boolean; canSetWallpaper: boolean; setterBinary?: string}}
     */
    #detectDesktop(logger) {
        const xdg = process.env.XDG_CURRENT_DESKTOP?.toUpperCase() || ""
        let env = null

        if (xdg.includes("CINNAMON"))       env = "cinnamon"
        else if (xdg.includes("GNOME"))     env = "gnome"
        else if (xdg.includes("KDE") || xdg.includes("PLASMA")) env = "kde"
        else if (xdg.includes("XFCE"))      env = "xfce"
        else if (xdg.includes("HYPRLAND"))  env = "hyprland"

        const result = {
            environment: env,
            supported: !!env,
            isCinnamon: env === "cinnamon",
            canSetWallpaper: false,
        }

        if (!env) {
            logger.warn(
                `Could not detect desktop environment ` +
                `(XDG_CURRENT_DESKTOP="${process.env.XDG_CURRENT_DESKTOP}")`, 'SystemService'
            )
            return result
        }

        logger.log(`Detected desktop environment: ${env}`, 'SystemService')

        // Warn on non-Cinnamon DEs
        if (!result.isCinnamon) {
            logger.warn(
                `Desktop support for ${env} is experimental and may have limited functionality. ` +
                `Cinnamon is the primary tested environment.`, 'SystemService'
            )
        }

        // Check that required setter binary is accessible
        const tools = SystemService.DE_TOOLS[env]
        if (tools && tools.length > 0) {
            for (const tool of tools) {
                try {
                    execFileSync(tool, ["--version"], { timeout: 5000 })
                    result.canSetWallpaper = true
                    result.setterBinary = tool
                    logger.log(`Wallpaper setter tool available: ${tool}`, 'SystemService')
                    break
                } catch {
                    // Try next fallback tool
                }
            }

            if (!result.canSetWallpaper) {
                logger.warn(
                    `Desktop is ${env} but none of the required tools are accessible: ${tools.join(", ")} ` +
                    `- wallpaper cannot be set automatically`, 'SystemService'
                )
            }
        }

        return result
    }

}

export default SystemService
export { SystemExitError }
