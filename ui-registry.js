import {
	capitalise,
	extractPartialValue,
	extractPartialNumber,
	extractPartialArray,
} from './utils.js';

import {
	createReadBlock,
	completeReadBlock,
	createEditBlock,
	completeEditBlock,
	generateEditDiffHtml,
	createWriteBlock,
	updateWriteBlock,
	completeWriteBlock,
	createFinishTaskBlock,
	completeFinishTaskBlock,
	createWebSearchBlock,
	updateWebSearchBlock,
	completeWebSearchBlock,
	createGenericToolBlock,
	completeGenericToolBlock,
	renderLazyContent,
} from './ui-blocks.js';

import {
	isImageResult,
	parseImageMarker,
} from './message-builder.js';

import {
	logToolCall,
	showQuietStatus,
	hideQuietStatus,
	getQuietStatusEl,
} from './verbose-mode.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Check if verbose mode is on */
function isVerbose() {
	return !!window.__settings?.verbose;
}

/** Get the chat element */
function getChat() {
	return document.getElementById('chat');
}

/**
 * Insert element into chat after the element with order-1.
 * Sets data-order on the inserted element. Falls back to data-seq lookup.
 */
function insertBlock(el, order) {
	const chat = getChat();
	el.dataset.order = order;
	// Find the PREVIOUS element (order-1), with fallback to data-seq
	const prev = order - 1;
	let ref = prev > 0 ? chat.querySelector(`[data-order="${prev}"]`) : null;
	if (!ref) ref = prev > 0 ? chat.querySelector(`[data-seq="${prev}"]`) : null;
	chat.insertBefore(el, ref ? ref.nextSibling : null);
}

/** Extract filename from path */
function fname(path) {
	const name = path?.split(/[\\/]/).pop() || 'file';
	if (name === '.') {
		const workDir = window.__settings?.workDir;
		if (workDir) {
			const dirName = workDir.split(/[\\/]/).filter(Boolean).pop();
			return dirName || 'current directory';
		}
		return 'current directory';
	}
	return name;
}

/** Truncate string for display */
function trunc(s, max = 50) {
	return s.length > max ? s.substring(0, max) + '...' : s;
}

/* ------------------------------------------------------------------ */
/* UI Registry — maps tool names to UI handler objects               */
/* ------------------------------------------------------------------ */

const UIRegistry = new Map();
export default UIRegistry;

/** Generic fallback for unknown / plugin-added tools */
export const GENERIC_HANDLER = {
	create: (entry, order) => {
		const displayName = capitalise(entry.name);
		let statusText = `${displayName}...`;
		const command = extractPartialValue(entry, 'command') || '';
		if (command) {
			statusText = `running $ ${trunc(command)}`;
		}

		if (!isVerbose()) {
			showQuietStatus(statusText);
			return { type: 'generic', block: null, quiet: true, order };
		}

		const block = createGenericToolBlock(entry.name, statusText);
		insertBlock(block.el, order);
		return { type: 'generic', block, order };
	},

	update: (uiBlock, entry) => {
		const partialCommand = extractPartialValue(entry, 'command');
		if (partialCommand && uiBlock.block) {
			uiBlock.block.el.textContent = `running $ ${trunc(partialCommand)}`;
		}
		if (partialCommand && uiBlock?.quiet) {
			showQuietStatus(`running $ ${trunc(partialCommand)}`);
		}
	},

	complete: (uiBlock, result, tc) => {
		const command = tc?.args?.command || '';
		logToolCall(tc?.name || 'unknown', tc?.args, result, null, { command });
		if (uiBlock?.block) completeGenericToolBlock(uiBlock.block, true, result, command);
		if (uiBlock?.quiet) hideQuietStatus();
	},

	completeError: (uiBlock, error, tc) => {
		logToolCall(tc?.name || 'unknown', tc?.args, null, error);
		if (uiBlock?.block) completeGenericToolBlock(uiBlock.block, false, null);
		if (uiBlock?.quiet) hideQuietStatus();
	}
};

