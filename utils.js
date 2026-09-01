/* ------------------------------------------------------------------ */
/* Pure utility functions — no DOM, no side effects                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Markdown + KaTeX rendering                                         */
/* ------------------------------------------------------------------ */

/**
 * Render markdown text into a DOM element, then post-process with KaTeX
 * to render any math delimiters ($...$, $...$, \(...\), \[...\]).
 *
 * Does NOT add copy buttons — call addCopyButtons(el) separately after
 * streaming is complete to avoid DOM thrashing / button flicker during
 * live token updates.
 */
export function renderMarkdownTo(el, src) {
	el.innerHTML = marked.parse(src);

	// ── KaTeX math rendering ──
	if (typeof window.renderMathInElement === 'function') {
		try {
			window.renderMathInElement(el, {
				delimiters: [
					{ left: "$", right: "$", display: true },
					{ left: "$",  right: "$",  display: false },
					{ left: "\\(", right: "\\)", display: false },
					{ left: "\\[", right: "\\]", display: true },
				],
				ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
				ignoredClasses: ["katex", "katex-display"],
				throwOnError: false,
			});
		} catch (e) { /* KaTeX render failure — ignore */ }
	}
}

/**
 * Wrap all <pre> blocks inside el with a code-block-wrapper div and
 * attach copy buttons (top-right and bottom-right).
 *
 * Call this ONCE after streaming is complete — not during live updates —
 * to avoid destroying/recreating button elements every frame.
 */
export function addCopyButtons(el) {
	const copySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2h-10c-1.1 0-2-.9-2-2v-8.667"/><path d="M12 16h.01"/></svg>`;
	const checkSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M5 12l5 5l10 -10"/></svg>`;

	el.querySelectorAll('pre').forEach(pre => {
		// Skip if already wrapped (safety guard)
		if (pre.parentElement?.classList.contains('code-block-wrapper')) return;

		// Count lines in the code block content
		const codeEl = pre.querySelector('code');
		const codeText = codeEl ? codeEl.textContent : pre.textContent;
		// Strip trailing newline (markdown code blocks often have one) to avoid inflated counts
		const lineCount = codeText.replace(/\n$/, '').split('\n').length;

		// Build the copy button click handler (shared by top/bottom)
		const makeClickHandler = (btns) => () => {
			navigator.clipboard.writeText(codeText).then(() => {
				btns.forEach(b => b.innerHTML = checkSvg);
				setTimeout(() => {
					btns.forEach(b => b.innerHTML = copySvg);
				}, 1500);
			});
		};

		// Create top-right copy button (always shown)
		const btnTop = document.createElement('button');
		btnTop.className = 'code-copy-btn';
		btnTop.title = 'Copy code';
		btnTop.innerHTML = copySvg;
		btnTop.dataset.origSvg = copySvg;

		// Create bottom-right copy button (only for ≥ 2 lines)
		let btnBottom = null;
		if (lineCount >= 2) {
			btnBottom = document.createElement('button');
			btnBottom.className = 'code-copy-btn code-copy-btn-bottom';
			btnBottom.title = 'Copy code';
			btnBottom.innerHTML = copySvg;
			btnBottom.dataset.origSvg = copySvg;
		}

		const allBtns = btnBottom ? [btnTop, btnBottom] : [btnTop];
		btnTop.addEventListener('click', makeClickHandler(allBtns));
		if (btnBottom) btnBottom.addEventListener('click', makeClickHandler(allBtns));

		// Wrapper: flex row, grey box, buttons inside on the right
		const wrapper = document.createElement('div');
		wrapper.className = 'code-block-wrapper';

		// Scrollable area for the <pre> (takes remaining width)
		const scrollArea = document.createElement('div');
		scrollArea.className = 'code-block-scroll';

		// Column for copy buttons (fixed width, inside the grey box)
		const btnColumn = document.createElement('div');
		btnColumn.className = 'code-block-btns';
		btnColumn.appendChild(btnTop);
		if (btnBottom) btnColumn.appendChild(btnBottom);

		pre.parentNode.insertBefore(wrapper, pre);
		scrollArea.appendChild(pre);
		wrapper.appendChild(scrollArea);
		wrapper.appendChild(btnColumn);
	});
}

/* ------------------------------------------------------------------ */
/* API helpers — read window.__settings, return request params        */
/* ------------------------------------------------------------------ */

export function getApiUrl() {
	const host = window.__settings.serverHost || '127.0.0.1';
	const port = window.__settings.serverPort || '8080';
	return `http://${host}:${port}`;
}

export function getApiHeaders() {
	return { 'Content-Type': 'application/json' };
}

