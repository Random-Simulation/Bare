/* ------------------------------------------------------------------ */
/* Session management — new session, temp session, shared reset       */
/* ------------------------------------------------------------------ */

import { applyTheme } from './settings.js';
import { loadHistory } from './history-store.js';
import { resetTruncationState } from './context-truncation.js';

/**
 * Reset all session state and clear the chat DOM.
 * @param {object} deps — { chat, prompt, history, queuedMessages, resetFolderPrompt }
 */
export function resetSession(deps) {
	const { chat, prompt, history, queuedMessages } = deps;

	chat.innerHTML = '';
	history.length = 0;
	(queuedMessages || []).length = 0;

	const s = window.__session;
	s.currentHistoryId = null;
	s.currentHistoryTitle = null;
	s.awaitingTitle = false;

	window.__eventLog = [];
	window.__seq = 0;
	window.__order = 0;

	resetTruncationState();

	if (window.resetContextBar) window.resetContextBar();
	if (deps.resetFolderPrompt) deps.resetFolderPrompt();
	prompt.focus();
}

/**
 * Load an existing saved history into the current state + DOM.
 * @param {object} data — history data from storage ({ id, title, history, eventLog })
 */
export function loadHistoryIntoState(data) {
	const chat = document.getElementById('chat');
	const prompt = document.getElementById('prompt');
	const history = window.__history;

	history.length = 0;
	for (const msg of data.history || []) history.push(msg);

	window.__eventLog = (data.eventLog && data.eventLog.length > 0) ? data.eventLog : [];
	window.__seq = 0;
	window.__order = 0;

	resetTruncationState();

	const s = window.__session;
	s.currentHistoryId = data.id;
	s.currentHistoryTitle = data.title;

	// Rebuild the UI from the event log (source of truth) or fall back to saved HTML
	if (window.__eventLog.length > 0) {
		// Imported statically below via renderChatFromLog export chain
		renderFromLog();
	} else if (data.chatHtml) {
		chat.innerHTML = data.chatHtml;
		// Re-attach copy buttons on restored assistant messages
		for (const div of chat.querySelectorAll('.msg.ai')) {
			try { addCopyButtonsStatic(div); } catch { /* best effort */ }
		}
	}

	if (window.resetContextBar) window.resetContextBar();
	chat.scrollTop = chat.scrollHeight;
	prompt.focus();
}

// Stubs replaced by renderer.js after import (avoids circular ESM imports)
function renderFromLog() {
	if (typeof window.__renderFromLog === 'function') {
		window.__renderFromLog(!!window.__settings?.verbose);
	}
}
function addCopyButtonsStatic(div) {
	if (typeof window.__addCopyButtons === 'function') window.__addCopyButtons(div);
}

/**
 * Switch to a saved history (stops any in-flight request first).
 * @param {object} deps — { requestStop }
 * @param {string} id — the history id
 */
export async function switchToHistory(deps, id) {
	if (window.__isStreaming) deps.requestStop();

	// Exit temporary session mode
	const s = window.__session;
	s.isTemporarySession = false;
	document.documentElement.classList.remove('temporary-session');
	window.electron.invoke('titlebar:temp-mode', { active: false }).catch(() => {});
	applyTheme(window.__settings?.theme || 'light');
	if (window.pollContext) window.pollContext();

	const data = await loadHistory(id);
	if (!data || !data.history) return;

	loadHistoryIntoState(data);
}

/** Handle the "new session" button click */
export async function handleNewSession(deps) {
	// Exit temporary session mode
	const s = window.__session;
	s.isTemporarySession = false;
	document.documentElement.classList.remove('temporary-session');
	window.electron.invoke('titlebar:temp-mode', { active: false }).catch(() => {});
	applyTheme(window.__settings?.theme || 'light');
	if (window.pollContext) window.pollContext();

	// A fresh normal session replaces whatever was last on disk, so clear the
	// restart pointer and any mid-loop checkpoint (covers switching in from a
	// temp session too)
	await window.electron.invoke('sessions:clear-last');
	await window.electron.invoke('session:clear-full').catch(() => {});

	resetSession(deps);
}

/** Handle the "temporary session" button click */
export function handleTempSession(deps) {
	const s = window.__session;

	// Enter temporary session mode (reset if already in it)
	s.isTemporarySession = true;
	document.documentElement.classList.add('temporary-session');
	window.electron.invoke('titlebar:temp-mode', { active: true }).catch(() => {});
	if (window.pollContext) window.pollContext();

	// Clear any stale checkpoint from a previous normal session
	window.electron.invoke('session:clear-full').catch(() => {});

	resetSession(deps);
}
