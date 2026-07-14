// ============================================================================
// TOOL PLUGIN TEMPLATE
// ============================================================================
//
// Use the write tool to create a new file in ./plugins/your_tool_name.js
// following the structure below. The system auto-reloads plugins instantly
// after file creation — you can use the new tool immediately.
//
// ============================================================================
// ENVIRONMENT & PATHS
// ============================================================================
//
// - __dirname resolves to the ./plugins/ folder, NOT the project root.
//   To reach the project root:  const ROOT = path.join(__dirname, "..");
//
// - Settings file (bare.json) lives in the user data directory.
//   Use ctx.settingsFile from the execute() context — don't hardcode paths.
//
//   bare.json structure:
//     { "settings": {
//       "serverHost": "127.0.0.1",
//       "serverPort": "8080",
//       "model": "model-name",
//       "theme": "light" | "dark",
//       "workDir": "/path/to/working/directory"
//     }}
//
// ============================================================================
// LOCAL LLM API (OpenAI-compatible)
// ============================================================================
//
//   Endpoint:  http://{host}:{port}/v1/chat/completions
//   Method:    POST
//   Headers:   { "Content-Type": "application/json" }
//   Body:      { messages: [...], stream: false, max_tokens: N }
//   Response:  { choices: [{ message: { content: "..." } }] }
//
//   Default host/port: 127.0.0.1:8080 (read from bare.json if available)
//   Supported servers: llama.cpp, Ollama, LM Studio, vLLM
//
// ============================================================================
// ELECTRON (BrowserWindow, ipcMain, etc.)
// ============================================================================
//
//   const { BrowserWindow } = require("electron");
//   const win = new BrowserWindow({
//     show: false,
//     webPreferences: { offscreen: true, contextIsolation: true, sandbox: true }
//   });
//   await win.loadURL("https://example.com");
//   const data = await win.webContents.executeJavaScript(`(...)();`);
//   win.destroy();
//
// ============================================================================
// MODULE STRUCTURE
// ============================================================================

module.exports = {
  name: "your_tool_name",
  schema: {
    type: "function",
    function: {
      name: "your_tool_name",
      description: "What this tool does",
      parameters: {
        type: "object",
        properties: {
          argName: { type: "string", description: "Description" }
        },
        required: ["argName"]
      }
    }
  },
  execute: async (args, ctx) => {
    // ctx.workDir     — current working directory
    // ctx.settingsFile — path to bare.json in user data dir
    // args contains the tool arguments from the LLM
    // Return a string result
    return "result";
  }
};

// ============================================================================
// RULES
// ============================================================================
// - Do NOT override core tools (read, edit, write, bash, finish_task)
//   unless intentionally replacing them. All core tools are plugins in ./plugins/
// - The execute function receives (args, ctx) where ctx has workDir.
// - Always return a string from execute().
// - For async operations, mark execute as async and use await.
// - The file MUST export a CommonJS module with name, schema, and execute.
