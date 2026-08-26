#!/usr/bin/env node
/**
 * WALLPAPERINHO -- Programmatic multi-monitor wallpaper automation.
 * Entry point that wires all dependencies together and triggers the pipeline.
 * @author Ratan M. Kyeno
 * @license MIT
 */
"use strict"

import { parseArgs } from "node:util"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Load ASCII assets
const WALLPAPERINHO_ART = fs.readFileSync(path.resolve(__dirname, "ascii", "art.txt"), "utf8")
const HELP_TEXT = fs.readFileSync(path.resolve(__dirname, "ascii", "help.txt"), "utf8")

// --- Composition imports ---
import ConfigService from "./services/configService.js"
import SystemService, { SystemExitError } from "./services/systemService.js"
import Database from "./services/databaseService.js"
import LoggerService from "./services/loggerService.js"
import ImageIndexer from "./lib/imageIndexer.js"
import ImageProcessor from "./lib/imageProcessor.js"
import ImageSelector from "./lib/imageSelector.js"
import DisplayAssignment from "./lib/displayAssignment.js"
import WallpaperGenerator from "./lib/wallpaperGenerator.js"
import WallpaperSetter from "./lib/wallpaperSetter.js"
import QuarantineService from "./lib/quarantineService.js"
import { resolvePoolScope } from "./lib/poolScope.js"

const DB_DIR = path.resolve(__dirname, "..", "var", "db")
const STATE_FILE = path.resolve(__dirname, "..", "var", "state", "last-profile.json")

/**
 * Compute a short SHA-1 hash from an array of directory paths.
 * @param {string[]} dirs - Directory paths to hash.
 * @returns {string} First 8 hex characters of the SHA-1 digest.
 */
function directoriesHash(dirs) {
    const sorted = [...dirs].sort()
    const raw = sorted.join("\n")
    return crypto.createHash("sha1").update(raw).digest("hex").substring(0, 8)
}

/**
 * Read the profile name persisted by the previous successful random run.
 * Best-effort: any problem (missing file, bad JSON) yields null.
 * @returns {string|null}
 */
function readLastPickedProfile() {
    try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
        return typeof data.profile === "string" && data.profile ? data.profile : null
    } catch {
        return null
    }
}

/**
 * Persist the randomly picked profile so the next run can rotate away from it.
 * Best-effort state -- failures never break the wallpaper pipeline.
 * @param {string} profileName
 * @returns {boolean} True when the state was written successfully.
 */
function writeLastPickedProfile(profileName) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
        fs.writeFileSync(
            STATE_FILE,
            JSON.stringify({ profile: profileName, at: new Date().toISOString() }, null, 4) + "\n"
        )
        return true
    } catch {
        return false
    }
}

/**
 * Main entry point -- DI composition root.
 */
