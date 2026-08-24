"use strict"
/**
 * Wallpaperinho profiles.
 *
 * Each profile only defines the settings it wants to override.
 * When no --profile flag is passed, one eligible profile is picked at random;
 * consecutive runs rotate away from the previously used one when possible.
 * Use "--profile <name>" to pin a specific profile ("default" = first below).
 *
 * Optional per-profile meta-keys (not copied into runtime settings):
 *   - excludeFromRandom: true  → keep this profile out of the random pool
 *                                (still selectable via explicit --profile)
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

export const profiles = {
    // Implicit default - first in list (also what --profile default selects)
    architecture: {
        imageDirectories: [
            "/media/Pictures/ARCHITECTURE_LANDSCAPES_INTERIORS/"
        ],
        imageDirectoryExclusions: ["exclude_dir1", "exclude_dir2"],
        ncnnUpscalerModel: "4xHFA2k",
        imageMatchingStrategy: "gemini"
    },

    cars: {
        excludeFromRandom: true,
        imageDirectories: [
            "/media/Pictures/CARS_AND_BIKES/"
        ],
        imageMatchingStrategy: ["contrast", "canny", "entropy"]
    },

    nature: {
        imageDirectories: [
            "/media/Pictures/NATURE_AND_WILDLIFE/"
        ],
        imageMatchingStrategy: ["colorHSL", "contrast", "entropy"],
        ncnnUpscalerModel: "4xLSDIRplusC",
    },

    liminal: {
        imageDirectories: [
            "/media/Pictures/ART/Liminal Spaces/",
        ],
        // Keep this niche collection out of random rotation:
        // excludeFromRandom: true,
    },

    pictorialism: {
        imageDirectories: [
            "/media/Pictures/ART/Pictorialism/",
        ],
        ncnnUpscalerModel: "realesr-animevideov3",
        ncnnUpscalerScale: "2",
    },

    classic_masters: {
        imageDirectories: [
            "/media/Pictures/ART/Classic_Painters_Subfolder1/",
            "/media/Pictures/ART/Classic_Painters_Subfolder2/",
        ],
        ncnnUpscalerModel: "ultrasharp-4x",
    },
}
