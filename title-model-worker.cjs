/* ------------------------------------------------------------------ */
/* Worker thread that hosts the SupraTitle-50M model.                 */
/*                                                                    */
/* All llama.cpp native work (native binary load, GGUF parse,         */
/* context creation, token generation) runs in THIS thread so the     */
/* Electron main process event loop is never blocked by it.           */
/*                                                                    */
/* Message protocol (JSON via parentPort):                           */
/*   main   -> worker: { type: "generate", id, message }              */
/*   worker -> main:   { type: "ready" }                              */
/*                         { type: "result", id, title }              */
/*                         { type: "error", id?, error }              */
/* ------------------------------------------------------------------ */

const { parentPort, workerData } = require("worker_threads");

const MODEL_PATH = workerData.modelPath;
let _completion = null;
let _chain = Promise.resolve(); // serialize generation requests

function send(msg) {
  if (parentPort) parentPort.postMessage(msg);
}

async function setup() {
  console.log("[title-worker] Loading SupraTitle-50M from:", MODEL_PATH);
  const { getLlama, LlamaCompletion } = await import("node-llama-cpp");
  const llama = await getLlama({ logLevel: "error" });
  const model = await llama.loadModel({ modelPath: MODEL_PATH });
  // Titles are tiny (short prompt + ~10 output tokens), so a 512-token
  // context keeps KV allocation fast and RAM usage low.
  const context = await model.createContext({ contextSize: 512 });
  _completion = new LlamaCompletion({ contextSequence: context.getSequence() });
  console.log("[title-worker] Model loaded in worker thread.");
}

async function generate(message) {
  const prompt = `User: ${message}\nTitle: `;
  const title = await _completion.generateCompletion(prompt, {
    maxTokens: 10,
    temperature: 0.55,
    topK: 15,
    topP: 0.85,
    repeatPenalty: { lastTokens: 64, penalty: 1.35 },
    trimWhitespaceSuffix: true,
  });
  // Clean up: trim, drop trailing punctuation/newlines
  return title.trim().replace(/[.\n]+$/, "") || "Untitled Chat";
}

parentPort.on("message", (msg) => {
  if (!msg || msg.type !== "generate") return;
  // Chain requests so they never overlap on a single context sequence.
  _chain = _chain.then(async () => {
    try {
      const title = await generate(String(msg.message || "").slice(0, 300));
      send({ type: "result", id: msg.id, title });
    } catch (err) {
      console.error("[title-worker] Generation failed:", err.message);
      send({ type: "error", id: msg.id, error: err.message });
    }
  });
});

setup()
  .then(() => send({ type: "ready" }))
  .catch((err) => {
    console.error("[title-worker] Failed to load model:", err.message);
    send({ type: "error", error: err.message });
    process.exit(1);
  });

process.on("uncaughtException", (err) => {
  console.error("[title-worker] Uncaught exception:", err);
  send({ type: "error", error: err.message });
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[title-worker] Unhandled rejection:", err);
  send({ type: "error", error: err && err.message ? err.message : String(err) });
  process.exit(1);
});
