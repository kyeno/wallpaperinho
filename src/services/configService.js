"use strict"
/**
 * Configuration Service
 *
 * Resolves the effective configuration by merging:
 *   1. Base config (./config.js)
 *   2. Selected profile overrides (./profiles.js)
 *   3. CLI argument overrides
 *
 * Exposes the merged result as a plain `.settings` object for dot-notation access.
 * Provides a few derived helpers (ncnn command assembly, debug flag logic).
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ETC_DIR = path.resolve(__dirname, "..", "..", "etc")

const configPath = path.join(ETC_DIR, "config.js")
const profilesPath = path.join(ETC_DIR, "profiles.js")

// Validate required configuration files exist before proceeding
const missingFiles = []
if (!fs.existsSync(configPath)) {
    missingFiles.push("config.js")
}
if (!fs.existsSync(profilesPath)) {
    missingFiles.push("profiles.js")
}

if (missingFiles.length > 0) {
    console.error("[FATAL] Required configuration file(s) missing:")
    missingFiles.forEach((f) => console.error(`  - etc/${f}`))
    console.error("")
    console.error("Did you forget to copy the example configuration file(s)?")
    const exampleMap = { "config.js": "config.example.js", "profiles.js": "profiles.example.js" }
    missingFiles.forEach((f) => console.error(`  cp etc/${exampleMap[f]} etc/${f}`))
    process.exit(1)
}

// Dynamic imports using resolved absolute paths
const { config } = await import(configPath)
const { profiles } = await import(profilesPath)

/**
 * Valid image matching strategy names.
 * @type {string[]}
 */
const VALID_STRATEGIES = ["random", "colorHSL", "colorPalette", "contrast", "canny", "entropy", "gemini"]

class ConfigService {
    /**
     * @param {string|null} profileName - Profile key from profiles.js. Pass null to use the first (implicit default) profile.
     * @param {object} [cliOverrides={}] - CLI argument overrides ({debug?: boolean, strategy?: string, imageDirectories?: string[]})
     */
    constructor(profileName, cliOverrides = {}) {
        // If --directory was provided via CLI, skip profile merging entirely
        // and just use base config + CLI overrides
        const hasDirectoryOverride = cliOverrides.imageDirectories && cliOverrides.imageDirectories.length > 0

        this.settings = { ...config }

        if (!hasDirectoryOverride) {
            // Normal mode: apply profile overrides
            const resolvedProfile = this._resolveProfile(profileName)
            const profile = profiles[resolvedProfile] || {}

            for (const [key, value] of Object.entries(profile)) {
                if (value !== undefined) {
                    this.settings[key] = value
                }
            }

            this._profileName = resolvedProfile
        } else {
            // Directory override mode: no profile applied
            this._profileName = null
        }

        // Apply CLI overrides last
        if (cliOverrides.imageDirectories && cliOverrides.imageDirectories.length > 0) {
            this.settings.imageDirectories = cliOverrides.imageDirectories
        }
        if (cliOverrides.strategy) {
            this.settings.imageMatchingStrategy = cliOverrides.strategy
        }
        if (cliOverrides.debug) {
            this.settings.debugOverlay = true
        }
    }

    /**
     * Get the active profile name. Returns null when no profile is active (e.g., --directory bypass).
     * @returns {string|null}
     */
    getProfileName() {
        return this._profileName
    }

    // ------------------------------------------------------------------
    // Static helpers

    /**
     * List all available profile names.
     * @returns {string[]}
     */
    static listProfiles() {
        return Object.keys(profiles || {})
    }

    /**
     * Return the default (first) profile name.
     * @returns {string}
     */
    static getDefaultProfile() {
        const keys = Object.keys(profiles || {})
        return keys[0] || ""
    }

    // ------------------------------------------------------------------
    // Derived / computed accessors

    /**
     * Check whether ncnn upscaler is configured (binary path set and non-empty).
     * @returns {boolean}
     */
    isNcnnConfigured() {
        const bin = this.settings.ncnnUpscalerBin
        return typeof bin === "string" && bin.trim() !== ""
    }

    /**
     * Build the ncnn upscaler base arguments (without input/output).
     * Format: [-m MODEL_DIR -n MODEL -s SCALE FLAGS...]
     * @returns {string[]}
     */
    getNcnnUpscalerArgs() {
        if (!this.isNcnnConfigured()) {
            return []
        }

        const args = []
        const s = this.settings

        if (s.ncnnUpscalerModelDir) {
            args.push("-m", s.ncnnUpscalerModelDir)
        }
        if (s.ncnnUpscalerModel) {
            args.push("-n", s.ncnnUpscalerModel)
        }
        if (s.ncnnUpscalerScale) {
            args.push("-s", s.ncnnUpscalerScale)
        }
        if (s.ncnnUpscalerFlags && typeof s.ncnnUpscalerFlags === "string" && s.ncnnUpscalerFlags.trim()) {
            args.push(...s.ncnnUpscalerFlags.trim().split(/\s+/))
        }

        return args
    }

    /**
     * Build the complete ncnn command with input/output paths appended.
     * Returns [base_args..., "-i", inputPath, "-o", outputPath].
     * @param {string} inputPath
     * @param {string} outputPath
     * @returns {string[]}
     */
    getNcnnUpscalerCommand(inputPath, outputPath) {
        const baseArgs = this.getNcnnUpscalerArgs()
        if (baseArgs.length === 0) {
            return []
        }
        return [...baseArgs, "-i", inputPath, "-o", outputPath]
    }

    // ------------------------------------------------------------------
    // Internal

    /**
     * Resolve a profile name: null → first profile, string → validate existence.
     * @param {string|null} profileName
     * @returns {string}
     */
    _resolveProfile(profileName) {
        if (!profileName || !(profileName in profiles)) {
            return ConfigService.getDefaultProfile()
        }
        return profileName
    }
}

export default ConfigService