async function main() {
    const knownFlags = new Set(["--debug", "--noindex", "--recreate", "--profile", "--directory", "--strategy", "--help", "--list-profiles", "--silent", "--random", "--cron"])
    const knownFlagLongValues = new Set(["--profile", "--directory", "--strategy"])

    // Detect unknown arguments
    const unknownArgs = []
    let skipNext = false
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]
        if (skipNext) {
            skipNext = false
            continue
        }
        if (arg.startsWith("--")) {
            const key = arg.split("=")[0]
            if (!knownFlags.has(key)) {
                unknownArgs.push(key)
            } else if (knownFlagLongValues.has(key) && !arg.includes("=")) {
                skipNext = true
            }
        }
    }

    if (unknownArgs.length > 0) {
        const names = [...new Set(unknownArgs)].map((n) => `  ${n}`).join("\n")
        console.warn(`[main] Warning: Unknown argument(s):\n${names}`)
        console.log()
        console.log(HELP_TEXT)
        return
    }

     const { values } = parseArgs({
        options: {
            debug:       { type: "boolean", default: false },
            noindex:     { type: "boolean", default: false },
            recreate:    { type: "boolean", default: false },
            profile:     { type: "string",  default: "default" },
            directory:   { type: "string",  multiple: true },
            strategy:    { type: "string" },
            silent:      { type: "boolean", default: false },
            random:      { type: "boolean", default: false },
            cron:        { type: "boolean", default: false },
            help:        { type: "boolean", default: false },
            "list-profiles": { type: "boolean", default: false },
        },
        allowPositionals: true,
    })

    // --cron is sugar for unattended runs: quiet logging + random profile rotation
    if (values.cron) {
        values.silent = true
        values.random = true
    }

    // Banner prints after arg parsing so --silent can suppress it.
    if (!values.silent) {
        console.log(WALLPAPERINHO_ART)
    }

    if (values.help) {
        console.log(HELP_TEXT)
        return
    }

    if (values["list-profiles"]) {
        const profiles = ConfigService.listProfiles()
        const eligible = new Set(ConfigService.listEligibleProfiles())
        const width = profiles.length > 0 ? Math.max(...profiles.map((name) => name.length)) : 0
        console.log("Available profiles:")
        for (const name of profiles) {
            const marker = eligible.has(name) ? "[in random pool]" : "[excluded from random]"
            console.log(`  - ${name.padEnd(width)} ${marker}`)
        }
        if (profiles.length > 0 && eligible.size === 0) {
            // Mirrors the runtime fallback warning below -- bare runs still work via the implicit default.
            console.warn("[main] All profiles are excluded from random selection -- bare runs fall back to the first profile")
        }
        return
    }

    // Resolve the profile for this run:
    //   - explicit --profile <name> always wins ("default" sentinel = implicit first profile)
    //   - otherwise pick a random eligible profile (excludeFromRandom-aware), rotating
    //     away from the last successfully used one when possible (--random makes this
    //     explicit; it is also the default behavior since bare runs should surprise you).
    const explicitProfile = values.profile !== "default" ? values.profile : null
    let profileArg = explicitProfile
    let pickedRandomly = false

    if (!explicitProfile) {
        const allProfiles = ConfigService.listProfiles()
        const eligible = ConfigService.listEligibleProfiles()
        if (eligible.length === 0 && allProfiles.length > 0) {
            console.warn("[main] All profiles are excluded from random selection -- falling back to the implicit default")
        }
        const candidate = ConfigService.pickRandomProfile({ excludeName: readLastPickedProfile() })
        if (candidate) {
            profileArg = candidate
            pickedRandomly = true
        }
    }

    // --- DI Composition Root ---

    // 1. Initialize configuration with profile and CLI overrides in one call
    const config = new ConfigService(profileArg, {
        debug: values.debug,
        strategy: values.strategy,
        imageDirectories: Array.isArray(values.directory) && values.directory.length > 0
            ? values.directory
            : null,
    })

    // 2. Initialize logger (has its own TTY-based color detection).
    //    --silent/--cron raise the minimum level to WARN (banner/info/debug hidden,
    //    warnings+errors still visible) AND switch output to plain text with [LEVEL]
    //    prefixes instead of ANSI colors -- raw escape sequences read as "^[[33m..."
    //    in cron mail, so unattended runs get readable, grep-friendly labels.
    const logger = new LoggerService(config, values.silent ? "warn" : undefined, values.silent)

    if (values.debug) {
        logger.info("Debug overlay enabled via --debug flag", 'main')
    }

    if (values.strategy) {
        logger.info(`Strategy override: ${values.strategy}`, 'main')
    }

    if (pickedRandomly) {
        logger.info(`Selected random profile: ${profileArg}`, 'main')
    } else if (values.random && explicitProfile) {
        logger.info("Both --profile and --random given -- using explicit profile", 'main')
    }

    const activeDirs = config.settings.imageDirectories
    const hash = directoriesHash(activeDirs)
    const dbPath = path.join(DB_DIR, `images-${hash}.sqlite3`)
    const activeProfile = config.getProfileName()

    logger.info(`Profile: ${activeProfile || "(none)"}`, 'main')
    logger.info(`Image source director${activeDirs.length > 1 ? "ies" : "y"}: ${activeDirs.join(", ")}`, 'main')
    logger.info(`Database: ${dbPath}`, 'main')

    // Record the resolved profile in the logger so unattended WARN/ERROR lines can name it
    // (image directories are already known to the logger from config).
    logger.setRunContext({ profile: activeProfile })

    // 3. Initialize system detection
    const system = new SystemService()
    try {
        system.initialize(config, logger)
    } catch (err) {
        if (err instanceof SystemExitError) {
            logger.error(err.message, 'main')
            process.exit(1)
        }
        throw err
    }

    // 4. Initialize remaining services with system + logger
    const db = new Database(dbPath, logger)
    const quarantine = new QuarantineService(config, logger)
    const indexer = new ImageIndexer(db, config, logger, system, quarantine)
    const processor = new ImageProcessor(config, logger, system)
    const selector = new ImageSelector(db, config, processor, logger)
    const assignment = new DisplayAssignment(config.settings.displays, logger)
    const setter = new WallpaperSetter(logger, system)
    const generator = new WallpaperGenerator(config, db, processor, selector, assignment, setter, logger, quarantine)

    // Resolve the subdirectory driving mode (imageSubdirectoryMode) and apply it as a
    // selection-time pool restriction. Indexing stays unscoped on purpose so shared
    // catalogs remain complete regardless of which mode each profile requests.
    try {
        const scope = resolvePoolScope(config.settings, { logger })
        if (scope.condition) {
            db.setScope({ condition: scope.condition, params: scope.params })
        }
        // Record the effective selection pool so unattended WARN/ERROR lines name the actual
        // directory being scanned (the random per-run pick under exclusiveFlat/exclusiveDeep).
        if (scope.chosenDir) {
            logger.setRunContext({ poolDir: scope.chosenDir })
        }
        if (scope.effectiveMode !== "include") {
            logger.info(
                `Selection pool scoped by imageSubdirectoryMode="${scope.mode}"` +
                (scope.chosenDir ? ` -- picked "${path.basename(scope.chosenDir)}"` : ""),
                'main'
            )
        }
    } catch (err) {
        logger.error(err.message, 'main')
        process.exit(1)
    }

    // Setup graceful shutdown handler now that all dependencies are initialized
    const shutdown = setupGracefulShutdown({ indexer, db, generator, logger })

    // Recreate database if requested
    if (values.recreate) {
        logger.info("--recreate: removing database file", 'main')
        db.close()
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath)
            logger.info(`Database file removed: ${dbPath}`, 'main')
        }
    }

    try {
        // Reindex unless --noindex
        if (!values.noindex) {
            await indexer.reIndex(activeDirs)
        } else {
            await db.initialize()
        }

        // Generate & set wallpapers
        const wallpaperPath = await generator.generate(activeProfile)
        if (wallpaperPath) {
            // Remember this pick so the next unattended run rotates to a different profile.
            // Only recorded for random picks -- explicit --profile runs are intentional repeats.
            if (pickedRandomly && !writeLastPickedProfile(profileArg)) {
                logger.warn("Could not persist last-picked profile state (rotation will repeat)", 'main')
            }
            logger.info(`Wallpaper set successfully: ${wallpaperPath}`, 'main')
        } else {
            logger.error("Wallpaper generation failed", 'main')
            process.exit(1)
        }
    } finally {
        // Clean up on normal exit
        shutdown()
    }
}

