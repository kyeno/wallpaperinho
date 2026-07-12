"use strict"
/**
 * Main configuration for wallpaperinho.
 *
 * All settings are expressed in camelCase. Profiles (see ./profiles.js) can override
 * any key here.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

export const config = {
    // ===== Debug =====

    /** When true, draws debug overlay showing HSL, contrast, etc. */
    debugOverlay: false,

    // ===== Display & output paths =====

    /** Monitor configurations left-to-right as [width, height] tuples */
    displays: [
        [1080, 1920],
        [2560, 1600],
        [1080, 1920],
    ],

    /** Vertical alignment for shorter monitors: "top" | "bottom" | "center" */
    monitorAlignment: "bottom",

    /** Directory where generated composite wallpapers are saved */
    wallpaperOutputDirectory: "/home/username/Pictures/Wallpapers/",

    /** Temporary directory for image processing, cleaned up after each run */
    tempDirectory: "/tmp/wallpaperinho",

    /** JPEG quality (1-100) for final composite output */
    wallpaperOutputJpegQuality: 95,

    // ===== Binary paths =====

    /** Path to ImageMagick binary (IMv7+) */
    imagickBin: "/usr/bin/magick",

    /** Path to ncnn upscaler binary (empty string disables upsampling) */
    ncnnUpscalerBin: "/usr/local/esrgan-ncnn/bin/realesrgan-ncnn-vulkan",

    /** Directory containing ncnn model files (.bin/.param) */
    ncnnUpscalerModelDir: "/home/username/AI/models/ncnn/",

    // ===== Image scanning (may be overriden with profile) =====

    /** Directory names to skip during recursive scanning */
    imageDirectoryExclusions: ["lowres", "_exclude"],

    /** Accepted file extensions (lowercase, including dot) */
    imageExtensions: [".jpg", ".jpeg", ".png", ".webp"],

    // ===== Image matching (may be overriden with profile) =====

     /**
      * Matching strategy: single string or array of strategies (chain mode).
      * Supported: "random", "colorHSL", "colorPalette", "contrast", "canny", "entropy", "gemini"
      * In chain mode, "entropy" must be last.
      */
    imageMatchingStrategy: "gemini",

    /** Initial tolerance for contrast matching (grows ~1.5x per iteration) */
    contrastInitialTolerance: 3,

    /** Maximum contrast tolerance before falling back to random */
    contrastMaxTolerance: 50,

    /** Initial tolerance for canny edge density matching */
    cannyInitialTolerance: 1,

    /** Maximum canny tolerance before falling back to random */
    cannyMaxTolerance: 12,

    /** Initial tolerance for color matching (squared HSL distance) */
    colorInitialTolerance: 1500,

    /** Maximum color tolerance before falling back to random */
    colorMaxTolerance: 90000,

    /** Initial hue distance tolerance for palette matching (degrees on color wheel) */
    colorPaletteInitialTolerance: 30,

    /** Maximum hue distance tolerance for palette matching (degrees) */
    colorPaletteMaxTolerance: 180,

    /** Maximum palette distance threshold for chain mode collection (0.0-1.0) */
    colorPaletteMaxDistance: 0.5,

    // ===== NCNN upscaler defaults =====

    /** Model name (-n flag), files must exist in ncnnUpscalerModelDir */
    ncnnUpscalerModel: "4xNomos8kSC",

    /** Scale factor (-s flag) */
    ncnnUpscalerScale: "4",

    /** Free-form flags appended to the upscaler command (e.g., "-g 0") */
    ncnnUpscalerFlags: "-g 0",
}
