/**
 * Optional machine-readable JSON output for test runners.
 * Enable with RESULTS_FILE=/path/to/results.json (e.g. bind-mounted in Docker).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** @type {string | null} */
export const RESULTS_FILE = process.env.RESULTS_FILE?.trim() || null;

/**
 * @param {string} filePath
 * @param {unknown} payload
 */
async function writeFileJson(filePath, payload) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * @param {{
 *   label: string;
 *   stoppedBecause: string;
 *   lastConcurrency: number;
 *   maxP95LatencyMs: number;
 *   waves: Array<{
 *     waveIndex: number;
 *     concurrency: number;
 *     histogram: Record<string, number>;
 *     transportErrors: number;
 *     medianMs?: number;
 *     p95Ms?: number;
 *     unexpectedStatuses?: number[];
 *     setupError?: string;
 *   }>;
 * }} outcome
 * @param {string | null} caseName
 * @param {"http" | "websocket"} kind
 */
function enrichRamp(outcome, caseName, kind) {
  const stopWave = outcome.waves?.at(-1) ?? null;
  return {
    caseName,
    kind,
    label: outcome.label,
    stoppedBecause: outcome.stoppedBecause,
    lastConcurrency: outcome.lastConcurrency,
    maxP95LatencyMs: outcome.maxP95LatencyMs,
    stopWaveIndex: stopWave?.waveIndex ?? null,
    stopConcurrency: stopWave?.concurrency ?? outcome.lastConcurrency ?? null,
    waves: outcome.waves,
  };
}

/**
 * @param {string} scriptName
 * @param {string} baseUrl
 * @param {{ scalability?: boolean }} [opts]
 */
export function createTestResults(scriptName, baseUrl, opts = {}) {
  const { scalability = false } = opts;
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();

  /** @type {string | null} */
  let currentCaseName = null;

  /** @type {Array<unknown>} */
  let currentCaseAsyncErrors = [];

  /** @type {Array<{ when: string; caseName: string | null; kind: "unhandledRejection" | "uncaughtException"; message: string }>} */
  const orphanAsyncErrors = [];

  /** @type {Array<{ name: string; status: "pass" | "fail"; error?: string; durationMs: number }>} */
  const cases = [];

  /** @type {Array<ReturnType<typeof enrichRamp>>} */
  const ramps = [];

  let isolationInstalled = false;

  /** @type {(reason: unknown) => void} */
  let onUnhandledRejection = () => {};
  /** @type {(err: unknown) => void} */
  let onUncaughtException = () => {};

  return {
    /**
     * Install process-level handlers that catch unhandled promise rejections
     * and uncaught exceptions so a stray background error doesn't crash the
     * whole script. Errors are attributed to the currently-running case (or
     * recorded as orphans) and do not call process.exit.
     */
    installIsolation() {
      if (isolationInstalled) {return;}
      isolationInstalled = true;
      onUnhandledRejection = (reason) => {
        const msg = reason instanceof Error ? reason.message : String(reason);
        console.error(`[isolated] unhandledRejection${currentCaseName ? ` (case: ${currentCaseName})` : ""}: ${msg}`);
        if (currentCaseName) {
          currentCaseAsyncErrors.push(reason);
        } else {
          orphanAsyncErrors.push({
            when: new Date().toISOString(),
            caseName: null,
            kind: "unhandledRejection",
            message: msg,
          });
        }
      };
      onUncaughtException = (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[isolated] uncaughtException${currentCaseName ? ` (case: ${currentCaseName})` : ""}: ${msg}`);
        if (currentCaseName) {
          currentCaseAsyncErrors.push(err);
        } else {
          orphanAsyncErrors.push({
            when: new Date().toISOString(),
            caseName: null,
            kind: "uncaughtException",
            message: msg,
          });
        }
      };
      process.on("unhandledRejection", onUnhandledRejection);
      process.on("uncaughtException", onUncaughtException);
    },

    /** @param {string} name */
    beginCase(name) {
      currentCaseName = name;
      currentCaseAsyncErrors = [];
    },

    /**
     * Returns any async errors buffered during the current case and clears
     * the active-case marker. Call from a finally block after `await fn()`.
     * @returns {Array<unknown>}
     */
    endCase() {
      const errs = currentCaseAsyncErrors;
      currentCaseAsyncErrors = [];
      currentCaseName = null;
      return errs;
    },

    /**
     * @param {{
     *   name: string;
     *   status: "pass" | "fail";
     *   error?: string;
     *   durationMs: number;
     * }} row
     */
    recordCase(row) {
      cases.push(row);
    },

    /**
     * @param {Parameters<typeof enrichRamp>[0]} outcome
     * @param {{ kind?: "http" | "websocket" }} [rampOpts]
     */
    recordRamp(outcome, rampOpts = {}) {
      if (!scalability) {return;}
      const kind = rampOpts.kind ?? "http";
      ramps.push(enrichRamp(outcome, currentCaseName, kind));
    },

    /**
     * @param {{
     *   passed: number;
     *   failed: number;
     *   exitCode?: number;
     *   fatal?: unknown;
     * }} summary
     */
    async finalize(summary) {
      if (!RESULTS_FILE) {return;}

      const { passed, failed, exitCode = 0, fatal = null } = summary;
      const finishedAt = new Date().toISOString();
      const durationMs = Math.round(performance.now() - startedMs);

      /** @type {Record<string, unknown>} */
      const payload = {
        script: scriptName,
        baseUrl,
        startedAt,
        finishedAt,
        durationMs,
        exitCode,
        summary: {
          total: passed + failed,
          passed,
          failed,
        },
        cases,
      };

      if (scalability && ramps.length > 0) {
        payload.ramps = ramps;
      }

      if (orphanAsyncErrors.length > 0) {
        payload.asyncErrors = orphanAsyncErrors;
      }

      if (fatal != null) {
        payload.fatal =
          fatal instanceof Error
            ? { message: fatal.message, name: fatal.name }
            : { message: String(fatal) };
      }

      await writeFileJson(RESULTS_FILE, payload);
    },
  };
}