/**
 * Setup graceful shutdown signal handlers.
 * Returns a cleanup function that can also be called manually for normal exit.
 * @param {Object} deps - Dependencies needed for cleanup
 * @param {ImageIndexer} deps.indexer - Image indexer instance
 * @ {Database} deps.db - Database service instance
 * @param {WallpaperGenerator} deps.generator - Wallpaper generator instance (for config access)
 * @param {LoggerService} deps.logger - Logger service instance
 * @returns {Function} Cleanup function to call on shutdown
 */
function setupGracefulShutdown({ indexer, db, generator, logger }) {
    let shuttingDown = false

    const cleanup = async () => {
        if (shuttingDown) return
        shuttingDown = true

        logger.info('Shutting down gracefully...', 'main')

        try {
            // Terminate worker threads
            if (indexer && typeof indexer.terminateAllWorkers === 'function') {
                indexer.terminateAllWorkers()
                logger.log('Worker threads terminated', 'main')
            }

            // Close database connections
            if (db && typeof db.close === 'function') {
                await db.close()
                logger.log('Database connection closed', 'main')
            }

            // Clean up temp files only (not the wallpaper output directory)
            if (generator && generator.config) {
                const tempDir = generator.config.settings.tempDirectory

                if (tempDir && fs.existsSync(tempDir)) {
                    try {
                        const files = fs.readdirSync(tempDir)
                        for (const file of files) {
                            try {
                                fs.unlinkSync(path.join(tempDir, file))
                            } catch {}
                        }
                        logger.log(`Cleaned temp directory: ${tempDir}`, 'main')
                    } catch {}
                }
            }
        } catch (err) {
            logger.error(`Error during shutdown: ${err.message}`, 'main')
        } finally {
            process.exit(0)
        }
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)

    return cleanup
}

main()