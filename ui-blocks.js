import { escHtml, capitalise } from './utils.js';

// ═══════════════════════════════════════════════════════════
// Lazy Rendering Helpers
// ═══════════════════════════════════════════════════════════

/**
 * Core lazy-render helper. Renders the full block content into the target
 * container element only when the block is open.
 */
export function renderLazyContent(block, container) {
	if (!block._isOpen) return; // Guard: don't render if block just closed
	container.innerHTML = escHtml(block._rawContent);
}

/**
 * Shared helper to attach the toggle event listener for lazy rendering.
 * Keeps the pattern consistent across all block types.
 */
function setupLazyToggle(details, block, container) {
	details.addEventListener("toggle", () => {
		block._isOpen = details.open;
		if (details.open && block._rawContent) {
			renderLazyContent(block, container);
		} else if (!details.open) {
			container.innerHTML = '';
		}
	});
}

// ═══════════════════════════════════════════════════════════
// Think Blocks
// ═══════════════════════════════════════════════════════════

let lastThinkBlock = null;

/** Create a thinking/reasoning block */
export function createThinkBlock() {
	if (lastThinkBlock) {
		lastThinkBlock.summary.classList.remove("pulsing");
	}

	const details = document.createElement("details");
	details.className = "chat-item think-wrapper";

	const summary = document.createElement("summary");
	summary.textContent = 'Processing...';
	summary.classList.add("pulsing", "processing");

	const content = document.createElement("div");
	content.className = "think-content";
	details.append(summary, content);

	const block = {
		details, summary, content,
		_rawContent: "",
		_isOpen: false
	};

	setupLazyToggle(details, block, content);
	lastThinkBlock = block;

	return block;
}

// ═══════════════════════════════════════════════════════════
// Read Blocks
// ═══════════════════════════════════════════════════════════

/** Format read text with optional line range */
function formatReadText(filePath, offset, limit, reading) {
	let fname = filePath.split(/[/\\]/).pop();
	if (fname === '.') {
		const workDir = window.__settings?.workDir;
		fname = workDir ? workDir.split(/[/\\]/).pop() : 'current directory';
	}
	const action = reading ? "Reading" : "Read";

	if (offset !== null && offset !== undefined) {
		if (limit !== null && limit !== undefined) {
			const endLine = offset + limit - 1;
			return `${action} ${fname} - lines ${offset}-${endLine}`;
		}
		return `${action} ${fname} - line ${offset}+`;
	}

	return `${action} ${fname}`;
}

/** Create a read tool-call block */
export function createReadBlock(filePath, offset = null, limit = null) {
	const div = document.createElement("div");
	div.className = "chat-item tool-call read-block";
	if (filePath) {
		div.textContent = formatReadText(filePath, offset, limit, true);
	} else {
		div.textContent = "Reading...";
	}
	return { el: div, filePath, offset, limit };
}

/** Complete a read block */
export function completeReadBlock(block) {
	block.el.textContent = formatReadText(block.filePath, block.offset, block.limit, false);
}

// ═══════════════════════════════════════════════════════════
// Edit Blocks
// ═══════════════════════════════════════════════════════════

/** Create an edit tool-call block */
export function createEditBlock(filePath) {
	const details = document.createElement("details");
	details.className = "chat-item tool-call edit-block pulsing";

	const summary = document.createElement("summary");
	if (filePath) {
		let fname = filePath.split(/[/\\]/).pop();
		summary.textContent = `Editing ${fname}...`;
	} else {
		summary.textContent = "Editing...";
	}
	details.appendChild(summary);

	const block = {
		el: details, filePath, summary,
		_cachedDiffHtml: null,
		_diffRendered: false,
		_diffPre: null
	};

	// Only inject diff HTML when user expands the block
	details.addEventListener("toggle", () => {
		if (details.open && block._cachedDiffHtml && !block._diffRendered) {
			// Create <pre> on first expand
			const pre = document.createElement("pre");
			pre.className = "diff-content";
			pre.innerHTML = block._cachedDiffHtml;
			details.appendChild(pre);
			block._diffPre = pre;
			block._diffRendered = true;
		} else if (!details.open && block._diffPre) {
			block._diffPre.remove();
			block._diffPre = null;
			block._diffRendered = false;
		}
	});

	return block;
}

