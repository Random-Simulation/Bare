/**
 * Progressive zone-based context truncation.
 *
 * The history is always structured as:
 *   [HEAD (full)] [SKELETON (summarized)] [TAIL (full)]
 *
 * Zones shrink over successive passes until context is under threshold:
 *
 *   Pass 1 (ctx > 87.5%):
 *     Split into head (17.5%) / skeleton (60%) / tail (22.5%).
 *     Summarize skeleton in-place (elide tool results, drop reasoning).
 *
 *   Pass 2–6 (ctx > 50%):
 *     Shrink head by 3.5% and tail by 4.5% each pass.
 *     Converted messages are summarized in-place (grow skeleton outward).
 *
 *   Pass 7+ (ctx > 50%, head=0, tail=0):
 *     Prune the middle 50% of the skeleton.
 *     Keep first N messages (anchor) + last portion.
 *     Insert "[N messages elided]" separator.
 *
 * KV-cache friendly: the head prefix stays stable across passes,
 * so llama.cpp can reuse cached KV for the unchanged prefix.
 */

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

let _state = {
	active: false,
	headEnd: 0,     // messages [0, headEnd) are HEAD (full)
	tailStart: 0,   // messages [tailStart, n) are TAIL (full)
};

/** Reset state on new session or history load. */
export function resetTruncationState() {
	_state = { active: false, headEnd: 0, tailStart: 0 };
}

/* ------------------------------------------------------------------ */
/* Core helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Summarize a message in-place for the skeleton zone.
 * - Assistant: drop reasoning (thinking)
 * - Tool: replace content with a short stub
 * - User: keep as-is
 */
function summarizeInPlace(msg) {
	msg._skeleton = true;
	if (msg.role === 'assistant') {
		msg.reasoning = undefined;
	} else if (msg.role === 'tool') {
		msg.content = '[result elided]';
	}
}

/**
 * Identify message groups starting at index `start` up to `end`.
 * A group is: a user message, or an assistant message + its tool results.
 * Returns array of { start, end } (end is exclusive).
 */
function getMessageGroups(history, start, end) {
	const groups = [];
	let i = start;
	while (i < end) {
		const msg = history[i];
		if (msg.role === 'user') {
			groups.push({ start: i, end: i + 1 });
			i++;
		} else if (msg.role === 'assistant') {
			let groupEnd = i + 1;
			if (msg.tool_calls && msg.tool_calls.length > 0) {
				const toolIds = new Set(msg.tool_calls.map(tc => tc.id));
				while (groupEnd < end && history[groupEnd].role === 'tool' && toolIds.has(history[groupEnd].tool_call_id)) {
					groupEnd++;
				}
			}
			groups.push({ start: i, end: groupEnd });
			i = groupEnd;
		} else if (msg.role === 'tool') {
			// Orphan tool message — treat as single-item group
			groups.push({ start: i, end: i + 1 });
			i++;
		} else {
			// Context separator or other — skip
			groups.push({ start: i, end: i + 1 });
			i++;
		}
	}
	return groups;
}

/* ------------------------------------------------------------------ */
/* Pass 1: Initial split                                              */
/* ------------------------------------------------------------------ */

function doInitialSplit(history) {
	const n = history.length;
	const headEnd = Math.floor(n * window.BARE.TRUNC_HEAD_PCT);
	const tailStart = n - Math.floor(n * window.BARE.TRUNC_TAIL_PCT);

	if (tailStart <= headEnd) return false; // Not enough to split

	// Mark and summarize skeleton zone
	for (let i = headEnd; i < tailStart; i++) {
		summarizeInPlace(history[i]);
	}

	_state = { active: true, headEnd, tailStart };

	console.log(
		`[TRUNC] Pass 1: split at ${n} msgs. Head: [0,${headEnd}), Skeleton: [${headEnd},${tailStart}), Tail: [${tailStart},${n})`
	);
	return true;
}

/* ------------------------------------------------------------------ */
/* Pass 2–6: Shrink head/tail                                         */
/* ------------------------------------------------------------------ */

