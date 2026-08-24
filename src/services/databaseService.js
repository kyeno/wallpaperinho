"use strict"
/**
 * Database Service
 *
 * Wrapper around `node:sqlite` providing CRUD operations for the
 * wallpaper image catalog. Stores image metadata (path, dimensions, file size)
 * in a SQLite database at `var/db/images.sqlite3`.
 *
 * Instantiated once in main.js and injected into domain classes.
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import path from "node:path"

/**
 * Database Service Class
 *
 * Manages the SQLite database for image metadata storage and querying.
 * Handles schema initialization, batch inserts during indexing, and provides
 * query methods for image selection strategies (random, colorHSL, colorPalette, contrast, canny, entropy, gemini).
 *
 * All methods are synchronous (`node:sqlite` performs blocking IO); callers may still
 * use `await` on them harmlessly, but new code should not wrap these calls in Promises.
 */
class DatabaseService {
    #db = null
    #initialized = false
    #dbPath
    #logger
    #scope = null

    /**
     * Create a new DatabaseService instance.
     * @param {string} dbPath - Path to the SQLite database file.
     * @param {LoggerService} [logger] - Optional logger service instance.
     */
    constructor(dbPath, logger) {
        this.#dbPath = dbPath
        this.#logger = logger || console
    }

    /**
     * Initialize the database connection and schema.
     * Creates the database file and images table if they do not exist.
     */
    initialize() {
        if (this.#initialized) {
            return
        }

        try {
            // Ensure parent directory exists
            const dbDir = path.dirname(this.#dbPath)
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true })
            }

            this.#db = new DatabaseSync(this.#dbPath)

