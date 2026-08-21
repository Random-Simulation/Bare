/* ------------------------------------------------------------------ */
/* SupraTitle-50M local CPU title generator                           */
/* Loads the GGUF model once, then generates titles via llama.cpp     */
/* ------------------------------------------------------------------ */

const path = require("path");

let _model = null;
let _completion = null;
let _ready = false;
let _loading = null;

const MODEL_PATH = path.join(__dirname, "assets", "models", "SupraTitle-50M-Q8_0.gguf");

/**
 * Lazy-load the model on first call.
 * Returns a promise that resolves when the model is ready.
 */
async function ensureLoaded() {
  if (_ready) return;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      console.log("[title-gen] Loading SupraTitle-50M model from:", MODEL_PATH);
      const { getLlama, LlamaCompletion } = await import("node-llama-cpp");
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath: MODEL_PATH });
      const context = await model.createContext();
      _completion = new LlamaCompletion({ contextSequence: context.getSequence() });
      _model = model;
      _ready = true;
      console.log("[title-gen] Model loaded successfully.");
    } catch (err) {
      console.error("[title-gen] Failed to load model:", err.message);
      _loading = null; // allow retry
      throw err;
    }
  })();

  return _loading;
}

/**
 * Generate a title from a user message.
 * Uses the SupraTitle prompt format: "User: {message}\nTitle: "
 */
async function generateTitle(userMessage) {
  await ensureLoaded();

  const prompt = `User: ${userMessage}\nTitle: `;

  const title = await _completion.generateCompletion(prompt, {
    maxTokens: 10,
    temperature: 0.55,
    topK: 15,
    topP: 0.85,
    repeatPenalty: {
      lastTokens: 64,
      penalty: 1.35,
    },
    trimWhitespaceSuffix: true,
  });

  // Clean up: trim, remove trailing punctuation duplicates
  return title.trim().replace(/[.\n]+$/, "") || "Untitled Chat";
}

module.exports = { generateTitle, ensureLoaded };
