/* ------------------------------------------------------------------ */
/* History modal — open/close/render/switch/search/delete             */
/* ------------------------------------------------------------------ */

import { listHistories, deleteHistory } from './history-store.js';
import { switchToHistory, resetSession } from './session-manager.js';

const DELETE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M4 7l16 0"/><path d="M10 11l0 6"/><path d="M14 11l0 6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/></svg>`;

/**
 * Wire up the history modal DOM elements and events.
 * @param {object} deps — { chat, prompt, history, requestStop }
 */
export function initHistoryModal(deps) {
	const historyBtn = document.getElementById('history-btn');
	const historyModal = document.getElementById('history-modal');
	const historyModalOverlay = document.getElementById('history-modal-overlay');
	const historySearch = document.getElementById('history-search');
	const historyList = document.getElementById('history-list');
	const historyCloseBtn = document.getElementById('history-close-btn');

	function openModal() {
		historyModal.classList.add('visible');
		historySearch.value = '';
		renderList();
		historySearch.focus();
	}

	function closeModal() {
		historyModal.classList.remove('visible');
	}

	async function renderList(filter = '') {
		const sessions = await listHistories();
		const filtered = filter
			? sessions.filter(s => s.title.toLowerCase().includes(filter.toLowerCase()))
			: sessions;

		historyList.innerHTML = '';

		if (filtered.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'history-empty';
			empty.textContent = filter ? 'No matching chats found.' : 'No previous chats.';
			historyList.appendChild(empty);
			return;
		}

		for (const session of filtered) {
			const item = document.createElement('div');
			item.className = 'history-item';
			if (session.id === window.__session.currentHistoryId) item.classList.add('active');

			const titleEl = document.createElement('span');
			titleEl.className = 'history-item-title';
			titleEl.textContent = session.title;

			const dateEl = document.createElement('span');
			dateEl.className = 'history-item-date';
			dateEl.textContent = formatDate(session.createdAt);

			const deleteBtn = document.createElement('button');
			deleteBtn.className = 'history-item-delete';
			deleteBtn.title = 'Delete chat';
			deleteBtn.innerHTML = DELETE_SVG;

			item.appendChild(titleEl);
			item.appendChild(dateEl);
			item.appendChild(deleteBtn);

			titleEl.addEventListener('click', async () => {
				await switchToHistory(deps, session.id);
				closeModal();
			});

			deleteBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				await deleteHistory(session.id);
				if (session.id === window.__session.currentHistoryId) {
					resetSession(deps);
				}
				renderList(historySearch.value);
			});

			historyList.appendChild(item);
		}
	}

	historyBtn.addEventListener('click', openModal);
	historyCloseBtn.addEventListener('click', closeModal);
	historyModalOverlay.addEventListener('click', closeModal);
	historySearch.addEventListener('input', () => renderList(historySearch.value));

	// Close modal when clicking outside
	document.addEventListener('click', (e) => {
		if (historyModal.classList.contains('visible') &&
			!historyModal.contains(e.target) &&
			e.target !== historyBtn &&
			!historyBtn.contains(e.target)) {
			closeModal();
		}
	});

	// Close modal on Escape
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && historyModal.classList.contains('visible')) {
			closeModal();
		}
	});
}

/** "2026-08-21T12:00:00Z" → "Aug 21, 2026 12:00" (best effort) */
function formatDate(iso) {
	if (!iso) return '';
	try {
		const d = new Date(iso);
		if (isNaN(d)) return '';
		const now = new Date();
		const sameYear = d.getFullYear() === now.getFullYear();
		const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const date = `${months[d.getMonth()]} ${d.getDate()}`;
		const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		return sameYear ? `${date} ${time}` : `${date}, ${d.getFullYear()} ${time}`;
	} catch { return ''; }
}