function shrinkZones(history) {
	const n = history.length;
	if (_state.headEnd === 0 && _state.tailStart >= n) return false;

	let shrunk = false;

	// Shrink head: convert last messages of head → skeleton
	if (_state.headEnd > 0) {
		const shrink = Math.min(_state.headEnd, Math.max(1, Math.floor(n * window.BARE.TRUNC_HEAD_SHRINK_PCT)));
		for (let i = _state.headEnd - shrink; i < _state.headEnd; i++) {
			summarizeInPlace(history[i]);
		}
		_state.headEnd -= shrink;
		shrunk = true;
	}

	// Shrink tail: convert first messages of tail → skeleton
	if (_state.tailStart < n) {
		const tailLen = n - _state.tailStart;
		const shrink = Math.min(tailLen, Math.max(1, Math.floor(n * window.BARE.TRUNC_TAIL_SHRINK_PCT)));
		for (let i = _state.tailStart; i < _state.tailStart + shrink; i++) {
			summarizeInPlace(history[i]);
		}
		_state.tailStart += shrink;
		shrunk = true;
	}

	if (shrunk) {
		console.log(
			`[TRUNC] Shrink: Head: [0,${_state.headEnd}), Skeleton: [${_state.headEnd},${_state.tailStart}), Tail: [${_state.tailStart},${n})`
		);
	}
	return shrunk;
}

/* ------------------------------------------------------------------ */
/* Pass 7+: Prune skeleton middle                                     */
/* ------------------------------------------------------------------ */

function pruneSkeletonMiddle(history) {
	const n = history.length;
	const skeletonEnd = Math.min(_state.tailStart, n);
	const skeletonCount = skeletonEnd;

	if (skeletonCount < 8) return false; // Not enough to meaningfully prune

	// Drop the middle 50% of the skeleton
	const dropCount = Math.floor(skeletonCount * window.BARE.TRUNC_SKELETON_PRUNE_PCT);
	if (dropCount < 2) return false;

	// We want to drop from the middle: keep ~half at start, ~half at end
	const keepHead = Math.floor((skeletonCount - dropCount) / 2);

	// Find group boundaries in the drop region [keepHead, keepHead + dropCount)
	const groups = getMessageGroups(history, keepHead, keepHead + dropCount);

	// Snap to full groups
	let dropped = 0;
	let dropStartIdx = -1;
	let dropEndIdx = -1;

	for (const g of groups) {
		const groupSize = g.end - g.start;
		if (dropped + groupSize <= dropCount) {
			if (dropStartIdx === -1) dropStartIdx = g.start;
			dropped += groupSize;
			dropEndIdx = g.end;
		} else {
			break;
		}
	}

	if (dropStartIdx === -1 || dropEndIdx <= dropStartIdx) return false;

	const actualDropped = dropEndIdx - dropStartIdx;

	// Splice out the dropped messages
	history.splice(dropStartIdx, actualDropped);

	// Insert separator at the cut point
	const separator = {
		role: 'user',
		content: `--- context boundary (${actualDropped} messages elided) ---`,
		_isContextSeparator: true,
	};
	history.splice(dropStartIdx, 0, separator);

	// Adjust tailStart: net change is (-actualDropped + 1 for separator)
	_state.tailStart = _state.tailStart - actualDropped + 1;

	console.log(
		`[TRUNC] Skeleton prune: dropped ${actualDropped} msgs from middle. New length: ${history.length}. Tail starts at: ${_state.tailStart}`
	);
	return true;
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Check context usage and perform the appropriate truncation pass.
 *
 * @param {Array} history - The message history array (mutated in-place)
 * @param {number} ctxPct - Current context usage percentage
 * @param {boolean} force - If true, perform next pass regardless of threshold
 * @returns {boolean} true if any truncation was performed
 */
export function truncateContextIfNeeded(history, ctxPct, force = false) {
	const threshold = force ? 0 : window.BARE.AUTO_TRUNCATE_THRESHOLD;
	const pruneThreshold = window.BARE.SKELETON_PRUNE_THRESHOLD;

	// Pass 1: initial split
	if (!_state.active) {
		if (!force && ctxPct <= threshold) return false;
		if (history.length <= 10) return false;
		return doInitialSplit(history);
	}

	// Already active: check if we need to shrink or prune
	if (!force && ctxPct <= pruneThreshold) return false;

	// Pass 2–6: shrink head/tail
	if (_state.headEnd > 0 || _state.tailStart < history.length) {
		return shrinkZones(history);
	}

	// Pass 7+: all skeleton — prune middle
	return pruneSkeletonMiddle(history);
}
