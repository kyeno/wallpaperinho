"use strict"
/**
 * Display Assignment
 *
 * Maps selected images to display slots using a best-fit strategy:
 * within each orientation group, assigns the biggest image to the
 * biggest display (by pixel area). Handles multi-monitor layouts with
 * different orientations per monitor.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

/**
 * Represents a single display slot with its required dimensions and orientation.
 * Tracks which image has been assigned to this slot along with debug metadata.
 */
class Slot {
    /**
     * Create a slot for a single display.
     * @param {number} index - Display index.
     * @param {number} width - Required output width in pixels.
     * @param {number} height - Required output height in pixels.
     * @param {"vertical"|"horizontal"|"square"} orientation - Orientation of this display.
     */
    constructor(index, width, height, orientation) {
        this.displayIndex = index
        this.width = width
        this.height = height
        this.orientation = orientation
        this.pixelArea = width * height
        this.assignedImage = null
        this.processedPath = null
        this.debugInfo = null
    }
}

/**
 * Maps selected images to display slots using a best-fit strategy.
 * Groups displays by orientation (vertical/horizontal/square) and assigns the
 * largest available images to the largest displays within each group.
 */
class DisplayAssignment {
    #slotsByOrientation = { vertical: [], horizontal: [], square: [] }

    /**
     * Build an assignment matrix from display configurations.
     * Each display becomes a Slot classified by its orientation.
     * @param {Array<[number, number]>} displays - Array of [width, height] pairs.
     * @param {LoggerService} [logger] - Optional logger service instance.
     */
    constructor(displays, logger) {
        this.logger = logger || console

        const slots = []

        for (let i = 0; i < displays.length; i++) {
            const [w, h] = displays[i]
            let orient
            if (h > w) orient = "vertical"
            else if (w > h) orient = "horizontal"
            else orient = "square"

            const slot = new Slot(i, w, h, orient)
            slots.push(slot)
            this.#slotsByOrientation[orient].push(slot)
        }

        // Sort each group by pixel area descending so we assign biggest images first
        for (const list of Object.values(this.#slotsByOrientation)) {
            list.sort((a, b) => b.pixelArea - a.pixelArea)
        }

        this.logger.log(
            `Created ${slots.length} slots -- ` +
            `${this.#slotsByOrientation.vertical.length}V / ` +
            `${this.#slotsByOrientation.horizontal.length}H / ` +
            `${this.#slotsByOrientation.square.length}S`, 'DisplayAssignment'
        )
    }

    /**
     * Assign selected images to display slots.
     * Within each orientation, picks the biggest image for the biggest display.
     * @param {Array<{image: Object, orientation: string}>} selectedImages
     */
    assign(selectedImages) {
        // Group selections by orientation
        const grouped = { vertical: [], horizontal: [], square: [] }
        for (const s of selectedImages) {
            if (!(s.orientation in grouped)) continue
            grouped[s.orientation].push(s.image)
        }

        // For each orientation, sort both slots and images by area desc, then zip
        for (const orient of ["vertical", "horizontal", "square"]) {
            const slotList = this.#slotsByOrientation[orient]
            const imgPool = grouped[orient]

            // Sort pool by pixel area descending
            imgPool.sort((a, b) => b.width * b.height - a.width * a.height)

            for (let i = 0; i < slotList.length; i++) {
                if (i < imgPool.length) {
                    slotList[i].assignedImage = imgPool[i]
                } else {
                    this.logger.warn(
                        `No ${orient} image available for ` +
                        `display slot ${slotList[i].displayIndex}`, 'DisplayAssignment'
                    )
                }
            }
        }
    }

    /**
     * Get all slots as a flat array sorted by display index.
     * @returns {Slot[]}
     */
    get slots() {
        const all = [
            ...this.#slotsByOrientation.vertical,
            ...this.#slotsByOrientation.horizontal,
            ...this.#slotsByOrientation.square,
        ]
        all.sort((a, b) => a.displayIndex - b.displayIndex)
        return all
    }

    /**
     * Set debug info on a specific display slot.
     * @param {number} displayIndex
     * @param {*} info
     */
    setDebugInfo(displayIndex, info) {
        const slot = this.slots.find((s) => s.displayIndex === displayIndex)
        if (slot) slot.debugInfo = info
    }
}

export default DisplayAssignment