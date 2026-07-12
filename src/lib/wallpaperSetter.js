"use strict"
/**
 * Wallpaper Setter
 *
 * Applies a generated wallpaper image as the desktop background.
 * Uses cached DE detection from SystemService exclusively (no duplicate detection).
 * Supports multiple desktop environments via a strategy pattern:
 * - Delegates to environment-specific setters
 * - Validates setter tool availability before selecting a strategy
 * - Allows manual override of the target environment
 *
 * Supported environments: cinnamon, gnome, kde/plasma, xfce, hyprland
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import SystemService from "../services/systemService.js"

const execFileAsync = promisify(execFile)

// ========================
// DE-Specific Strategies
// ========================

/**
 * Sets wallpaper on Cinnamon desktop via gsettings commands.
 */
class CinnamonSetter {
    constructor(logger) {
        this.logger = logger || console
    }
    async set(filePath) {
        const uri = `file://${filePath}`
        const commands = [
            ["gsettings", ["set", "org.cinnamon.desktop.background", "picture-options", "spanned"]],
            ["gsettings", ["set", "org.cinnamon.desktop.background", "picture-uri", uri]],
        ]

        for (const [bin, args] of commands) {
            try {
                await execFileAsync(bin, args, { timeout: 10000 })
            } catch (err) {
                this.logger.error(`Cinnamon: failed "${bin} ${args.join(" ")}": ${err.message}`, 'WallpaperSetter')
                return false
            }
        }

        this.logger.log(`Cinnamon wallpaper set: ${uri}`, 'WallpaperSetter')
        return true
    }
}

/**
 * Sets wallpaper on GNOME desktop via gsettings (light and dark variants).
 */
class GnomeSetter {
    constructor(logger) {
        this.logger = logger || console
    }
    async set(filePath) {
        const uri = `file://${filePath}`
        const commands = [
            ["gsettings", ["set", "org.gnome.desktop.background", "picture-uri", uri]],
            ["gsettings", ["set", "org.gnome.desktop.background", "picture-uri-dark", uri]],
        ]

        for (const [bin, args] of commands) {
            try {
                await execFileAsync(bin, args, { timeout: 10000 })
            } catch (err) {
                this.logger.error(`GNOME: failed "${bin} ${args.join(" ")}": ${err.message}`, 'WallpaperSetter')
                return false
            }
        }

        this.logger.log(`GNOME wallpaper set: ${uri}`, 'WallpaperSetter')
        return true
    }
}

/**
 * Sets wallpaper on KDE/Plasma via plasma-apply-wallpaperimage or qdbus fallback.
 * Supports both Plasma 5 and Plasma 6 D-Bus paths.
 */
class KdeSetter {
    constructor(logger) {
        this.logger = logger || console
    }
    async set(filePath) {
        // Primary: plasma-apply-wallpaperimage (works on Plasma 5 and 6)
        try {
            await execFileAsync("plasma-apply-wallpaperimage", [filePath], { timeout: 15000 })
            this.logger.log(`KDE wallpaper set via plasma-apply-wallpaperimage: ${filePath}`, 'WallpaperSetter')
            return true
        } catch (err) {
            this.logger.warn(`KDE: plasma-apply-wallpaperimage failed (${err.message}), trying qdbus...`, 'WallpaperSetter')
        }

        // Fallback chain: try Plasma 6 path first, then Plasma 5 path
        const qdbusAttempts = [
            // Plasma 6+ D-Bus API
            [
                "qdbus",
                ["org.kde.PlasmaWorkspace", "/PlasmaWorkspace", "org.kde.PlasmaWorkspace.setWallpaper", filePath]
            ],
            // Plasma 5 legacy D-Bus API
            [
                "qdbus",
                ["org.kde.plasmashell", "/ScreenSaver.org.kde.PlasmaWorkspace", "org.kde.PlasmaWorkspace.setWallpaper", filePath]
            ],
        ]

        for (const [bin, args] of qdbusAttempts) {
            try {
                await execFileAsync(bin, args, { timeout: 15000 })
                this.logger.log(`KDE wallpaper set via qdbus: ${args.join(" ")}`, 'WallpaperSetter')
                return true
            } catch (err) {
                this.logger.warn(`KDE: qdbus attempt failed (${err.message}), trying next...`, 'WallpaperSetter')
            }
        }

        this.logger.error(`KDE: all qdbus fallbacks exhausted`, 'WallpaperSetter')
        return false
    }
}

/**
 * Sets wallpaper on XFCE desktop via xfconf-query configuration keys.
 * Detects available monitors dynamically instead of hardcoding monitor0.
 */
class XfceSetter {
    constructor(logger) {
        this.logger = logger || console
    }

    /**
     * Discover active monitors by probing xfconf for existing monitor channels.
     * Falls back to ["monitor0"] if detection fails.
     * @returns {string[]} List of monitor names (e.g., ["DP-1", "HDMI-A-0"]).
     */
    async #discoverMonitors() {
        const channel = "xfce4-desktop"
        const baseProp = "/backdrop/screen0/"

