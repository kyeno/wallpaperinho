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

    /**
     * Subdirectory driving mode -- controls which images feed the SELECTION POOL relative to
     * imageDirectories roots (applied at selection time; indexing/catalog stay complete):
     *   - "include"       everything under the roots, recursively           (default)
     *   - "flat"          only files directly inside a root directory
     *   - "subdirsOnly"   skip loose root-level files; use subdirectories only
     *   - "exclusiveFlat" pick ONE random first-level subdir per run -> its own files only
     *   - "exclusiveDeep" pick ONE random first-level subdir per run -> its whole subtree
     * Falls back to "include" when no eligible subdirectories exist. Directories listed in
     * imageDirectoryExclusions never count as candidates for exclusive modes.
     */
    imageSubdirectoryMode: "include",

    // ===== Broken image quarantine =====

    /**
     * When true (default), images that exist but fail to decode (truncated copies, corrupt
     * files) are moved out of the library so they stop failing every run, and their catalog
     * rows are dropped. Requires a writable directory -- see quarantinedImagesDirectory.
     * Set false to leave broken files where they are.
     */
    quarantineBrokenImages: true,

    /** Where quarantined images are moved. Default when unset: ~/Pictures/Quarantined. */
    quarantinedImagesDirectory: "/home/username/Pictures/Quarantined/",

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

    /**
     * Iterative upscaling stop threshold (0.0-1.0). NCNN passes are chained until BOTH
     * dimensions reach at least this fraction of the target display size; ImageMagick
     * then closes the remaining gap during fit-exact resize/crop. Lower values save GPU
     * time but leave more scaling to ImageMagick (more visible softness on small sources).
     */
    ncnnUpscaleTolerance: "0.95",

    /** Maximum chained NCNN passes per display before falling back to ImageMagick scaling */
    ncnnMaxUpscalePasses: 3,

    /**
     * Per-pass wall-clock timeout for the upscaler binary (milliseconds). A hung GPU or stuck
     * Vulkan driver otherwise stalls the entire pipeline indefinitely. Applies to EACH chained
     * pass, not the total run. Invalid/missing values fall back to 600000 (10 minutes).
     */
    ncnnUpscalerTimeoutMs: 600000,
}
