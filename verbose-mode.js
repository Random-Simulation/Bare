import {
	createReadBlock,
	completeReadBlock,
	createEditBlock,
	completeEditBlock,
	generateEditDiffHtml,
	createWriteBlock,
	completeWriteBlock,
	createFinishTaskBlock,
	completeFinishTaskBlock,
	createWebSearchBlock,
	completeWebSearchBlock,
	createGenericToolBlock,
	completeGenericToolBlock,
	createThinkBlock,
	renderLazyContent,
} from './ui-blocks.js';
import { capitalise, escHtml, renderMarkdownTo } from './utils.js';

/* ------------------------------------------------------------------ */
/* Event Log — flat array, captured regardless of mode                 */
/* ------------------------------------------------------------------ */

/** Initialise the event log and DOM counters */
export function initToolLog() {
	window.__eventLog = window.__eventLog || [];
	window.__seq = window.__seq || 0;
	window.__order = window.__order || 0;
}

/** Push any event into the log */
function pushEvent(type, data) {
	window.__eventLog?.push({ type, ...data });
}

/* ------------------------------------------------------------------ */
/* Public loggers — called from agentic-loop / ui-registry             */
/* ------------------------------------------------------------------ */

export function logUserMessage(displayContent, fullContent) {
	// displayContent is what shows in the UI (e.g. "--- Attached: file.js ---").
	// fullContent (optional) is the agent-facing text with attachment content.
	// We store displayContent in the event log so re-rendering never leaks
	// attachment content into the chat UI.
	pushEvent('user', { content: displayContent });
}

export function logAssistantText(content) {
	pushEvent('assistant', { content });
}

export function logThink(thinkText, thinkOpen) {
	pushEvent('think', {
		text: thinkText,
		open: !!thinkOpen,
	});
}

export function logToolCall(name, args, result, error, extra) {
	pushEvent('tool', {
		name,
		args: args || {},
		result,
		error,
		...extra,  // diffHtml, rawContent, etc.
	});
}

export function logSystemMessage(content) {
	pushEvent('system', { content });
}

export function logErrorMessage(content) {
	pushEvent('error', { content });
}

/* ------------------------------------------------------------------ */
/* Quiet Status — singleton pulsing message during tool activity       */
/* ------------------------------------------------------------------ */

export function getQuietStatusEl() {
	let el = document.getElementById('quiet-status');
	if (!el) {
		el = document.createElement('div');
		el.id = 'quiet-status';
		el.className = 'quiet-status';
		document.getElementById('chat').appendChild(el);
	}
	return el;
}

export function showQuietStatus(text) {
	const el = getQuietStatusEl();
	el.textContent = text;
	el.classList.remove('finish-task');
	el.classList.add('visible');
}

export function hideQuietStatus() {
	const el = document.getElementById('quiet-status');
	if (el) el.classList.remove('visible');
}

/* ------------------------------------------------------------------ */
/* Re-render — clear #chat and rebuild from the event log              */
/* ------------------------------------------------------------------ */

/**
 * Re-render the entire chat from the event log.
 * Shows tool/think blocks when verbose, hides them when quiet.
 */
export function renderChatFromLog(verbose) {
	const chat = document.getElementById('chat');
	if (!chat || !window.__eventLog) return;

	// Save scroll position
	const scrollTop = chat.scrollTop;
	const scrollHeight = chat.scrollHeight;

	// Clear everything
	chat.innerHTML = '';

	// Rebuild quiet status element
	getQuietStatusEl();

	// Iterate log in order, append elements
	for (const evt of window.__eventLog) {
		switch (evt.type) {
			case 'user': {
				const div = document.createElement('div');
				div.className = 'chat-item msg user';
				div.textContent = evt.content;
				chat.appendChild(div);
				break;
			}

			case 'assistant': {
				if (!evt.content || !evt.content.trim()) continue;
				const div = document.createElement('div');
				div.className = 'chat-item msg ai markdown-content';
				try {
					renderMarkdownTo(div, evt.content);
				} catch {
					div.innerHTML = `<pre style="white-space:pre-wrap">${escHtml(evt.content)}</pre>`;
				}
				chat.appendChild(div);
				break;
			}

			case 'think': {
				if (!verbose) continue;
				if (!evt.text || !evt.text.trim()) continue;
				const block = createThinkBlock();
				block._rawContent = evt.text.trim();
				block.summary.textContent = 'Thought Process';
				block.summary.classList.remove('pulsing', 'processing');
				if (evt.open) {
					block.details.open = true;
					block._isOpen = true;
					renderLazyContent(block, block.content);
				}
				chat.appendChild(block.details);
				break;
			}

			case 'tool': {
				if (!verbose) continue;
				const el = createToolBlockFromLog(evt);
				if (el) chat.appendChild(el);
				break;
			}

			case 'system': {
				if (!evt.content || !evt.content.trim()) continue;
				const sysDiv = document.createElement('div');
				sysDiv.className = 'chat-item msg system';
				sysDiv.textContent = evt.content;
				chat.appendChild(sysDiv);
				break;
			}

			case 'error': {
				if (!evt.content || !evt.content.trim()) continue;
				const errDiv = document.createElement('div');
				errDiv.className = 'chat-item msg ai markdown-content';
				errDiv.textContent = evt.content;
				errDiv.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-tert').trim();
				chat.appendChild(errDiv);
				break;
			}
		}
	}

	// Restore scroll to bottom
	chat.scrollTop = chat.scrollHeight;
}