/** Complete an edit block with diff rendering */
export function completeEditBlock(block, filePath, edits, fullContent) {
	let fname = filePath.split(/[/\\]/).pop();
	block.el.classList.remove("pulsing");
	block.summary.textContent = `Edited ${fname}${edits.length > 1 ? ` (${edits.length} edits)` : ''}`;

	// Build diff HTML using shared helper
	block._cachedDiffHtml = generateEditDiffHtml(edits, fullContent);

	// If already open, inject immediately
	if (block.el.open) {
		const pre = document.createElement("pre");
		pre.className = "diff-content";
		pre.innerHTML = block._cachedDiffHtml;
		block.el.appendChild(pre);
		block._diffRendered = true;
	}
}

/** Generate diff HTML from edits and full file content (pure function, no DOM) */
export function generateEditDiffHtml(edits, fullContent) {
	const diffLines = [];
	const oldLines = fullContent.split("\n");

	for (let ei = 0; ei < edits.length; ei++) {
		const { oldText, newText } = edits[ei];
		const charIdx = fullContent.indexOf(oldText);

		if (charIdx === -1) {
			diffLines.push(`<span class="diff-error">edit ${ei + 1}: could not locate oldText in file</span>`);
			continue;
		}

		const oldTextLines = oldText.split("\n");
		const newTextLines = newText.split("\n");

		// Find the starting line number
		let matchLine = 0;
		for (let i = 0; i < charIdx && matchLine < oldLines.length; i++) {
			if (fullContent[i] === "\n") matchLine++;
		}

		const endLine = matchLine + oldTextLines.length;
		const ctx = 3;
		const ctxStart = Math.max(0, matchLine - ctx);
		const ctxEnd = Math.min(oldLines.length, endLine + ctx);

		// Add preceding ellipsis if needed
		if (ctxStart > 0 && diffLines.length > 0) {
			diffLines.push(`<span class="diff-ellipsis">. . .</span>`);
		}

		// Context lines before the edit
		for (let i = ctxStart; i < matchLine; i++) {
			diffLines.push(`<span class="diff-context">${escHtml(oldLines[i])}</span>`);
		}

		// Removed lines
		for (const line of oldTextLines) {
			diffLines.push(`<span class="diff-remove">-${escHtml(line)}</span>`);
		}

		// Added lines
		for (const line of newTextLines) {
			diffLines.push(`<span class="diff-add">+${escHtml(line)}</span>`);
		}

		// Context lines after the edit
		for (let i = endLine; i < ctxEnd; i++) {
			diffLines.push(`<span class="diff-context">${escHtml(oldLines[i])}</span>`);
		}

		// Add trailing ellipsis if needed
		if (ctxEnd < oldLines.length) {
			diffLines.push(`<span class="diff-ellipsis">. . .</span>`);
		}
	}

	return diffLines.join("\n");
}

// ═══════════════════════════════════════════════════════════
// Write Blocks
// ═══════════════════════════════════════════════════════════

/** Create a write tool-call block */
export function createWriteBlock(filePath) {
	const details = document.createElement("details");
	details.className = "chat-item tool-call write-block";
	details.dataset.tool = "write";

	const summary = document.createElement("summary");
	summary.className = "pulsing";
	if (filePath) {
		let fname = filePath.split(/[\\/]/).pop();
		summary.textContent = `Writing ${fname} - 0 lines`;
	} else {
		summary.textContent = "Writing...";
	}

	const content = document.createElement("div");
	content.className = "tool-content";

	const code = document.createElement("code");
	code.className = "tool-output";
	content.appendChild(code);

	details.append(summary, content);

	const block = {
		details, summary, code, filePath,
		resolvedFilename: filePath ? filePath.split(/[\\/]/).pop() : null,
		lineCount: 0,
		lastContentLength: 0,
		lastUpdateTime: 0,
		_rawContent: "",
		_isOpen: false
	};

	setupLazyToggle(details, block, code);

	return block;
}

