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

import { getEligibleProfileNames, selectRandomProfile, getProfileAttemptOrder, RANDOM_EXCLUDE_KEY } from "../lib/profilePicker.js"
import { validateDisplays } from "../lib/displayConfig.js"

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

/**
 * Profile keys that control selection behavior rather than runtime settings.
 * They are read by ConfigService/picker logic but must not leak into `.settings`.
 * @type {Set<string>}
 */
const PROFILE_META_KEYS = new Set([RANDOM_EXCLUDE_KEY])

/**
 * Merge a profile object onto base settings, skipping meta-keys (e.g.,
 * `excludeFromRandom`) and undefined values. Pure -- inputs are not mutated.
 * @param {object} baseSettings - Base configuration object to merge onto.
 * @param {object} [profile={}] - Profile overrides from profiles.js.
 * @returns {object} New merged settings object.
 */
export function applyProfileOverrides(baseSettings, profile = {}) {
    const merged = { ...baseSettings }
    for (const [key, value] of Object.entries(profile || {})) {
        if (value !== undefined && !PROFILE_META_KEYS.has(key)) {
            merged[key] = value
        }
    }
    return merged
}

class ConfigService {
    /**
     * A profile is ALWAYS resolved and merged: even in `--directory` mode the
     * selected profile still supplies strategies, upscaler model/args etc. --
     * only its imageDirectories get replaced by the CLI override below.
     *
     * @param {string|null} profileName - Profile key from profiles.js. Pass null to use the first (implicit default) profile.
     * @param {object} [cliOverrides={}] - CLI argument overrides ({debug?: boolean, strategy?: string, imageDirectories?: string[]})
     */
    constructor(profileName, cliOverrides = {}) {
        this.settings = { ...config }

        // Apply profile overrides (strategies, upscaler, exclusions, ...)
        const resolvedProfile = this._resolveProfile(profileName)
        this.settings = applyProfileOverrides(this.settings, profiles[resolvedProfile] || {})
        this._profileName = resolvedProfile

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

        // Fail fast on malformed display dimensions before any service consumes them;
        // otherwise they surface later as obscure ImageMagick geometry errors.
        validateDisplays(this.settings.displays)
    }

    /**
     * Get the active profile name. A profile is always resolved; only an empty
     * profiles.js can yield "".
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
     * List profiles eligible for random selection (`excludeFromRandom !== true`).
     * @returns {string[]}
     */
    static listEligibleProfiles() {
        return getEligibleProfileNames(profiles)
    }

    /**
     * Pick a random profile among those not marked `excludeFromRandom`.
     * Falls back to the implicit default (first) profile when nothing is eligible.
     * @param {{excludeName?: string|null}} [options={}] - Previously picked profile name to avoid repeating.
     * @returns {string} Profile name ("" when no profiles are defined at all).
     */
    static pickRandomProfile({ excludeName = null } = {}) {
        return selectRandomProfile(profiles, { excludeName })
    }

    /**
     * Rotation-aware profile attempt order for unattended runs (see profilePicker):
     * shuffled eligible profiles with the previous pick rotated to the end.
     * @param {{excludeName?: string|null}} [options={}] - Previously picked profile name to rotate away from.
     * @returns {string[]} Ordered candidate profiles ([] when no profiles are defined).
     */
    static getProfileAttemptOrder({ excludeName = null } = {}) {
        return getProfileAttemptOrder(profiles, { excludeName })
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