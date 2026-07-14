# Bare

A minimal agentic desktop harness. Connects to a local LLM and autonomously reads, writes, edits files, runs shell commands, and searches the web.

## What it does

- **Agentic loop** — autonomous agent with tool calls, auto-retry on crash
- **Built-in tools** — `read`, `write`, `edit`, `bash`, `websearch`, `finish_task`
- **Plugin system** — drop a `.js` file into `plugins/` to add any tool (auto-reloads)
- **Context management** — live context bar (llama.cpp only), auto-truncation at 85%
- **Safety** — workdir restriction, read-only mode, per-tool permission prompts

## Requirements

- Any OpenAI-compatible server: Llama.cpp, Ollama, LM Studio, vLLM

> **Linux note:** The `websearch` tool uses hidden browser windows to scrape pages. On headless Linux systems you'll need a display server (X11 or Wayland). Install `xvfb` and run with `xvfb-run Bare` if you don't have a desktop environment.

## Quickstart

**1. Start a local LLM server**

e.g. with llama.cpp:

```powershell
& "path\to\llama-server.exe" -m "path\to\model.gguf" -c 65536 -ngl 99 --port 8080
```

**2. Launch Bare**

Run `Bare.exe`. Auto detects your server unless you are using a non-standard port.

**3. Start working**

Chat with Bare — it will read, write, edit files and run commands in your project directory.

## Project structure

```
├── main.js                  Electron main process (window, IPC, tool dispatch)
├── renderer.js              UI entry point — chat, buttons, message display
├── shortcuts.js             Keyboard shortcuts
├── attachments.js           Drag-drop & file attachment handling
├── agentic-loop.js          Core loop — send, parse SSE, tool execution, retry
├── index.html               Single-page UI shell
├── styles.css               All styles
├── settings.js              Settings panel (server, theme, safety toggles)
├── plugin-loader.js         Auto-detects & hot-reloads plugins/*.js
├── message-builder.js       Builds conversation history for the LLM
├── context-truncation.js    Truncates context when approaching limits
├── crash-recovery.js        Detects and recovers from LLM/server crashes
├── system-prompt.js         System prompt template
├── ui-blocks.js             Markdown/think/write block rendering
├── ui-registry.js           UI component registry
├── permission-toast.js      Tool permission prompts
├── safety.js                Tool execution validation
├── sandbox.js               Path & command allow/block lists
├── sse-parser.js            Server-Sent Events parser
├── utils.js                 Shared helpers
├── preload.cjs              Electron preload script
├── plugins/                 Tool plugins (read, write, edit, bash, websearch, finish_task)
├── tool-plugin-template.js  Template for writing custom tools
├── tests/                   Tests
└── dist/                    Build output
```

## Building

```bash
npm install
npm start              # Run from source
npm run build          # Build for all platforms (Windows, macOS, Linux)
npm run build:win      # Build Windows portable only
npm run build:mac      # Build macOS DMG only
npm run build:linux    # Build Linux AppImage only
```

## Custom tools

Write your own tool in JS, put the file in plugins (see tool-plugin-template for schema) or just ask Bare to make a new tool. Bare can use the new tool instantly.

## Acknowledgements

- **Qwen 3.6 27b** — locally ran, did 99% of the work
- **llama.cpp** — for running Qwen
- **Gemini 3.1 Pro** — for a couple of hard bits!
- **https://tabler.io/icons** — for the SVGs
- **Bare** — made itself, risky at times!