/** Update a write block during streaming (throttled) */
export function updateWriteBlock(block, content) {
	const now = performance.now();
	const charsSinceLast = content.length - block.lastContentLength;

	// Throttle: update if enough chars accumulated OR enough time passed
	if (charsSinceLast < 80 && (now - block.lastUpdateTime) < 300) return;
	block.lastContentLength = content.length;
	block.lastUpdateTime = now;

	// 1. Update JS memory, NOT the DOM
	block._rawContent = content;
	block.lineCount = content.split("\n").length;

	// 2. Always update the summary so the user sees progress
	const fname = block.resolvedFilename || block.filePath.split(/[\\/]/).pop();
	block.summary.textContent = `Writing ${fname} - ${block.lineCount} lines`;

	// 3. Only hit the DOM if the user is actively watching it stream
	if (block._isOpen) {
		renderLazyContent(block, block.code);
	}
}

/** Complete a write block */
export function completeWriteBlock(block, content) {
	block._rawContent = content; // Finalize memory
	const lines = content.split("\n").length;
	const fname = block.resolvedFilename || block.filePath.split(/[\\/]/).pop();

	block.summary.textContent = `Wrote ${fname} - ${lines} lines`;
	block.summary.classList.remove("pulsing");

	// Only hit the DOM if it's currently open
	if (block._isOpen) {
		renderLazyContent(block, block.code);
	}
}

// ═══════════════════════════════════════════════════════════
// Finish Task Blocks
// ═══════════════════════════════════════════════════════════

/** Create a finish_task tool-call block (non-expandable, like read) */
export function createFinishTaskBlock() {
	const div = document.createElement("div");
	div.className = "chat-item tool-call finish-task-block pulsing";
	div.textContent = "Finishing task...";
	return { el: div };
}

/** Complete a finish_task block */
export function completeFinishTaskBlock(block) {
	block.el.textContent = "Finished task";
	block.el.classList.remove("pulsing");
}

// ═══════════════════════════════════════════════════════════
// Web Search Blocks (non-expandable, like read)
// ═══════════════════════════════════════════════════════════

/** Create a websearch tool-call block */
export function createWebSearchBlock() {
	const div = document.createElement("div");
	div.className = "chat-item tool-call websearch-block pulsing";
	div.textContent = "Searching the web...";
	return { el: div, _queries: [], _intent: "" };
}

/** Update a websearch block during streaming */
export function updateWebSearchBlock(block, queries, intent) {
	if (queries && queries.length > 0) {
		block._queries = queries;
		const q = queries[0];
		const truncated = q.length > 60 ? q.substring(0, 60) + '...' : q;
		const count = queries.length > 1 ? ` (+${queries.length - 1})` : '';
		block.el.textContent = `Searching the web: "${truncated}"${count}`;
	}
	if (intent && !block.el.textContent.startsWith('Searching the web:')) {
		block._intent = intent;
		block.el.textContent = `Searching the web...`;
	}
}

/** Complete a websearch block */
export function completeWebSearchBlock(block, success) {
	block.el.classList.remove("pulsing");

	if (success) {
		if (block._queries.length > 0) {
			const q = block._queries[0];
			const truncated = q.length > 60 ? q.substring(0, 60) + '...' : q;
			block.el.textContent = `Searched: "${truncated}"`;
		} else {
			block.el.textContent = "Searched the web";
		}
	}
}

// ═══════════════════════════════════════════════════════════
// Generic Tool-Call Blocks
// ═══════════════════════════════════════════════════════════

/** Create a generic tool-call block (div-based, like read/websearch) */
export function createGenericToolBlock(toolName, statusText) {
	const div = document.createElement("div");
	div.className = "chat-item tool-call generic-tool-block pulsing";
	div.dataset.tool = toolName;
	div.textContent = statusText;
	return { el: div, toolName };
}

/** Complete a generic tool-call block */
export function completeGenericToolBlock(block, success, output, command = "") {
	block.el.classList.remove("pulsing");

	if (success) {
		const displayName = capitalise(block.toolName);
		if (block.toolName === "bash") {
			const cmdStr = command || "";
			const truncated = cmdStr.length > 50 ? cmdStr.substring(0, 50) + "..." : cmdStr;
			block.el.textContent = `bash: $ ${truncated}`;
		} else {
			block.el.textContent = displayName;
		}
	} else {
		block.el.textContent = `${capitalise(block.toolName)} failed`;
	}
}