/* -- write -- */
UIRegistry.set('write', {
	create: (entry, order) => {
		const filePath = extractPartialValue(entry, 'path') || null;

		if (!isVerbose()) {
			const n = filePath ? fname(filePath) : null;
			showQuietStatus(n ? `Writing ${n}...` : 'Writing...');
			return { type: 'write', block: null, quiet: true, filePath, order };
		}

		const block = createWriteBlock(filePath);
		insertBlock(block.details, order);
		return { type: 'write', block, order };
	},

	update: (uiBlock, entry) => {
		const partialPath = extractPartialValue(entry, 'path');
		if (partialPath && uiBlock?.quiet) {
			showQuietStatus(`Writing ${fname(partialPath)}...`);
		}
		if (partialPath && uiBlock?.block) {
			uiBlock.block.resolvedFilename = fname(partialPath);
			const lines = uiBlock.block.lineCount || 0;
			uiBlock.block.summary.textContent = `Writing ${fname(partialPath)} - ${lines} lines`;
		}
		const partialContent = extractPartialValue(entry, 'content');
		if (partialContent && uiBlock?.block) updateWriteBlock(uiBlock.block, partialContent);
	},

	complete: (uiBlock, result, tc) => {
		const lineCount = tc?.args?.content ? tc.args.content.split('\n').length : 0;
		// Always capture raw content from args for replay on toggle
		const rawContent = tc.args.content || null;
		const writeOpen = uiBlock?.block?.details?.open || false;
		logToolCall('write', tc.args, result, null, { rawContent, writeOpen });
		if (uiBlock?.block) {
			if (!uiBlock.block.resolvedFilename) {
				uiBlock.block.resolvedFilename = fname(tc.args.path);
			}
			if (tc.args.content) completeWriteBlock(uiBlock.block, tc.args.content);
		}
		if (uiBlock?.quiet) hideQuietStatus();
	},

	completeError: (uiBlock, error) => {
		logToolCall('write', { path: uiBlock?.filePath }, null, error);
		if (uiBlock?.block) {
			const msg = (typeof error === 'object' && error !== null) ? error.message : error;
			uiBlock.block.summary.textContent = `Write failed: ${msg}`;
			uiBlock.block.summary.classList.remove('pulsing');
		}
		if (uiBlock?.quiet) hideQuietStatus();
	}
});

/* -- edit -- */
UIRegistry.set('edit', {
	create: (entry, order) => {
		const filePath = extractPartialValue(entry, 'path') || null;

		if (!isVerbose()) {
			const n = filePath ? fname(filePath) : null;
			showQuietStatus(n ? `Editing ${n}...` : 'Editing...');
			return { type: 'edit', block: null, quiet: true, filePath, order };
		}

		const block = createEditBlock(filePath);
		insertBlock(block.el, order);
		return { type: 'edit', block, order };
	},

	update: (uiBlock, entry) => {
		const partialPath = extractPartialValue(entry, 'path');
		if (partialPath && uiBlock?.quiet) {
			showQuietStatus(`Editing ${fname(partialPath)}...`);
		}
		if (partialPath && uiBlock?.block) {
			uiBlock.block.summary.textContent = `Editing ${fname(partialPath)}...`;
		}
	},

	preExecute: async (tc) => {
		const fullContent = await window.electron.invoke('tool:execute', 'read', { path: tc.args.path });
		return { fullContent };
	},

	complete: (uiBlock, result, tc, context) => {
		const editCount = (tc?.args?.edits || []).length;
		// Always generate diff HTML for replay on toggle (even in non-verbose mode)
		const diffHtml = context.fullContent
			? generateEditDiffHtml(tc.args.edits || [], context.fullContent)
			: null;
		const diffOpen = uiBlock?.block?.el?.open || false;
		logToolCall('edit', tc.args, result, null, { diffHtml, diffOpen });
		if (uiBlock?.block) {
			completeEditBlock(uiBlock.block, tc.args.path, tc.args.edits || [], context.fullContent);
			if (result?.ui) {
				uiBlock.block.summary.textContent = result.ui;
			}
		}
		if (uiBlock?.quiet) hideQuietStatus();
	},

	completeError: (uiBlock, error, tc) => {
		logToolCall('edit', tc?.args, null, error);
		if (uiBlock?.block) {
			const n = tc?.args?.path?.split(/[/\\]/).pop() || 'file';
			const shortMsg = (typeof error === 'object' && error !== null && error.ui)
				? error.ui
				: `Edit failed — ${n}`;
			uiBlock.block.summary.textContent = shortMsg;
			uiBlock.block.el.classList.remove('pulsing');
			uiBlock.block.el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-tert').trim();
		}
		if (uiBlock?.quiet) hideQuietStatus();
	}
});