/** Create a completed tool-call DOM element from a log entry */
function createToolBlockFromLog(evt) {
	const isOk = !evt.error;
	const name = evt.name;

	switch (name) {
		case 'read': {
			const block = createReadBlock(
				evt.args?.path,
				evt.args?.offset ?? null,
				evt.args?.limit ?? null,
			);
			completeReadBlock(block);
			return block.el;
		}

		case 'edit': {
			const block = createEditBlock(evt.args?.path);
			const fname = evt.args?.path?.split(/[/\\]/).pop() || 'file';
			const editCount = evt.args?.edits?.length || 0;
			const extraEdits = editCount > 1 ? ` (${editCount} edits)` : '';
			block.summary.textContent = isOk
				? `Edited ${fname}${extraEdits}`
				: `Edit failed — ${fname}`;
			block.el.classList.remove('pulsing');
			// Restore diff if captured
			if (evt.diffHtml) {
				block._cachedDiffHtml = evt.diffHtml;
			}
			if (evt.diffOpen) {
				block.el.open = true;
				if (block._cachedDiffHtml) {
					const pre = document.createElement('pre');
					pre.className = 'diff-content';
					pre.innerHTML = block._cachedDiffHtml;
					block.el.appendChild(pre);
					block._diffRendered = true;
				}
			}
			if (!isOk) {
				block.el.style.color = getComputedStyle(document.documentElement)
					.getPropertyValue('--text-tert').trim();
			}
			return block.el;
		}

		case 'write': {
			const block = createWriteBlock(evt.args?.path);
			const fname = evt.args?.path?.split(/[/\\]/).pop() || 'file';
			const lines = evt.args?.content ? evt.args.content.split('\n').length : 0;
			block.summary.textContent = isOk
				? `Wrote ${fname} - ${lines} lines`
				: `Write failed: ${fname}`;
			block.summary.classList.remove('pulsing');
			// Restore content if captured
			if (evt.rawContent) {
				block._rawContent = evt.rawContent;
				block.lineCount = evt.rawContent.split('\n').length;
				block.summary.textContent = `Wrote ${fname} - ${block.lineCount} lines`;
			}
			if (evt.writeOpen) {
				block.details.open = true;
				block._isOpen = true;
				if (block._rawContent) {
					renderLazyContent(block, block.code);
				}
			}
			return block.details;
		}

		case 'bash': {
			const block = createGenericToolBlock('bash', 'Running...');
			completeGenericToolBlock(block, isOk, evt.result, evt.args?.command);
			return block.el;
		}

		case 'websearch': {
			const block = createWebSearchBlock();
			completeWebSearchBlock(block, isOk);
			return block.el;
		}

		case 'finish_task': {
			const block = createFinishTaskBlock();
			completeFinishTaskBlock(block);
			return block.el;
		}

		default: {
			const block = createGenericToolBlock(name, `${capitalise(name)}...`);
			completeGenericToolBlock(block, isOk, evt.result, evt.args?.command);
			return block.el;
		}
	}
}

/* ------------------------------------------------------------------ */
/* Apply Verbose Mode — live toggle / queued during streaming          */
/* ------------------------------------------------------------------ */

/**
 * Apply verbose mode. If streaming is active, queue the change and show
 * a toast. The caller (renderer.js) is responsible for calling
 * applyPendingVerboseMode() when streaming ends.
 */
export function applyVerboseMode() {
	if (window.__isStreaming) {
		window.__pendingVerbose = !!window.__settings?.verbose;
		if (window.addToast) {
			window.addToast(
				`Verbose ${window.__pendingVerbose ? 'ON' : 'OFF'} — will apply when generation finishes`,
				'',
				3000
			);
		}
		return true;
	}
	_doApplyVerboseMode();
	return false;
}

/**
 * Apply a pending verbose-mode change that was queued during streaming.
 * Call this from renderer.js after streaming stops.
 */
export function applyPendingVerboseMode() {
	if (window.__pendingVerbose === undefined) return;
	const verbose = window.__pendingVerbose;
	delete window.__pendingVerbose;
	// Only apply if the pending value differs from what was active when streaming started.
	// (If the user toggled ON then OFF during streaming, the last toggle wins and
	// __pendingVerbose reflects the final desired state.)
	if (verbose === window.__streamStartVerbose) return;
	_doApplyVerboseMode();
}

function _doApplyVerboseMode() {
	const verbose = !!window.__settings?.verbose;
	document.documentElement.setAttribute('data-verbose', String(verbose));

	if (verbose) {
		hideQuietStatus();
		renderChatFromLog(true);
	} else {
		renderChatFromLog(false);
	}
}

/* ------------------------------------------------------------------ */
/* Legacy compat — removeToolBlocks (no longer needed but kept safe)   */
/* ------------------------------------------------------------------ */

export function removeToolBlocks() {
	const chat = document.getElementById('chat');
	if (!chat) return;
	chat.querySelectorAll('.think-wrapper').forEach(el => el.remove());
	chat.querySelectorAll('.tool-call:not(.finish-task-block)').forEach(el => el.remove());
}
