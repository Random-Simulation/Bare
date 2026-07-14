import { parseSSE } from './sse-parser.js';
import {
  escHtml,
  sanitizeToolOutput,
  setAutoScroll,
  scheduleUpdate,
  renderMarkdownTo,
  buildAssistantContent,
  truncateToolOutput,
  friendlyError,
  saveFullSession,
  extractPartialValue,
  getApiUrl,
  getApiHeaders,
  getModelParam,
  getBodyExtras,
  getEndpoint
} from './utils.js';
import { createThinkBlock, renderLazyContent, completeWriteBlock } from './ui-blocks.js';
import { hideQuietStatus, showQuietStatus, logThink, logUserMessage, logAssistantText, logToolCall, logSystemMessage, logErrorMessage } from './verbose-mode.js';

/* ------------------------------------------------------------------ */
/* logUserMessage now takes (displayText, fullText?) — displayText is
   what gets stored in the event log for re-rendering. fullText (if
   provided) is the agent-facing text containing attachment content.
/* ------------------------------------------------------------------ */
import { buildMessages, setTools, detectParserBug, finalizeToolCalls } from './message-builder.js';
import { truncateContextIfNeeded } from './context-truncation.js';
import { handleCrashRecovery } from './crash-recovery.js';
import UIRegistry, { GENERIC_HANDLER } from './ui-registry.js';
import { requestPermission, needsPermission } from './permission-toast.js';

/* ------------------------------------------------------------------ */
/* Dynamic tools (fetched from main process via IPC)                  */
/* ------------------------------------------------------------------ */
let tools = [];

export async function loadTools() {
  tools = await window.electron.invoke('tools:get-schemas');
  setTools(tools);
}

