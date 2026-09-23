/* ------------------------------------------------------------------ */
/* Saved conversation histories — renderer-side API                   */
/* ------------------------------------------------------------------ */

/** Phrases that shouldn't trigger title generation (e.g. "hi" → "hi") */
const titleSkipPhrases = new Set([
	'hi', 'hey', 'hello',
	'tell me a joke', 'write a story',
]);

/** True if the message is too generic to be useful as a title source */
export function shouldSkipTitle(text) {
	return titleSkipPhrases.has(String(text || '').toLowerCase().replace(/[^\w\s]/g, ''));
}

/**
 * Generate a title for a new chat — local CPU first, HTTP fallback.
 */
export async function generateTitle(firstUserMessage) {
	// ── Try local SupraTitle-50M CPU model first ──
	try {
		const title = await window.electron.invoke('title:generate', firstUserMessage);
		if (title && title !== 'Untitled Chat') return title;
	} catch (localErr) {
		console.warn('[history-store] Local title gen failed, falling back to HTTP:', localErr.message);
	}

	// ── Fallback: call the main LLM via HTTP ──
	const { getApiUrl, getApiHeaders, getBodyExtras, getEndpoint } = await import('./utils.js');

	try {
		const res = await fetch(getApiUrl() + getEndpoint(), {
			method: 'POST',
			headers: getApiHeaders(),
			body: JSON.stringify({
				messages: [
					{
						role: 'system',
						content: 'You title user/ai chats based off the first user message. Respond with ONLY the title, no quotes, no explanation, max 60 characters.',
					},
					{
						role: 'user',
						content: 'Give a title to this chat based off this message: ' + firstUserMessage,
					},
				],
				stream: false,
				...getBodyExtras(),
			}),
		});

		if (!res.ok) throw new Error(`Title generation failed: ${res.status}`);
		const data = await res.json();
		const title = data.choices?.[0]?.message?.content?.trim();
		return title || 'Untitled Chat';
	} catch (err) {
		console.error('[history-store] Title generation error:', err);
		return 'Untitled Chat';
	}
}

/** List all saved histories, sorted most recent first */
export function listHistories() {
	return window.electron.invoke('sessions:list');
}

/** Load a saved history by its ID */
export function loadHistory(id) {
	return window.electron.invoke('sessions:load', id);
}

/** Delete a saved history by its ID */
export function deleteHistory(id) {
	return window.electron.invoke('sessions:delete', id);
}

/** New history ID */
export function newHistoryId() {
	return window.electron.invoke('sessions:new');
}

/**
 * Save the current chat to a saved history file.
 * Creates the file on first save (with a generated title) or overwrites
 * the existing one for the current session.
 * Returns the history id, or null if the save was skipped.
 */
export async function saveHistoryFile({ history, chatHtml, eventLog }) {
	const s = window.__session;

	// For new sessions, if ALL user messages are skip phrases, don't save yet.
	// The session will be saved once a real (non-skip) message arrives.
	if (!s.currentHistoryId) {
		const userMsgs = history.filter(m => m.role === 'user');
		if (userMsgs.length > 0 && userMsgs.every(m => shouldSkipTitle(String(m.content || '')))) {
			s.awaitingTitle = true;
			return null;
		}
	}

	if (!s.currentHistoryId) {
		s.currentHistoryId = await newHistoryId();
	}

	// Generate title from first non-skip user message
	if (!s.currentHistoryTitle || s.awaitingTitle) {
		const firstRealUser = history.find(m => m.role === 'user' && !shouldSkipTitle(String(m.content || '')));
		if (firstRealUser) {
			s.currentHistoryTitle = await generateTitle(String(firstRealUser.content).slice(0, 300));
		} else {
			s.currentHistoryTitle = 'Untitled Chat';
		}
		s.awaitingTitle = false;
	}

	await window.electron.invoke('sessions:save', {
		id: s.currentHistoryId,
		title: s.currentHistoryTitle || 'Untitled Chat',
		history,
		chatHtml,
		eventLog: eventLog || [],
	});
	return s.currentHistoryId;
}
