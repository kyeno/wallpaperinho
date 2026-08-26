"use strict"
/**
 * Command Runner
 *
 * Generic wrapper around node:child_process for every external binary we execute
 * (ImageMagick, the ncnn upscaler, desktop wallpaper setters, ...). Not tied to any
 * single tool -- future binaries get the same treatment for free.
 *
 * Responsibilities:
 *   - always capture stdout/stderr (no raw fd-inheritance surprises)
 *   - classify stderr lines into error/warning buckets using severity markers where
 *     tools provide them (e.g., ImageMagick's "@ fatal/" / "@ error/") with exit-code
 *     semantics as the generic fallback
 *   - throw structured CommandError instances carrying classified lines plus a CONCISE
 *     message, so upstream catch blocks log one clean line instead of a multi-line dump
 *   - map Node's timeout-kill signature (killed + SIGTERM, no exit code) onto the stable
 *     "ERR_CHILD_PROCESS_TIMEOUT" code when a timeout was requested, so callers can
 *     distinguish "timed out" from other failures
 *
 * Severity policy (most specific first):
 *   1. known-benign noise patterns are dropped entirely
 *   2. lines matching an error marker (@ fatal/, @ error/) -> errors
 *   3. lines carrying an explicit @ warning/ annotation -> warnings
 *      (the tool's own severity label is honored even when the command failed)
 *   4. unmarked lines from a FAILED command (non-zero exit) -> errors
 *      (they explain why it failed -- works for any binary)
 *   5. unmarked lines from a successful command -> warnings
 *
 * Nothing non-empty is ever silently discarded (see doc/TODO.md issue #4).
 *
 * @author Ratan M. Kyeno
 * @license MIT
 */

import { execFile, spawnSync } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Stable failure code used when a child process was killed by its configured timeout. */
export const TIMEOUT_FAILURE_CODE = "ERR_CHILD_PROCESS_TIMEOUT"

/** Noise patterns that carry no diagnostic value (dropped before classification). */
export const NOISE_PATTERNS = [
    /deprecated in IMv7/i,
    /\bDelegate\b/,
]

/** Markers indicating an error-level diagnostic line (ImageMagick-style). */
export const ERROR_MARKERS = [
    /@ fatal\//i,
    /@ error\//i,
]

/** Markers indicating a warning-level diagnostic line (explicit tool annotation wins). */
export const WARNING_MARKERS = [
    /@ warning\//i,
]

/**
 * Classify captured child-process stderr text into leveled buckets. Pure function.
 * @param {string} stderrText - Raw stderr output.
 * @param {{failed?: boolean}} [options={}] - Set `failed` when the command exited non-zero; unmarked lines then count as errors since they explain the failure.
 * @returns {{errors: string[], warnings: string[]}} Classified, trimmed, de-noised lines.
 */
export function classifyStderr(stderrText, options = {}) {
    const { failed = false } = options
    const errors = []
    const warnings = []
    if (!stderrText) return { errors, warnings }
    for (const rawLine of String(stderrText).split("\n")) {
        const line = rawLine.trim()
        if (!line) continue
        if (NOISE_PATTERNS.some((re) => re.test(line))) continue
        if (ERROR_MARKERS.some((re) => re.test(line))) {
            errors.push(line)
        } else if (WARNING_MARKERS.some((re) => re.test(line))) {
            warnings.push(line)
        } else if (failed) {
            errors.push(line)
        } else {
            warnings.push(line)
        }
    }
    return { errors, warnings }
}

/**
 * Short human label for a command ("magick convert", "hyprctl dispatch").
 * @param {string} bin - Executable path/name.
 * @param {string[]} args - Argument list.
 * @returns {string}
 */
function describeCommand(bin, args) {
    const head = Array.isArray(args) && typeof args[0] === "string" ? `${bin} ${args[0]}` : String(bin)
    return head.length > 64 ? head.slice(0, 61) + "..." : head
}

/**
 * Structured error thrown by runCommand/runCommandSync on non-zero exit or spawn failure.
 * Carries classified stderr so callers can emit each line at its proper level;
 * `.message` stays concise for clean upstream log lines.
 */
export class CommandError extends Error {
    /**
     * @param {string} bin - Executable that was run.
     * @param {string[]} args - Arguments passed to it.
     * @param {*} code - Exit status (number) or errno-like string (e.g., "ENOENT").
     * @param {string} stdout - Captured stdout.
     * @param {string} stderr - Raw captured stderr.
     */
    constructor(bin, args, code, stdout, stderr) {
        super(`${describeCommand(bin, args)} exited with status ${code ?? "?"}`)
        this.name = "CommandError"
        this.bin = bin
        this.args = [...(args || [])]
        this.code = code
        this.stdout = stdout ?? ""
        this.stderr = stderr ?? ""
        this.classified = classifyStderr(this.stderr, { failed: true })
    }
}