/* -- read -- */
UIRegistry.set('read', {
	create: (entry, order) => {
		const filePath = extractPartialValue(entry, 'path') || null;
		const offset = extractPartialNumber(entry, 'offset');
		const limit = extractPartialNumber(entry, 'limit');

		if (!isVerbose()) {
			const n = filePath ? fname(filePath) : null;
			let lineInfo = '';
			if (offset !== null) {
				if (limit !== null) {
					lineInfo = ` - lines ${offset}-${offset + limit - 1}`;
				} else {
					lineInfo = ` - line ${offset}+`;
				}
			}
			showQuietStatus(n ? `Reading ${n}${lineInfo}...` : 'Reading...');
			return { type: 'read', block: null, quiet: true, filePath, offset, limit, order };
		}

		const block = createReadBlock(filePath, offset, limit);
		insertBlock(block.el, order);
		return { type: 'read', block, order };
	},

	update: (uiBlock, entry) => {
		const partialPath = extractPartialValue(entry, 'path');
		if (partialPath) {
			const n = fname(partialPath);
			const partialOffset = extractPartialNumber(entry, 'offset');
			const partialLimit = extractPartialNumber(entry, 'limit');

			let lineInfo = '';
			const off = partialOffset ?? uiBlock?.block?.offset ?? uiBlock?.offset ?? null;
			const lim = partialLimit ?? uiBlock?.block?.limit ?? uiBlock?.limit ?? null;
			if (off !== null) {
				if (lim !== null) {
					lineInfo = ` - lines ${off}-${off + lim - 1}`;
				} else {
					lineInfo = ` - line ${off}+`;
				}
			}

			if (uiBlock?.quiet) {
				showQuietStatus(`Reading ${n}${lineInfo}...`);
			}
			if (uiBlock?.block) {
				if (partialOffset !== null) uiBlock.block.offset = partialOffset;
				if (partialLimit !== null) uiBlock.block.limit = partialLimit;
				uiBlock.block.el.textContent = `Reading ${n}${lineInfo}...`;
			}
		}
	},

	complete: (uiBlock, result, tc) => {
		logToolCall('read', tc.args, result, null);
		if (uiBlock?.block) {
			if (isImageResult(result)) {
				const img = parseImageMarker(result);
				const displayName = img ? img.filename : tc.args.path;
				uiBlock.block.el.textContent = `Read image: ${displayName}`;
			} else {
				completeReadBlock(uiBlock.block);
			}
		}
		if (uiBlock?.quiet) hideQuietStatus();
	},

	completeError: (uiBlock, error) => {
		logToolCall('read', { path: uiBlock?.filePath }, null, error);
		if (uiBlock?.block) {
			const msg = (typeof error === 'object' && error !== null) ? error.message : error;
			uiBlock.block.el.textContent = msg;
			uiBlock.block.el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-tert').trim();
		}
		if (uiBlock?.quiet) hideQuietStatus();
	}
});

/* -- websearch -- */
UIRegistry.set('websearch', {
	create: (entry, order) => {
		if (!isVerbose()) {
			showQuietStatus('Searching the web...');
			return { type: 'websearch', block: null, quiet: true, order };
		}

		const block = createWebSearchBlock();
		insertBlock(block.el, order);
		return { type: 'websearch', block, order };
	},

	update: (uiBlock, entry) => {
		const queries = extractPartialArray(entry, 'queries');
		if (queries && queries.length > 0 && uiBlock?.quiet) {
			const q = trunc(queries[0], 60);
			const count = queries.length > 1 ? ` (+${queries.length - 1})` : '';
			showQuietStatus(`Searching: "${q}"${count}`);
		}
		if (uiBlock?.block) {
			updateWebSearchBlock(uiBlock.block, queries, extractPartialValue(entry, 'intent'));
		}
	},

	complete: (uiBlock, result, tc) => {
		logToolCall('websearch', tc?.args, result, null);
		if (uiBlock?.block) completeWebSearchBlock(uiBlock.block, true);
		if (uiBlock?.quiet) hideQuietStatus();
	},

	completeError: (uiBlock) => {
		logToolCall('websearch', {}, null, 'Search failed');
		if (uiBlock?.block) {
			completeWebSearchBlock(uiBlock.block, false);
			uiBlock.block.el.textContent = 'Search failed';
			uiBlock.block.el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-tert').trim();
		}
		if (uiBlock?.quiet) hideQuietStatus();
	}
});

/* -- finish_task -- */
UIRegistry.set('finish_task', {
	create: (entry, order) => {
		if (!isVerbose()) {
			showQuietStatus('Finishing task...');
			return { type: 'finish_task', block: null, quiet: true, order };
		}

		const block = createFinishTaskBlock();
		insertBlock(block.el, order);
		return { type: 'finish_task', block, order };
	},

	update: (uiBlock) => {
		if (uiBlock?.block) uiBlock.block.el.textContent = 'Finishing task...';
	},

	complete: (uiBlock) => {
		logToolCall('finish_task', {}, null, null);
		if (uiBlock?.block) completeFinishTaskBlock(uiBlock.block);
		// Non-verbose: show "Finished task" and DON'T hide it (exception to cleanup)
		if (uiBlock?.quiet) {
			const el = getQuietStatusEl();
			el.textContent = 'Finished task';
			el.classList.remove('visible');
			el.classList.add('visible', 'finish-task');
		}
	}
});