export function getModelParam() {
	return window.__settings.model || undefined;
}

export function getBodyExtras() {
	const extras = {};
	if (window.__settings.model) {
		extras.model = window.__settings.model;
	}
	const slotId = getSlotId();
	if (slotId !== null) {
		extras.id_slot = slotId;
	}
	return extras;
}

export function getEndpoint() { return '/v1/chat/completions'; }

/**
 * Optional llama.cpp slot pinning (advanced setting, "Slot" in Settings).
 * When set, every request carries `id_slot` and the llama.cpp server is
 * forced to serve it on that slot (useful when several apps share one
 * multi-slot server and must keep separate conversations). Returns the
 * configured slot id as a non-negative integer, or null when unset or
 * invalid — in which case the server assigns a slot automatically.
 */
export function getSlotId() {
	const raw = window.__settings ? window.__settings.slotId : null;
	if (raw === null || raw === undefined || raw === '') return null;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Capitalise the first letter of a string */
export function capitalise(s) {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ */
/* Token normalization                                                */
/* ------------------------------------------------------------------ */

/**
 * Normalize Gemma 4 `<|"|>` quote tokens to regular double-quotes.
 * Gemma 4 emits tool call args like: {key:<|"|>value<|"|>}
 * instead of: {key:"value"}
 * llama.cpp passes the raw `<|"|>` tokens through, breaking JSON parsing.
 *
 * Safe to call on any model — no-op when the pattern is absent.
 */
export function normalizeGemmaTokens(str) {
	if (typeof str !== 'string') return str;
	return str.replace(/<\|"\|>/g, '"');
}

/* ------------------------------------------------------------------ */
/* Reasoning tag definitions                                          */
/* ------------------------------------------------------------------ */

/**
 * Known reasoning/thinking tag pairs used by different models.
 * Shared by sse-parser.js (stream splitting), message-builder.js (extraction),
 * and buildAssistantContent (history building).
 *
 * - DeepSeek / Qwen / standard:  ... 
 * - Gemma 4 primary:             <|channel>thought ... <channel|>
 * - Gemma 4 alternate:           <|think|> ... <|/think|>
 */
export const REASONING_TAGS = [
	{ open: '\u003c' + 'think' + '\u003e', close: '\u003c' + '/think' + '\u003e' },
	{ open: '<|channel>thought', close: '<channel|>' },
	{ open: '<|think|>', close: '<|/think|>' },
];

/**
 * Check if text already contains native reasoning tags (any known format).
 */
export function hasNativeReasoningTags(text) {
	if (!text) return false;
	for (const tag of REASONING_TAGS) {
		if (text.includes(tag.open)) return true;
	}
	return false;
}

/** Build assistant content, optionally prepending thinking tags.
 * If thinkText already contains native reasoning tags (Gemma 4, etc.),
 * preserves them as-is. Otherwise wraps in standard  tags. */
export function buildAssistantContent(text, thinkText) {
	const content = text || '';
	const reasoning = thinkText || '';

	if (reasoning && hasNativeReasoningTags(reasoning)) {
		// Tags already embedded — return as-is
		return reasoning + content;
	}

	return thinkText.trim()
		? `  <think>\n${thinkText.trim()}\n</think>\n${content}`
		: content;
}

/** Truncate tool output to fit context window, keeping start + end lines */
export function truncateToolOutput(content, isRead = false) {
	if (typeof content !== 'string') return content;
	const MAX_CHARS = isRead ? 100000 : 10000;
	const KEEP_START = isRead ? 1000 : 100;
	const KEEP_END = isRead ? 1000 : 100;

	if (content.length > MAX_CHARS) {
		const lines = content.split('\n');
		const skipped = lines.length - KEEP_START - KEEP_END;
		if (skipped > 0) {
			content = lines.slice(0, KEEP_START).join('\n')
				+ `\n\n... [${skipped} lines truncated] ...\n\n`
				+ lines.slice(-KEEP_END).join('\n');
		} else {
			content = content.slice(0, MAX_CHARS) + '\n... [Output truncated]';
		}
	}
	return content;
}

/** Escape HTML special characters */
export function escHtml(s) {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Unescape JSON string escape sequences */
export function unescapeJsonString(s) {
	return s.replace(/\\(["\\nr\t/bf]|u[0-9a-fA-F]{4})/g, (_, c) => {
		switch (c) {
			case '"':  return '"';
			case '\\': return '\\';
			case 'n':  return '\n';
			case 'r':  return '\r';
			case 't':  return '\t';
			case '/':  return '/';
			case 'b':  return '\b';
			case 'f':  return '\f';
			default:   return String.fromCharCode(parseInt(c.slice(1), 16));
		}
	});
}

/** Extract a partial string value from an incomplete JSON object (streaming) */
export function extractPartialValue(e, key) {
	const match = e.partialArgs.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)'));
	if (!match) return null;
	return unescapeJsonString(match[1]);
}

/** Extract a partial numeric value from an incomplete JSON object (streaming) */
export function extractPartialNumber(e, key) {
	const match = e.partialArgs.match(new RegExp('"' + key + '"\\s*:\\s*([0-9]+)'));
	if (!match) return null;
	return parseInt(match[1], 10);
}

/** Extract partial string values from a JSON array field (streaming) */
export function extractPartialArray(e, key) {
	const match = e.partialArgs.match(new RegExp('"' + key + '"\\s*:\\s*\\[([^\\]]*)'));
	if (!match) return [];
	const items = [];
	for (const m of match[1].matchAll(/"((?:[^"\\\\]|\\\\.)*)/g)) {
		items.push(unescapeJsonString(m[1]));
	}
	return items;
}

/** Strip control chars and truncate excessively long lines */
export function sanitizeToolOutput(text) {
	if (typeof text !== 'string') return text;

	let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

	const MAX_LINE_LEN = 1000;
	const lines = sanitized.split('\n');
	for (let i = 0; i < lines.length; i++) {
		// Don't truncate __IMAGE__ marker lines — they contain base64 data
		if (lines[i].startsWith('__IMAGE__|')) continue;
		if (lines[i].length > MAX_LINE_LEN) {
			lines[i] = lines[i].substring(0, MAX_LINE_LEN) + '... [line truncated]';
		}
	}
	return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Scrolling & batching helpers                                       */
/* ------------------------------------------------------------------ */

let autoScroll = true;
let scrollPending = false;

export function setAutoScroll(val) { autoScroll = val; }

export function getScrollToBottom(chat) {
	return () => {
		if (!scrollPending) {
			scrollPending = true;
			requestAnimationFrame(() => {
				try {
					if (autoScroll) chat.scrollTop = chat.scrollHeight;
				} finally {
					scrollPending = false;
				}
			});
		}
	};
}

let updatePending = false;
export function scheduleUpdate(fn) {
	if (!updatePending) {
		updatePending = true;
		requestAnimationFrame(() => {
			try {
				fn();
			} catch (err) {
				console.error("Render error during update:", err);
			} finally {
				updatePending = false;
			}
		});
	}
}

/* ------------------------------------------------------------------ */
/* Session persistence                                                */
/* ------------------------------------------------------------------ */

export async function saveSession(history, chatHtml) {
	const workDir = await window.electron.invoke('fs:workdir');
	const eventLog = window.__eventLog || [];
	await window.electron.invoke('session:save', { history, chatHtml, workDir, eventLog });

	// Persist a saved conversation history file too (skipped for temp sessions)
	if (window.__session?.isTemporarySession) return;
	if (history.length === 0) return;
	const { saveHistoryFile } = await import('./history-store.js');
	await saveHistoryFile({ history, chatHtml, eventLog }).catch(err => {
		console.error('Failed to save history file:', err);
	});
}

export async function restoreSession(history, chat) {
	const data = await window.electron.invoke('session:load');
	if (!data || !data.history || data.history.length === 0) return false;

	history.length = 0;
	for (const msg of data.history) history.push(msg);

	if (data.chatHtml) chat.innerHTML = data.chatHtml;

	// Restore event log
	if (data.eventLog && data.eventLog.length > 0) {
		window.__eventLog = data.eventLog;
	}

	return true;
}

export async function clearSession() {
	await window.electron.invoke('session:clear');
}

export async function saveFullSession(history, eventLog) {
	const workDir = await window.electron.invoke('fs:workdir');
	await window.electron.invoke('session:save-full', { history, eventLog, workDir });
}

/* ------------------------------------------------------------------ */
/* Error formatting                                                   */
/* ------------------------------------------------------------------ */

export function friendlyError(err) {
	if (!err) return 'Something went wrong.';
	if (err.name === 'AbortError') return 'Connection timed out. Check your local AI server is running.';
	const msg = err.message.toLowerCase();
	if (msg.includes('failed to fetch') || msg.includes('networkerror')) {
		return 'Failed to fetch — please check your local AI server is running properly.';
	}
	if (msg.includes('connection refused') || msg.includes('econnrefused')) {
		return 'Connection refused — your local AI server may not be running, or the port is wrong.';
	}
	return err.message;
}