/* ------------------------------------------------------------------ */
/* Agentic Loop — the main send() function                            */
/* ------------------------------------------------------------------ */
export async function send({ history, queuedMessages, chat, prompt, stopBtn, text, displayText, images, isStreaming, setIsStreaming, requestStop, scrollToBottom, addMsg }) {
  const promptText = text ?? prompt.value.trim();
  if (!promptText && queuedMessages.length === 0) return;

  if (promptText) {
    const userMsg = { role: 'user', content: promptText };
    if (images && images.length > 0) userMsg.images = images;
    history.push(userMsg);
    const display = displayText || promptText;
    addMsg('user', display);
    logUserMessage(display, promptText);
  }

  prompt.value = '';
  prompt.style.height = 'auto';
  setAutoScroll(true);
  setIsStreaming(true);
  stopBtn.classList.add('visible');

  let crashRetries = 0;
  const MAX_CRASH_RETRIES = 5;

  while (isStreaming()) {

    /* --- inject queued user messages --- */
    if (queuedMessages.length > 0) {
      for (const msg of queuedMessages) {
        // msg can be a string or { text, images } from drag-drop
        if (typeof msg === 'string') {
          history.push({ role: 'user', content: msg });
          logUserMessage(msg);
        } else {
          const userMsg = { role: 'user', content: msg.text };
          if (msg.images && msg.images.length > 0) userMsg.images = msg.images;
          history.push(userMsg);
          const queuedDisplay = msg.displayText || msg.text;
          logUserMessage(queuedDisplay, msg.text);
        }
      }
      queuedMessages.length = 0;
    }

    /* --- track insertion order for DOM placement --- */
    let lastOrder = (() => {
      let max = 0;
      for (const el of chat.querySelectorAll('[data-order]')) {
        const o = parseInt(el.dataset.order, 10);
        if (o > max) max = o;
      }
      return max;
    })();

    /* --- create thinking placeholder --- */
    let think = null;
    if (window.__settings?.verbose) {
      think = createThinkBlock();
      think.details.dataset.order = ++lastOrder;
      chat.appendChild(think.details);
    } else {
      showQuietStatus('Processing...');
    }
    scrollToBottom();

    let assistantText = '';
    let assistantMessageDiv = null;
    let isServerThinking = false;
    let hasThinking = false;
    let thinkText = '';

    const activeToolCalls = new Map();
    const completedToolCalls = [];
    let finishReason = null;

    const toolUIBlocks = new Map();
    const toolExecutions = [];
    const executedToolIds = new Set();
    const permissionCheckedToolIds = new Set();
    // Tools waiting for permission — keep collecting args for a brief delay before showing the toast
    const permissionPending = new Map(); // toolId -> { toolName, entry, seenAt }
    const PERMISSION_DELAY = 750; // ms to collect partial args before showing the toast

    /* Custom error to signal user-blocked tool — not a crash, don't retry */
    class PermissionDeniedError extends Error {
      constructor(toolName) {
        super(`Tool '${toolName}' was denied by the user`);
        this.name = 'PermissionDeniedError';
      }
    }

    /* --- shared: resolve one pending permission entry --- */
    async function resolvePendingPermission(pid, pending) {
      permissionPending.delete(pid);
      const perm = await requestPermission(pending.toolName, pending.entry);
      if (perm === 'block') {
        window.__currentAbort.abort();
        throw new PermissionDeniedError(pending.toolName);
      }
      if (perm === 'allow-all') {
        window.__settings.requireToolPermission = false;
        window.electron.invoke('settings:save', window.__settings).catch(() => {});
        addToast('⚠ Tool permissions disabled — Bare will no longer ask', 'error', 4000);
      }
      permissionCheckedToolIds.add(pid);
    }

    /* --- Context auto-truncation (preemptive at 85%, llama.cpp only) --- */
    if (!['ollama', 'vllm'].includes(window.__settings?.serverType) && window.__currentCtxPct > 85 && history.length > 10) {
      saveFullSession(history).catch(() => {});
      truncateContextIfNeeded(history, window.__currentCtxPct);
      window.__currentCtxPct = 50;
    }

    const messages = await buildMessages(history);
    window.__currentAbort = new AbortController();

    try {

      /* --- fetch with timeout --- */
      const FETCH_TIMEOUT_MS = 120000;
      const timeoutId = setTimeout(() => { window.__currentAbort.abort(); }, FETCH_TIMEOUT_MS);

      const body = { messages, stream: true, tools, ...getBodyExtras() };
      const model = getModelParam();
      if (model) body.model = model;

      const res = await fetch(getApiUrl() + getEndpoint(), {
        method: 'POST',
        headers: getApiHeaders(),
        body: JSON.stringify(body),
        signal: window.__currentAbort.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw new Error(
          `Server error ${res.status} (${res.statusText})${errorBody ? ' — ' + errorBody.trim() : ''}`
        );
      }

      clearTimeout(timeoutId);

      /* --- consume SSE events --- */
      for await (const event of parseSSE(res.body)) {
        if (event.type === 'done') {
          finishReason = event.finishReason;

          // Stream ended — resolve any pending permissions now
          for (const [pid, pending] of permissionPending) {
            await resolvePendingPermission(pid, pending);
          }

          break;
        }

        /* --- reasoning --- */
        if (event.type === 'reasoning') {
          hasThinking = true;
          if (!isServerThinking) {
            isServerThinking = true;
            // Switch quiet status from "Processing..." to "Thinking..." in non-verbose mode
            if (!window.__settings?.verbose) {
              showQuietStatus('Thinking...');
            }
          }
          thinkText += event.text;
        }

        /* --- assistant text --- */
        if (event.type === 'content') {
          if (isServerThinking) isServerThinking = false;

          // Hide quiet status when LLM text starts streaming
          hideQuietStatus();

          if (!hasThinking && think?.details) {
            think.details.remove();
            think.details = null;
          }

          assistantText += event.text;

          if (!assistantMessageDiv) {
            assistantMessageDiv = document.createElement('div');
            assistantMessageDiv.className = 'chat-item msg ai markdown-content';
            assistantMessageDiv.dataset.seq = ++window.__seq;
            assistantMessageDiv.dataset.order = ++lastOrder;
            chat.insertBefore(assistantMessageDiv, think?.details?.nextSibling || null);
          }

          scheduleUpdate(() => {
            if (assistantMessageDiv) {
              try {
                renderMarkdownTo(assistantMessageDiv, assistantText);
              } catch (e) {
                assistantMessageDiv.innerHTML = `<pre style="white-space: pre-wrap;">${escHtml(assistantText)}</pre>`;
              }
              scrollToBottom();
            }
          });
        }

        /* --- tool calls --- */
        if (event.type === 'tool_call') {
          if (isServerThinking) isServerThinking = false;

          if (!hasThinking && think?.details) {
            think.details.remove();
            think.details = null;
          }

          let entry = activeToolCalls.get(event.index);
          if (!entry) {
            entry = { id: '', name: '', partialArgs: '' };
            activeToolCalls.set(event.index, entry);
          }
          if (event.id) entry.id = event.id;
          if (event.name) entry.name = event.name;
          if (event.arguments) entry.partialArgs += event.arguments;

          /* --- early permission gate (delayed toast so args can arrive) --- */
          if (entry.id && entry.name && !permissionCheckedToolIds.has(entry.id)) {
            if (window.__settings?.requireToolPermission !== false && needsPermission(entry.name)) {
              // First time seeing this tool — record it and keep collecting args
              if (!permissionPending.has(entry.id)) {
                permissionPending.set(entry.id, { toolName: entry.name, entry, seenAt: Date.now() });
              }
            }
          }

          // Check if any pending permission has waited long enough — show toast
          for (const [pid, pending] of permissionPending) {
            if (Date.now() - pending.seenAt >= PERMISSION_DELAY || finishReason) {
              await resolvePendingPermission(pid, pending);
              break; // one at a time
            }
          }

          /* --- create live UI block (registry-driven) --- */
          if (entry.id && entry.name && !toolUIBlocks.has(entry.id)) {
            const handler = UIRegistry.get(entry.name) || GENERIC_HANDLER;
            const uiBlock = handler.create(entry, ++lastOrder);
            toolUIBlocks.set(entry.id, uiBlock);
            scrollToBottom();
          }

          /* --- update live UI as args stream (registry-driven) --- */
          if (toolUIBlocks.has(entry.id)) {
            const uiBlock = toolUIBlocks.get(entry.id);
            const handler = UIRegistry.get(entry.name) || GENERIC_HANDLER;
            if (handler.update) handler.update(uiBlock, entry);
          }
        }

        /* --- update thinking block --- */
        if (isServerThinking || thinkText) {
          hasThinking = true;
          if (think) {
            think._rawContent = thinkText;
            if (think._isOpen) renderLazyContent(think, think.content);
          }
          scrollToBottom();

          if (think) {
            if (isServerThinking) {
              if (think.summary.textContent !== 'Thinking...') {
                think.summary.textContent = 'Thinking...';
                think.summary.classList.add('pulsing');
                think.summary.classList.remove('processing');
              }
            } else {
              if (think.summary.textContent !== 'Thought Process') {
                think.summary.textContent = 'Thought Process';
                think.summary.classList.remove('pulsing');
                think.summary.classList.remove('processing');
              }
            }
          }
        }

        if (event.type === 'tool_call') scrollToBottom();
      }

      crashRetries = 0;

      const hasParserBug = detectParserBug(thinkText, assistantText);

      if (!finishReason) {
        throw new Error('Stream terminated prematurely without a finish_reason.');
      }

      if (finishReason === 'length') {
        throw new Error('Response truncated (hit max token limit). Retrying...');
      }

      if (finishReason === 'content_filter') {
        throw new Error('Response was content-filtered. Retrying...');
      }

      /* --- Parse tool args, salvage leaked reasoning, sweep content leaks --- */
      const { completedToolCalls: finalized, assistantText: _at, thinkText: _tt, hasThinking: _ht } = finalizeToolCalls(
        activeToolCalls, { assistantText, thinkText, hasThinking }, hasParserBug,
      );
      assistantText = _at;
      thinkText = _tt;
      hasThinking = _ht;
      for (const tc of finalized) completedToolCalls.push(tc);

      /* --- 3. Finalize thinking block --- */
      // This now safely captures ALL swept-up thinkText from steps 1 and 2!
      if (think?.details) {
        think.summary.classList.remove('pulsing');
        if (hasThinking || thinkText.trim()) {
          think._rawContent = thinkText.trim();
          think.summary.textContent = 'Thought Process';
          think.summary.classList.remove('processing');
          if (think._isOpen) renderLazyContent(think, think.content);
        } else {
          think.details.remove();
          think.details = null;
        }
      }

      // Final cleanup check for empty thought blocks
      if (!hasThinking && think?.details) think.details.remove();

      /* --- finalize assistant text --- */
      let displayText = assistantText.trim();
      if (displayText) {
        if (!assistantMessageDiv) {
          assistantMessageDiv = document.createElement('div');
          assistantMessageDiv.className = 'chat-item msg ai markdown-content';
          assistantMessageDiv.dataset.seq = ++window.__seq;
          assistantMessageDiv.dataset.order = ++lastOrder;
          chat.insertBefore(assistantMessageDiv, think?.details?.nextSibling || null);
        }
        try {
          renderMarkdownTo(assistantMessageDiv, displayText);
        } catch (e) {
          assistantMessageDiv.innerHTML = `<pre style="white-space: pre-wrap;">${escHtml(displayText)}</pre>`;
        }
        scrollToBottom();
      } else if (assistantMessageDiv) {
        assistantMessageDiv.remove();
      }

      /* --- handle finish_task --- */
      const finishTool = completedToolCalls.find(tc => tc.name === 'finish_task');
      if (finishTool) {
        const ftUiBlock = toolUIBlocks.get(finishTool.id);
        if (ftUiBlock) {
          const ftHandler = UIRegistry.get('finish_task');
          if (ftHandler && ftHandler.complete) ftHandler.complete(ftUiBlock);
        }

        // Log in DOM order: think → assistant
        if (hasThinking || thinkText.trim()) {
          logThink(thinkText.trim(), !!think?._isOpen);
        }
        if (assistantText.trim()) logAssistantText(assistantText.trim());
        history.push({
          role: 'assistant',
          content: buildAssistantContent(assistantText, thinkText),
          tool_calls: completedToolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });
        for (const [id, uiBlock] of toolUIBlocks) {
          if (id !== finishTool.id) {
            if (uiBlock.block?.details) uiBlock.block.details.remove();
            else if (uiBlock.block?.el) uiBlock.block.el.remove();
          }
        }
        toolUIBlocks.clear();
        // If the user typed a steering message during this turn, continue the loop
        // so it gets injected at the top rather than being silently dropped.
        if (queuedMessages.length > 0) {
          continue;
        }
        break;
      }

      /* --- execute tool calls --- */
      if (completedToolCalls.length > 0) {
        // Log thinking BEFORE tool execution
        if (hasThinking || thinkText.trim()) {
          logThink(thinkText.trim(), !!think?._isOpen);
        }

        // Pre-update UI blocks with resolved args (verbose mode only)
        for (const tc of completedToolCalls) {
          const uiBlock = toolUIBlocks.get(tc.id);
          if (!uiBlock?.block) continue;

          const filePath = tc.args.path || 'unknown';
          const fn = filePath.split(/[/\\]/).pop();
          uiBlock.block.filePath = filePath;

          if (uiBlock.type === 'read') {
            uiBlock.block.offset = tc.args.offset ?? null;
            uiBlock.block.limit = tc.args.limit ?? null;
          }

          if (uiBlock.type === 'write') {
            if (!uiBlock.block.resolvedFilename) uiBlock.block.resolvedFilename = fn;
            if (tc.args.content) completeWriteBlock(uiBlock.block, tc.args.content);
          }
        }

        // Execute each tool call (generic + registry hooks)
        for (const tc of completedToolCalls) {
          if (executedToolIds.has(tc.id)) continue;
          executedToolIds.add(tc.id);

          const uiBlock = toolUIBlocks.get(tc.id);
          const handler = UIRegistry.get(tc.name) || GENERIC_HANDLER;

          const p = (async () => {
            try {
              // Pre-execution hooks (e.g., edit reads full file for diff)
              let execContext = {};
              if (handler.preExecute) {
                execContext = await handler.preExecute(tc);
              }

              // Execute the tool
              const result = await window.electron.invoke('tool:execute', tc.name, tc.args);

              // Post-execution UI update
              if (handler.complete) {
                handler.complete(uiBlock, result, tc, execContext);
              }

              return { toolCallId: tc.id, success: true, result };
            } catch (err) {
              if (handler.completeError) {
                handler.completeError(uiBlock, err, tc);
              }
              return { toolCallId: tc.id, success: false, error: err.message };
            }
          })();
          toolExecutions.push(p);
        }

        const results = await Promise.all(toolExecutions);

        // Log assistant text BEFORE history push (matches DOM order: think → assistant → tools)
        if (assistantText.trim()) logAssistantText(assistantText.trim());
        history.push({
          role: 'assistant',
          content: buildAssistantContent(assistantText, thinkText),
          tool_calls: completedToolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        });

        for (let i = 0; i < completedToolCalls.length; i++) {
          const tc = completedToolCalls[i];
          const result = results.find(r => r.toolCallId === tc.id);
          let content = result?.success
            ? (result?.result || '')
            : (result?.error || 'Error: unknown');

          // Handle object results (e.g. { result: string, ui: string })
          if (typeof content === 'object' && content !== null && 'result' in content) {
            content = content.result;
          }

          content = sanitizeToolOutput(content);
          content = truncateToolOutput(content, tc.name === 'read');

          history.push({ role: 'tool', tool_call_id: tc.id, content });
        }

        toolUIBlocks.clear();
        toolExecutions.length = 0;
        executedToolIds.clear();
        completedToolCalls.length = 0;
      } else {
        if (!assistantText.trim() && !hasThinking && completedToolCalls.length === 0) {
          throw new Error('Empty response');
        }

        // Log in DOM order: think → assistant (not assistant → think)
        // This ensures renderChatFromLog re-renders in the correct visual order
        if (hasThinking || thinkText.trim()) {
          logThink(thinkText.trim(), !!think?._isOpen);
        }
        if (assistantText.trim()) logAssistantText(assistantText.trim());
        history.push({ 
          role: 'assistant', 
          content: buildAssistantContent(assistantText, thinkText) 
        });

        /* --- safeguard: only thinking, no real content — reprompt to continue --- */
        if (!assistantText.trim()) {
          history.push({ role: 'user', content: 'Continue.' });
          continue;
        }

        // If the user typed a steering message during this turn, continue the loop
        // so it gets injected at the top rather than being silently dropped.
        if (queuedMessages.length > 0) {
          continue;
        }
        break;
      }

    } catch (err) {

      if (err.name === 'PermissionDeniedError') {
        // User blocked a tool via permission toast — don't retry, just tell Bare and continue the loop
        if (think?.details) {
          try { think.details.remove(); } catch {}
        }
        // Push a user message informing Bare the tool was denied by the user
        const sysMsg = `Denied: ${err.message} (user declined permission)`;
        history.push({ role: 'user', content: `Tool call denied by the user: ${err.message}. Please mention this to the user and ask how they want to proceed.` });
        logSystemMessage(sysMsg);
        addMsg('system', sysMsg);
        continue;
      }

      if (err.name === 'AbortError') {
        if (!isStreaming()) {
          if (think?.details) think.details.remove();
          break;
        } else {
          err = new Error('Connection timed out after 120 seconds.');
        }
      }

      /* --- Context overflow: truncate and retry (not a crash) --- */
      const isContextOverflow = err.message.toLowerCase().includes('exceeds') &&
        (err.message.toLowerCase().includes('context') || err.message.toLowerCase().includes('token'));
      if (isContextOverflow) {
        console.log('[CTX OVERFLOW] Server rejected request — truncating and retrying...');
        saveFullSession(history).catch(() => {});
        truncateContextIfNeeded(history, 100, true); // force=true bypasses threshold
        window.__currentCtxPct = 50;
        if (think?.details) {
          try { think.details.remove(); } catch {}
        }
        continue; // Retry without incrementing crashRetries
      }

      crashRetries++;

      // For connection errors, don't retry — just show the message
      const isConnectionError = err.message.toLowerCase().includes('failed to fetch')
        || err.message.toLowerCase().includes('networkerror')
        || err.message.toLowerCase().includes('connection refused');

      // Never retry permission-denied errors
      const isPermissionDenied = err.message.toLowerCase().includes('permission denied') || err.message.toLowerCase().includes('denied by the user');
      const shouldRetry = isConnectionError || isPermissionDenied ? false : crashRetries < MAX_CRASH_RETRIES;

      if (shouldRetry) {
        try {
          await handleCrashRecovery(err, MAX_CRASH_RETRIES, activeToolCalls, assistantText, thinkText, think, crashRetries, history, chat, scrollToBottom);
        } catch (recoveryErr) {
          console.error('[RECOVERY FAILED] handleCrashRecovery threw:', recoveryErr);
        }
        if (think?.details) {
          try { think.details.remove(); } catch {}
        }
        continue;
      }

      const errorMsg = friendlyError(err);
      logErrorMessage(errorMsg);
      const div = document.createElement('div');
      div.className = 'chat-item msg ai markdown-content';
      div.textContent = errorMsg;
      div.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-tert').trim();
      chat.appendChild(div);

      if (think?.details) think.details.remove();
      break;

    } finally {
      try { window.resumeContextBar(); } catch (e) { console.warn('resumeContextBar error:', e); }
    }
  }

  window.__currentAbort = null;
  setIsStreaming(false);
  stopBtn.classList.remove('visible');
  scrollToBottom();

  // Persist session after each completed turn
  if (window.saveSession) window.saveSession().catch(console.error);
}