            this.#db.exec(`
              CREATE TABLE IF NOT EXISTS images (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT UNIQUE NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                filesize INTEGER NOT NULL,
                hue INTEGER,
                saturation INTEGER,
                lightness INTEGER,
                contrast INTEGER,
                entropy REAL,
                canny INTEGER,
                palette TEXT
              )
            `)

            // Migrations: backfill any columns missing from older databases.
            // PRAGMA table_info gives us the actual schema of whatever version created this file,
            // so every metric column added since the original release is applied exactly once --
            // existing rows keep their data (new columns default to NULL).
            const expectedColumns = [
                ["hue", "INTEGER"],
                ["saturation", "INTEGER"],
                ["lightness", "INTEGER"],
                ["contrast", "INTEGER"],
                ["entropy", "REAL"],
                ["canny", "INTEGER"],
                ["palette", "TEXT"],
            ]
            const existingColumns = new Set(
                this.#db.prepare("PRAGMA table_info(images)").all().map((col) => col.name)
            )
            for (const [name, type] of expectedColumns) {
                if (!existingColumns.has(name)) {
                    this.#db.exec(`ALTER TABLE images ADD COLUMN ${name} ${type}`)
                }
            }

            this.#initialized = true
        } catch (err) {
            this.#logger.error(`Failed to open database at ${this.#dbPath}: ${err.message}`, 'DatabaseService')
            throw err
        }
    }

    /**
     * Check if the database has been initialized.
     * @returns {boolean} True if initialized.
     */
    isInitialized() {
        return this.#initialized
    }

    /**
     * Set the active selection scope -- the subdirectory driving mode restriction
     * resolved from `imageSubdirectoryMode` (see src/lib/poolScope.js).
     * Applied automatically by every selection query method below; deliberately ignored
     * by indexing/CRUD helpers (insertImage, removeImage, getImageFilesize) so catalogs
     * stay complete regardless of which pool a profile requests.
     * @param {{condition: string, params: Array}|null} scope - SQL WHERE fragment over images.path plus bound parameters, or null to clear.
     */
    setScope(scope) {
        this.#scope = (scope && typeof scope.condition === "string" && scope.condition !== "") ? scope : null
    }

    /**
     * Get the active scope clause for manual application in externally built SELECTs
     * (e.g., strategy selector SQL builders). Returns an empty no-op when unset.
     * @returns {{condition: string, params: Array}}
     */
    getScopeClause() {
        return this.#scope || { condition: "", params: [] }
    }

    /**
     * Check if the image catalog is empty (no rows in the images table).
     * Useful to decide whether a full re-index should be triggered.
     * @returns {boolean} True if the images table contains zero rows.
     */
    isEmpty() {
        this.initialize()
        const row = this.#db.prepare("SELECT COUNT(*) as count FROM images").get()
        return row.count === 0
    }

    /**
     * Insert or replace an image record in the database.
     * @param {{path: string, width: number, height: number, filesize: number, hue?: number, saturation?: number, lightness?: number, contrast?: number, entropy?: number, canny?: number, palette?: string}} image - Image metadata.
     */
    insertImage(image) {
        const stmt = this.#db.prepare(
            "INSERT OR REPLACE INTO images (path, width, height, filesize, hue, saturation, lightness, contrast, entropy, canny, palette) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        stmt.run(image.path, image.width, image.height, image.filesize, image.hue ?? null, image.saturation ?? null, image.lightness ?? null, image.contrast ?? null, image.entropy ?? null, image.canny ?? null, image.palette ?? null)
    }

    /**
     * Remove an image record by path.
     * @param {string} filePath - Absolute path to the image.
     */
    removeImage(filePath) {
        const stmt = this.#db.prepare("DELETE FROM images WHERE path = ?")
        stmt.run(filePath)
    }

    // -----------------------------------------------------------------------
    // Generic query methods -- for strategy-specific SQL in selectors
    // -----------------------------------------------------------------------

    /**
     * Execute a parameterized SELECT query and return all matching rows.
     * @param {string} sql - SQL query string.
     * @param {*} [params] - Query parameters.
     * @returns {Array<Object>} List of matching records.
     */
    execute(sql, params = []) {
        return this.#db.prepare(sql).all(...params) || []
    }

    /**
     * Execute a parameterized SELECT query and return a single row.
     * @param {string} sql - SQL query string.
     * @param {*} [params] - Query parameters.
     * @returns {Object|null} A single record, or null if none matched.
     */
    executeOne(sql, params = []) {
        return this.#db.prepare(sql).get(...params) || null
    }

    // -----------------------------------------------------------------------
    // Filtered queries
    // -----------------------------------------------------------------------

    /**
     * Query images from the database with optional filters.
     * @param {Object} [filters] - Optional query filters.
     * @param {number} [filters.minWidth] - Minimum width inclusive.
     * @param {number} [filters.minHeight] - Minimum height inclusive.
     * @param {number} [filters.exactWidth] - Exact width match.
     * @param {number} [filters.exactHeight] - Exact height match.
     * @returns {Array<Object>} List of matching image records.
     */
    queryImages(filters) {
        let sql = "SELECT * FROM images"
        const conditions = []
        const params = []

        if (filters) {
            if (filters.minWidth) {
                conditions.push("width >= ?")
                params.push(filters.minWidth)
            }
            if (filters.minHeight) {
                conditions.push("height >= ?")
                params.push(filters.minHeight)
            }
            if (filters.exactWidth) {
                conditions.push("width = ?")
                params.push(filters.exactWidth)
            }
            if (filters.exactHeight) {
                conditions.push("height = ?")
                params.push(filters.exactHeight)
            }
        }

        // Subdirectory-mode scope (imageSubdirectoryMode), when active
        const { condition, params: scopeParams } = this.getScopeClause()
        if (condition) {
            conditions.push(condition)
            params.push(...scopeParams)
        }

        if (conditions.length > 0) {
            sql += " WHERE " + conditions.join(" AND ")
        }

        const rows = this.#db.prepare(sql).all(...params)
        return rows || []
    }

    // -----------------------------------------------------------------------
    // Orientation helpers
    // -----------------------------------------------------------------------

    /**
     * Find all vertical images (height > width).
     * @returns {Array<Object>} List of vertical image records.
     */
    findAllVertical() {
        return this.findAllVerticalSync()
    }

    /**
     * Synchronous version of findAllVertical for use in non-async contexts.
     * @returns {Array<Object>} List of vertical image records.
     */
    findAllVerticalSync() {
        const { condition, params } = this.getScopeClause()
        let sql = "SELECT * FROM images WHERE height > width"
        if (condition) sql += ` AND ${condition}`
        const rows = this.#db.prepare(sql).all(...params)
        return rows || []
    }

    /**
     * Find all horizontal images (width > height).
     * @returns {Array<Object>} List of horizontal image records.
     */
    findAllHorizontal() {
        return this.findAllHorizontalSync()
    }

    /**
     * Synchronous version of findAllHorizontal for use in non-async contexts.
     * @returns {Array<Object>} List of horizontal image records.
     */
    findAllHorizontalSync() {
        const { condition, params } = this.getScopeClause()
        let sql = "SELECT * FROM images WHERE width > height"
        if (condition) sql += ` AND ${condition}`
        const rows = this.#db.prepare(sql).all(...params)
        return rows || []
    }

    /**
     * Find all square images (width == height).
     * @returns {Array<Object>} List of square image records.
     */
    findAllSquare() {
        return this.findAllSquareSync()
    }

    /**
     * Synchronous version of findAllSquare for use in non-async contexts.
     * @returns {Array<Object>} List of square image records.
     */
    findAllSquareSync() {
        const { condition, params } = this.getScopeClause()
        let sql = "SELECT * FROM images WHERE width = height"
        if (condition) sql += ` AND ${condition}`
        const rows = this.#db.prepare(sql).all(...params)
        return rows || []
    }

    // -----------------------------------------------------------------------
    // Random selection helpers
    // -----------------------------------------------------------------------

    /**
     * Find a random image from the entire catalog.
     * @returns {Object|null} A random image record, or null if the table is empty.
     */
    findRandom() {
        return this.findRandomSync()
    }

    /**
     * Synchronous version of findRandom for use in non-async contexts.
     * @returns {Object|null} A random image record, or null if the table is empty.
     */
    findRandomSync() {
        const { condition, params } = this.getScopeClause()
        let sql = "SELECT * FROM images"
        if (condition) sql += ` WHERE ${condition}`
        sql += " ORDER BY RANDOM() LIMIT 1"
        const row = this.#db.prepare(sql).get(...params)
        return row || null
    }

    /**
     * Find random images by orientation while excluding already-used paths.
     * If not enough distinct images are available after exclusion, returns whatever is available
     * and logs a warning so the caller can decide whether to allow duplicates.
     * @param {"vertical"|"horizontal"|"square"} orientation - Target orientation.
     * @param {string[]} excludePaths - Paths of images already selected that should be excluded.
     * @param {number} limit - Maximum number of results to return.
     * @returns {{results: Array<Object>, totalAvailable: number}} Matching records and count of available candidates.
     */
    findRandomByOrientation(orientation, excludePaths, limit) {
        let sql = `SELECT * FROM images`
        const params = []

        // Orientation filter
        if (orientation === "vertical") {
            sql += " WHERE height > width"
        } else if (orientation === "horizontal") {
            sql += " WHERE width > height"
        } else if (orientation === "square") {
            sql += " WHERE width = height"
        }

        // Subdirectory-mode scope (imageSubdirectoryMode), when active
        const { condition: scopeCond, params: scopeParams } = this.getScopeClause()
        if (scopeCond) {
            sql += `${sql.includes("WHERE") ? " AND" : " WHERE"} ${scopeCond}`
            params.push(...scopeParams)
        }

        // Exclude already-used paths
        if (excludePaths.length > 0) {
            const placeholders = excludePaths.map(() => "?").join(", ")
            sql += `${sql.includes("WHERE") ? " AND" : " WHERE"} path NOT IN (${placeholders})`
            params.push(...excludePaths)
        }

        sql += " ORDER BY RANDOM() LIMIT ?"
        params.push(limit)

        const rows = this.#db.prepare(sql).all(...params) || []

        // Count how many distinct images are actually available for this orientation after exclusions
        let countSql = `SELECT COUNT(*) as cnt FROM images`
        const countParams = []

        if (orientation === "vertical") {
            countSql += " WHERE height > width"
        } else if (orientation === "horizontal") {
            countSql += " WHERE width > height"
        } else if (orientation === "square") {
            countSql += " WHERE width = height"
        }

        if (scopeCond) {
            countSql += `${countSql.includes("WHERE") ? " AND" : " WHERE"} ${scopeCond}`
            countParams.push(...scopeParams)
        }

        if (excludePaths.length > 0) {
            const placeholders = excludePaths.map(() => "?").join(", ")
            countSql += `${countSql.includes("WHERE") ? " AND" : " WHERE"} path NOT IN (${placeholders})`
            countParams.push(...excludePaths)
        }

        const totalAvailable = this.#db.prepare(countSql).get(...countParams)?.cnt ?? 0

        return { results: rows, totalAvailable }
    }

    /**
     * Find random images from any orientation while excluding already-used paths.
     * @param {string[]} excludePaths - Paths of images already selected that should be excluded.
     * @param {number} limit - Maximum number of results to return.
     * @returns {{results: Array<Object>, totalAvailable: number}} Matching records and count of available candidates.
     */
    findRandomExcluding(excludePaths, limit) {
        let sql = `SELECT * FROM images`
        const params = []

        // Subdirectory-mode scope (imageSubdirectoryMode), when active
        const { condition: scopeCond, params: scopeParams } = this.getScopeClause()
        if (scopeCond) {
            sql += ` WHERE ${scopeCond}`
            params.push(...scopeParams)
        }

        if (excludePaths.length > 0) {
            const placeholders = excludePaths.map(() => "?").join(", ")
            sql += `${sql.includes("WHERE") ? " AND" : " WHERE"} path NOT IN (${placeholders})`
            params.push(...excludePaths)
        }

        sql += " ORDER BY RANDOM() LIMIT ?"
        params.push(limit)

        const rows = this.#db.prepare(sql).all(...params) || []

        // Count total available after exclusions
        let countSql = `SELECT COUNT(*) as cnt FROM images`
        const countParams = []

        if (scopeCond) {
            countSql += ` WHERE ${scopeCond}`
            countParams.push(...scopeParams)
        }

        if (excludePaths.length > 0) {
            const placeholders = excludePaths.map(() => "?").join(", ")
            countSql += `${countSql.includes("WHERE") ? " AND" : " WHERE"} path NOT IN (${placeholders})`
            countParams.push(...excludePaths)
        }

        const totalAvailable = this.#db.prepare(countSql).get(...countParams)?.cnt ?? 0

        return { results: rows, totalAvailable }
    }

    // -----------------------------------------------------------------------
    // File size helpers (replaces direct _db access)
    // -----------------------------------------------------------------------

    /**
     * Get the stored file size for an image by path.
     * @param {string} filePath - Absolute path to the image.
     * @returns {number|null} File size in bytes, or null if not found.
     */
    getImageFilesize(filePath) {
        const row = this.#db.prepare("SELECT filesize FROM images WHERE path = ?").get(filePath)
        return row ? row.filesize : null
    }

    /**
     * Close the database connection and reset initialization state.
     */
    close() {
        if (this.#db) {
            this.#db.close()
            this.#db = null
            this.#initialized = false
        }
    }
}

export default DatabaseService