/* ------------------------------------------------------------------ */
/* Pure utility functions — no DOM, no side effects                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Markdown + KaTeX rendering                                         */
/* ------------------------------------------------------------------ */

/**
 * Render markdown text into a DOM element, then post-process with KaTeX
 * to render any math delimiters ($...$, $$...$$, \(...\), \[...\]).
 */
export function renderMarkdownTo(el, src) {
	el.innerHTML = marked.parse(src);
	if (typeof window.renderMathInElement === 'function') {
		try {
			window.renderMathInElement(el, {
				delimiters: [
					{ left: "$$", right: "$$", display: true },
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
	return extras;
}

export function getEndpoint() { return '/v1/chat/completions'; }

/** Capitalise the first letter of a string */
export function capitalise(s) {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build assistant content, optionally prepending thinking tags */
export function buildAssistantContent(text, thinkText) {
	const content = text || '';
	return thinkText.trim()
		? ` <think>\n${thinkText.trim()}\n</think>\n${content}`
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

/** Format token counts (e.g. 1200 → "1.2k") */
export function formatTokenCount(n) {
	if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
	return String(n);
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

/** Format search queries for display */
export function formatSearchQueries(queries) {
	if (!queries || queries.length === 0) return '';
	const q = queries[0];
	const truncated = q.length > 60 ? q.substring(0, 60) + '...' : q;
	const count = queries.length > 1 ? ` (+${queries.length - 1})` : '';
	return `"${truncated}"${count}`;
}

/** Strip control chars and truncate excessively long lines */
export function sanitizeToolOutput(text) {
	if (typeof text !== 'string') return text;

	let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

	const MAX_LINE_LEN = 500;
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

export function getAutoScroll() { return autoScroll; }
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

export async function saveFullSession(history) {
	const workDir = await window.electron.invoke('fs:workdir');
	await window.electron.invoke('session:save-full', { history, workDir });
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