        // First try to list property channels to discover monitors
        try {
            const result = await execFileAsync("xfconf-query", [
                "-c", channel,
                "-l",
                "-p", baseProp
            ], { timeout: 5000 })

            const output = result.stdout?.toString().trim() || ""
            // Output looks like: /backdrop/screen0/DP-1/workspace0/last-image
            //                    /backdrop/screen0/HDMI-A-0/workspace0/image-style
            //                    /backdrop/screen0/monitor0/workspace0/...
            const monitorPattern = new RegExp(baseProp.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '([A-Za-z0-9_-]+)(?:/|$)', 'gm')
            const monitors = new Set()
            let match

            while ((match = monitorPattern.exec(output)) !== null) {
                const name = match[1]
                // Filter out non-monitor entries (like "workspace0", "root", etc.)
                if (name.match(/^(monitor\d+|[A-Z]+-\d+|DP-\d+|HDMI[A-Z]*-\d+|VIRTUAL\d+|LVDS-\d+)/i)) {
                    monitors.add(name)
                }
            }

            if (monitors.size > 0) {
                this.logger.log(`XFCE: discovered ${monitors.size} monitor(s): ${[...monitors].join(", ")}`, 'WallpaperSetter')
                return [...monitors]
            }
        } catch (err) {
            this.logger.warn(`XFCE: monitor discovery failed (${err.message}), falling back to monitor0`, 'WallpaperSetter')
        }

        return ["monitor0"]
    }

    async set(filePath) {
        const monitors = await this.#discoverMonitors()
        const imageStyle = "3"  // 3 = stretched, matches original behavior

        for (const monitor of monitors) {
            const settings = [
                ["xfconf-query", [
                    "-c", "xfce4-desktop",
                    "-p", `/backdrop/screen0/${monitor}/workspace0/last-image`,
                    "-s", filePath
                ]],
                ["xfconf-query", [
                    "-c", "xfce4-desktop",
                    "-p", `/backdrop/screen0/${monitor}/workspace0/image-style`,
                    "-s", imageStyle
                ]],
            ]

            for (const [bin, args] of settings) {
                try {
                    await execFileAsync(bin, args, { timeout: 10000 })
                } catch (err) {
                    this.logger.error(
                        `XFCE ${monitor}: failed "${bin} ${args.join(" ")}": ${err.message}`,
                        'WallpaperSetter'
                    )
                    return false
                }
            }
        }

        this.logger.log(`XFCE wallpaper set on ${monitors.length} monitor(s): ${filePath}`, 'WallpaperSetter')
        return true
    }
}

/**
 * Sets wallpaper in Hyprland Wayland compositor via hyprctl dispatch.
 */
class HyprlandSetter {
    constructor(logger) {
        this.logger = logger || console
    }
    async set(filePath) {
        try {
            await execFileAsync("hyprctl", ["dispatch", "wallpaper", "all", filePath], { timeout: 15000 })
            this.logger.log(`Hyprland wallpaper set: ${filePath}`, 'WallpaperSetter')
            return true
        } catch (err) {
            this.logger.error(`Hyprland: hyprctl failed: ${err.message}`, 'WallpaperSetter')
            return false
        }
    }
}

// ========================
// Main Wallpaper Setter
// ========================

/**
 * Wallpaper Setter Class
 *
 * Applies generated wallpaper images as the desktop background using a strategy pattern:
 * relies exclusively on SystemService for DE detection and tool validation,
 * delegates to environment-specific setters, and supports manual override of the target environment.
 */
class WallpaperSetter {
    /**
     * Create a new WallpaperSetter.
     * @param {LoggerService} logger - Logger service instance.
     * @param {SystemService} system - System service (provides cached DE info). Required.
     */
    constructor(logger, system) {
        if (!system) {
            throw new Error("WallpaperSetter requires a SystemService instance")
        }
        this.logger = logger || console
        this.system = system
    }

    /**
     * Get the appropriate setter strategy.
     * Validates that required tools are available before returning a strategy.
     * @param {string|null} [environment=null] - Optional override.
     * @returns {{set: Function}|null} Setter strategy instance.
     */
    #getStrategy(environment = null) {
        const env = environment || this.system.desktop.environment
        if (!env) return null

        // Validate that at least one required tool is available for this environment
        const toolCheck = SystemService.checkDeTools(env)
        if (!toolCheck.available) {
            const tools = SystemService.DE_TOOLS[env]
            this.logger.error(
                `No setter tool available for ${env}. Required: ${tools.join(", ")}`,
                'WallpaperSetter'
            )
            return null
        }

        switch (env) {
            case "cinnamon": return new CinnamonSetter(this.logger)
            case "gnome":    return new GnomeSetter(this.logger)
            case "kde":      return new KdeSetter(this.logger)
            case "xfce":     return new XfceSetter(this.logger)
            case "hyprland": return new HyprlandSetter(this.logger)
            default:         return null
        }
    }

    /**
     * Set the generated wallpaper as the desktop background.
     * @param {string} filePath - Absolute path to the wallpaper image.
     * @param {Object} [options] - Optional configuration.
     * @param {string} [options.environment] - Override auto-detected DE.
     * @returns {Promise<boolean>} True if successful.
     */
    async set(filePath, options = {}) {
        const { environment } = options
        const envLabel = environment || this.system.desktop.environment || "unknown"
        this.logger.log(`Attempting to set wallpaper (${envLabel}): ${filePath}`, 'WallpaperSetter')

        // Warn if SystemService says we cannot set wallpaper for this DE
        if (!environment && !this.system.desktop.canSetWallpaper) {
            this.logger.warn(
                `Desktop is ${this.system.desktop.environment || "unknown"} but required ` +
                `setter tool is not available - wallpaper setting may fail`, 'WallpaperSetter'
            )
        }

        const strategy = this.#getStrategy(environment)
        if (!strategy) {
            this.logger.error(`No setter available for environment: ${envLabel}`, 'WallpaperSetter')
            this.logger.error(`Supported environments: cinnamon, gnome, kde, xfce, hyprland`, 'WallpaperSetter')
            return false
        }

        return await strategy.set(filePath)
    }
}

export default WallpaperSetter