/**
 * Emit classified lines through a logger at their proper levels. No-op when empty.
 * @param {{warn?: Function, error?: Function}|null|undefined} logger - Any object exposing warn/error(message, tag).
 * @param {{errors?: string[], warnings?: string[]}} [classified={}] - Output of classifyStderr / CommandError.classified.
 * @param {string} [tag=""] - Logger tag for the emitted lines.
 */
export function emitClassified(logger, classified = {}, tag = "") {
    if (!logger) return
    for (const line of classified.warnings || []) logger.warn(line, tag)
    for (const line of classified.errors || []) logger.error(line, tag)
}

/** Normalize an execFile/spawnSync failure into a displayable exit status. */
function normalizeCode(errOrResult) {
    const raw = errOrResult?.code ?? errOrResult?.status
    if (Number.isInteger(raw)) return raw
    return String(raw ?? "unknown")
}

/**
 * Resolve a child-process failure into a displayable exit status. When we requested a
 * timeout and the child was killed by it (Node reports that as killed=true + SIGTERM with
 * no exit code), map the signature onto a stable identifier callers can match on.
 * @param {*} errOrResult - The thrown error or spawnSync result object.
 * @param {{timeout?: number}} [options={}] - Options originally passed to child_process.
 * @returns {*|string} Exit status (number/errno string) or "ERR_CHILD_PROCESS_TIMEOUT".
 */
function resolveFailureCode(errOrResult, options = {}) {
    if ((options?.timeout ?? 0) > 0) {
        const r = errOrResult ?? {}
        // A child killed by its own timeout never reports an integer exit status. Node
        // surfaces that kill differently per API/version (execFile: killed + SIGTERM with
        // no code; spawnSync: error.code ETIMEDOUT or ERR_CHILD_PROCESS_TIME(D)?OUT), so
        // match on "no normal exit" plus either the SIGTERM signature or a *TIME*OUT code.
        const exitedWithStatus = Number.isInteger(r.status) || Number.isInteger(r.code)
        if (!exitedWithStatus && (r.signal === "SIGTERM" || /TIME(D)?OUT/i.test(String(r.code ?? "")))) {
            return TIMEOUT_FAILURE_CODE
        }
    }
    return normalizeCode(errOrResult)
}

/**
 * Run an external command asynchronously; resolves with captured output on success.
 * @param {string} bin - Executable path/name.
 * @param {string[]} args - Argument list.
 * @param {{timeout?: number, maxBuffer?: number}} [options={}] - Passed through to child_process.
 * @returns {Promise<{stdout: string, stderr: string}>} Captured streams as strings.
 * @throws {CommandError} On non-zero exit or spawn failure (details in `.classified`).
 */
export async function runCommand(bin, args, options = {}) {
    try {
        const result = await execFileAsync(bin, args, options)
        return { stdout: result.stdout.toString(), stderr: result.stderr?.toString() ?? "" }
    } catch (err) {
        throw new CommandError(
            bin, args, resolveFailureCode(err, options),
            err.stdout?.toString(), err.stderr?.toString()
        )
    }
}

/**
 * Synchronous variant of runCommand (uses spawnSync so stderr is captured even on success).
 * @param {string} bin - Executable path/name.
 * @param {string[]} args - Argument list.
 * @param {{timeout?: number, maxBuffer?: number}} [options={}] - Passed through to child_process.
 * @returns {{stdout: string, stderr: string}} Captured streams as strings.
 * @throws {CommandError} On non-zero exit or spawn failure (details in `.classified`).
 */
export function runCommandSync(bin, args, options = {}) {
    const result = spawnSync(bin, args, options)
    if (result.error || result.status !== 0) {
        // Preserve errno-like codes from spawn errors while keeping the result's signal/kill
        // info visible so resolveFailureCode can recognize timeout kills either way.
        const source = result.error
            ? { code: result.error.code, status: null, signal: result.signal, killed: result.killed }
            : result
        throw new CommandError(
            bin, args, resolveFailureCode(source, options),
            result.stdout?.toString(), result.stderr?.toString()
        )
    }
    return { stdout: result.stdout.toString(), stderr: result.stderr?.toString() ?? "" }
}