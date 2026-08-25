/* ------------------------------------------------------------------ */
/* SupraTitle-50M local CPU title generator                           */
/*                                                                    */
/* The GGUF model is loaded and run in a dedicated worker thread      */
/* (see title-model-worker.cjs). This module only spawns the worker,  */
/* sends messages and awaits replies — so llama.cpp native work never */
/* blocks Electron's main event loop.                                 */
/* ------------------------------------------------------------------ */

const path = require("path");
const { Worker } = require("worker_threads");

const MODEL_PATH = path.join(__dirname, "assets", "models", "SupraTitle-50M-Q8_0.gguf");
const WORKER_PATH = path.join(__dirname, "title-model-worker.cjs");

// First load also pulls in the native binary — be generous.
const LOAD_TIMEOUT_MS = 120000;
const GEN_TIMEOUT_MS = 30000;

const _state = {
  worker: null,
  ready: false,
  loading: null,       // in-flight ensureLoaded() promise
  readyResolve: null,
  readyReject: null,
  loadTimer: null,
};
let _nextId = 1;
const _pending = new Map(); // id -> { resolve, reject, timer }

function _spawn() {
  const worker = new Worker(WORKER_PATH, { workerData: { modelPath: MODEL_PATH } });
  worker.on("message", _onMessage);
  worker.on("error", (err) => {
    console.error("[title-gen] Worker error:", err.message);
    _teardown(`Worker error: ${err.message}`);
  });
  worker.on("exit", (code) => {
    if (code !== 0) _teardown(`Worker exited (code ${code})`);
    else _state.worker = null; // clean shutdown (e.g. app quit)
  });
  _state.worker = worker;
}

function _onMessage(msg) {
  if (!msg) return;
  if (msg.type === "ready") {
    _state.ready = true;
    if (_state.loadTimer) { clearTimeout(_state.loadTimer); _state.loadTimer = null; }
    const resolve = _state.readyResolve;
    _state.loading = null;
    _state.readyResolve = null;
    _state.readyReject = null;
    if (resolve) resolve();
    return;
  }
  if (msg.type === "result" || msg.type === "error") {
    if (msg.error && msg.id == null) {
      // Fatal error during load (no id) — fail the ensureLoaded() promise.
      _teardown(msg.error);
      return;
    }
    const p = _pending.get(msg.id);
    if (!p) return;
    _pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "result") p.resolve(msg.title);
    else p.reject(new Error(msg.error || "Title generation failed"));
  }
}

/**
 * Reject everything in flight, drop the worker, and allow a retry.
 */
function _teardown(reason) {
  if (_state.loadTimer) { clearTimeout(_state.loadTimer); _state.loadTimer = null; }
  if (_state.worker) {
    _state.worker.removeAllListeners();
    try { _state.worker.terminate(); } catch {}
    _state.worker = null;
  }
  if (_state.ready) console.warn("[title-gen] Title model worker lost:", reason, "— will respawn on next use");
  _state.ready = false;
  const reject = _state.readyReject;
  _state.loading = null;
  _state.readyResolve = null;
  _state.readyReject = null;
  if (reject) reject(new Error(reason || "Title model worker terminated"));
  for (const p of _pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(reason || "Title model worker terminated"));
  }
  _pending.clear();
}

/**
 * Ensure the worker is up and the model is loaded.
 * Runs entirely off the main thread; this only resolves when ready.
 */
async function ensureLoaded() {
  if (_state.ready) return;
  if (_state.loading) return _state.loading;

  _state.loading = new Promise((resolve, reject) => {
    _state.readyResolve = resolve;
    _state.readyReject = reject;
    _state.loadTimer = setTimeout(() => {
      console.error(`[title-gen] Model load timed out after ${LOAD_TIMEOUT_MS}ms`);
      _teardown(`Model load timed out after ${LOAD_TIMEOUT_MS}ms`);
    }, LOAD_TIMEOUT_MS);
    try {
      _spawn();
    } catch (err) {
      _teardown(`Failed to spawn worker: ${err.message}`);
    }
  });
  return _state.loading;
}

/**
 * Generate a title from a user message.
 * Resolves with the cleaned title string. Rejects on failure/timeout so
 * callers can fall back (e.g. to the HTTP title endpoint).
 */
async function generateTitle(userMessage) {
  await ensureLoaded();

  const id = _nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`Title generation timed out after ${GEN_TIMEOUT_MS}ms`));
    }, GEN_TIMEOUT_MS);
    _pending.set(id, { resolve, reject, timer });
    try {
      _state.worker.postMessage({ type: "generate", id, message: String(userMessage || "").slice(0, 300) });
    } catch (err) {
      _pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`Worker unavailable: ${err.message}`));
    }
  });
}

/**
 * Cleanly terminate the worker (called on app quit).
 */
function shutdown() {
  if (_state.loadTimer) { clearTimeout(_state.loadTimer); _state.loadTimer = null; }
  if (_state.worker) {
    _state.worker.removeAllListeners();
    try { _state.worker.terminate(); } catch {}
    _state.worker = null;
  }
  _state.ready = false;
  for (const p of _pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("App shutting down"));
  }
  _pending.clear();
}

module.exports = { generateTitle, ensureLoaded, shutdown };
