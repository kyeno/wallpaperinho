"use strict"
/**
 * Wallpaperinho profiles.
 *
 * Each profile only defines the settings it wants to override.
 * The first profile in this object is the implicit default (used when no --profile is passed).
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

export const profiles = {
    // Implicit default - first in list
    architecture: {
        imageDirectories: [
            "/media/Pictures/ARCHITECTURE_LANDSCAPES_INTERIORS/"
        ],
        imageDirectoryExclusions: ["exclude_dir1", "exclude_dir2"],
        ncnnUpscalerModel: "4xHFA2k",
        imageMatchingStrategy: "gemini"
    },

    cars: {
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
