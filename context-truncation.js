/**
 * Progressive zone-based context truncation.
 *
 * The history is always structured as:
 *   [HEAD (full)] [SKELETON (stubbed)] [TAIL (full)]
 *
 * Pass 1 (context > threshold, first time):
 *   HEAD     = first 17.5% of messages (group-aligned) — fixed FOREVER
 *   TAIL     = last 25% of messages (group-aligned)
 *   SKELETON = the middle: thinking stripped, tool results stubbed in place
 *
 * Pass 2+ (context > threshold again):
 *   a) HEAD stays untouched (fixed forever)
 *   b) the old TAIL is promoted to SKELETON (thinking stripped, tool
 *      results stubbed) on EVERY pass
 *   c) on every TRUNC_WIPE_EVERY-th pass the whole SKELETON is ALSO
 *      elided: deleted and replaced by a single "--- N messages elided
 *      ---" marker (absorbing any previous marker). Between wipes the
 *      skeleton grows — stubs accumulate, so historic content stays at
 *      stub fidelity a few passes longer instead of vanishing.
 *   d) everything appended since the last pass becomes the new TAIL and
 *      is kept exactly as-is
 *
 * Wipe rhythm: the in-memory skeletonAge counter tracks advance passes
 * since the last wipe (the initial split counts as one). On a session
 * load the counter is reset to 0, so the first truncation after a
 * reload always preserves (grows) rather than wipes. Forced re-passes
 * (overflow retries) always collapse the zone and reset the counter.
 *
 * LIVE-TOOL INVARIANT: messages appended after the last pass (the live
 * turn and its tool results) always land in the new tail and are NEVER
 * stubbed or deleted. Only historic messages — a full context cycle old
 * at the moment they are stubbed — ever become skeleton. A forced
 * re-pass with no new messages (overflow retry) elides the skeleton only
 * and never touches the tail.
 *
 * Zone boundaries are group-aligned (an assistant message + its tool
 * results move as one unit), so eliding the skeleton never leaves a
 * dangling tool_call or an orphan tool result.
 *
 * State survives reloads: the skeleton zone is marked in the history
 * itself (_skeleton flag / separator marker), so resetTruncationState()
 * re-derives it from a loaded session instead of re-splitting — which
 * would break the fixed head.
 *
 * KV-cache friendly: the head prefix is stable across passes, so the
 * server can reuse cached KV for the unchanged prefix.
 */

/* ------------------------------------------------------------------ */
/* State                                                              */
/* ------------------------------------------------------------------ */

let _state = {
	active: false,
	headEnd: 0,     // messages [0, headEnd) are HEAD (full, fixed)
	tailStart: 0,   // messages [tailStart, n) are TAIL (full)
	lastPassN: 0,   // history length at the time of the last pass
	skeletonAge: 0,  // advance passes since the last skeleton wipe
};

/**
 * Reset (or restore) truncation state.
 *
 * Pass the current history to restore zone state from persisted marks
 * after a session load, so the progression continues instead of a
 * fresh pass-1 re-split shrinking the fixed head.
 *
 * @param {Array} [history] - optional message history to restore from
 */
export function resetTruncationState(history) {
	// skeletonAge starts at 0 on (re)load: the first truncation after a
	// reload preserves (grows) the skeleton instead of wiping it.
	_state = {
		active: false,
		headEnd: 0,
		tailStart: 0,
		lastPassN: history ? history.length : 0,
		skeletonAge: 0,
	};

	if (!history || history.length === 0) return;

	// The skeleton zone is a contiguous run of marked messages: the elided
	// separator marker and/or in-place stubbed messages. Head and tail
	// messages are never marked.
	const isMarked = m => m._skeleton === true || m._isContextSeparator === true;
	let zoneStart = history.findIndex(isMarked);
	if (zoneStart === -1) return;

	let zoneEnd = zoneStart;
	while (zoneEnd < history.length && isMarked(history[zoneEnd])) zoneEnd++;

	// Anchor the tail at the last complete group: the turn the model must
	// respond to next survives at least one more pass after a reload.
	const tailGroups = getMessageGroups(history, zoneEnd, history.length);
	const tailStart = tailGroups.length > 0 ? tailGroups[tailGroups.length - 1].start : history.length;

	// lastPassN = tailStart (NOT history.length): the region between the
	// zone and the last group is unmarked full content saved mid-session.
	// Treating it as "new tail" keeps it (and the last turn) intact until
	// the model has had a pass to use them; it converges on later passes.
	//
	// skeletonAge stays 0 after a reload: the passes-since-wipe count is
	// not derivable from history, and 0 means the first truncation after
	// a reload preserves (grows) the skeleton instead of wiping it.
	_state.active = true;
	_state.headEnd = zoneStart;
	_state.tailStart = tailStart;
	_state.lastPassN = tailStart;

	console.log(`[TRUNC] Restored state: Head: [0,${zoneStart}), Skeleton: [${zoneStart},${zoneEnd}), Tail: [${tailStart},${history.length}), age: 0`);
}

/* ------------------------------------------------------------------ */
/* Core helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Stub a message in-place for the skeleton zone.
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
 * A group is: a user message, or an assistant message + its tool results
 * (as one unit, so boundaries never split call/result pairs).
 * Returns array of { start, end } (end is exclusive).
 */
function getMessageGroups(history, start, end) {
	const groups = [];
	let i = start;
	while (i < end) {
		const msg = history[i];
		if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
			const toolIds = new Set(msg.tool_calls.map(tc => tc.id));
			let groupEnd = i + 1;
			while (groupEnd < end && history[groupEnd].role === 'tool' && toolIds.has(history[groupEnd].tool_call_id)) {
				groupEnd++;
			}
			groups.push({ start: i, end: groupEnd });
			i = groupEnd;
		} else {
			groups.push({ start: i, end: i + 1 });
			i++;
		}
	}
	return groups;
}

/**
 * Elide the marked skeleton zone: delete the contiguous run of marked
 * messages at [headEnd, ...) and insert a single marker in their place.
 * If the zone already begins with a marker (from an earlier wipe — or
 * one holding only stubs after a skipped wipe), its elided count is
 * absorbed so the history always holds exactly one marker.
 * This IS the wipe step, so it resets the skeletonAge counter.
 *
 * Only the marked run is removed (clamped to tailStart). After a reload
 * (resetTruncationState) the tail anchor can lie beyond the marked zone;
 * the unmarked full messages in between (saved mid-session) survive and
 * join the new tail, converging on later passes. In normal operation the
 * run always extends to tailStart, so behaviour is unchanged.
 *
 * After the call, the zone is [headEnd, headEnd+1) and the old tail
 * starts at headEnd+1.
 */
function elideZone(history) {
	let priorElided = 0;
	let hadMarker = false;
	if (_state.headEnd < _state.tailStart && history[_state.headEnd]._isContextSeparator) {
		priorElided = history[_state.headEnd]._elidedCount || 0;
		hadMarker = true;
	}
	let zoneEnd = _state.headEnd;
	while (zoneEnd < _state.tailStart &&
		(history[zoneEnd]._skeleton === true || history[zoneEnd]._isContextSeparator === true)) zoneEnd++;
	const removed = zoneEnd - _state.headEnd;
	// The prior marker itself is not an elided message — don't count it.
	const total = priorElided + removed - (hadMarker ? 1 : 0);

	history.splice(_state.headEnd, removed, {
		role: 'user',
		content: `--- ${total} messages elided ---`,
		_isContextSeparator: true,
		_skeleton: true,
		_elidedCount: total,
	});

	_state.tailStart = _state.headEnd + 1;
	_state.skeletonAge = 0;
}

/* ------------------------------------------------------------------ */
/* Pass 1: Initial split                                              */
/* ------------------------------------------------------------------ */

function doInitialSplit(history) {
	const n = history.length;
	const groups = getMessageGroups(history, 0, n);

	// HEAD: first TRUNC_HEAD_PCT of messages, snapped to a full group
	// boundary so the head never ends mid call/result pair.
	const headRaw = Math.floor(n * window.BARE.TRUNC_HEAD_PCT);
	let headEnd = 0;
	for (const g of groups) {
		if (g.end <= headRaw) headEnd = g.end;
		else break;
	}

	// TAIL: last TRUNC_TAIL_PCT of messages, snapped back to a full group
	// boundary so the tail never starts mid call/result pair.
	const tailRaw = n - Math.floor(n * window.BARE.TRUNC_TAIL_PCT);
	let tailStart = n;
	for (const g of groups) {
		if (g.start >= tailRaw) {
			tailStart = g.start;
			break;
		}
	}

	// Need a non-empty head and a non-empty skeleton to split.
	if (headEnd === 0 || tailStart <= headEnd) return false;

	// SKELETON: stub the middle in place (thinking stripped, tool results
	// replaced with stubs). Messages stay in the array — pairing intact.
	for (let i = headEnd; i < tailStart; i++) {
		summarizeInPlace(history[i]);
	}

	_state.active = true;
	_state.headEnd = headEnd;
	_state.tailStart = tailStart;
	_state.lastPassN = n;
	// The freshly stubbed skeleton counts as one pass since wipe, so the
	// second truncation overall is the first one that may wipe.
	_state.skeletonAge = 1;

	console.log(
		`[TRUNC] Pass 1: split at n=${n}. Head: [0,${headEnd}), Skeleton: [${headEnd},${tailStart}), Tail: [${tailStart},${n}), age: 1`
	);
	return true;
}

/* ------------------------------------------------------------------ */
/* Pass 2+: Advance zones                                             */
/* ------------------------------------------------------------------ */

/**
 * Normal pass: new messages have arrived since the last pass.
 *   b) old tail     -> promoted to skeleton (stubbed in place) — always
 *   c) skeleton     -> elided to the single marker, but only on every
 *      TRUNC_WIPE_EVERY-th pass; otherwise it grows (stubs accumulate)
 *   d) new messages -> new tail, kept exactly as-is (live-turn safe)
 */
function advanceZones(history) {
	const wipeEvery = window.BARE.TRUNC_WIPE_EVERY;
	const wipe = _state.skeletonAge + 1 >= wipeEvery;
	_state.skeletonAge++;

	if (wipe) {
		// Wipe pass: collapse the whole skeleton (marker + stubs) into the
		// single elide marker, then promote the old tail behind it.
		// Old tail = [tailStart, lastPassN); everything from lastPassN
		// onward (appended since) is the new tail and stays untouched.
		const oldTailLen = _state.lastPassN - _state.tailStart;

		elideZone(history); // also resets _state.skeletonAge

		const stubStart = _state.headEnd + 1;
		const stubEnd = stubStart + oldTailLen;
		for (let i = stubStart; i < stubEnd; i++) {
			summarizeInPlace(history[i]);
		}

		_state.tailStart = stubEnd;
	} else {
		// Grow pass: leave the existing skeleton (marker + earlier stubs)
		// untouched; just stub the old tail onto it.
		const oldTailStart = _state.tailStart;
		for (let i = oldTailStart; i < _state.lastPassN; i++) {
			summarizeInPlace(history[i]);
		}

		_state.tailStart = _state.lastPassN;
	}

	_state.lastPassN = history.length;

	console.log(
		`[TRUNC] ${wipe ? 'Wipe' : 'Grow'} (age ${_state.skeletonAge}/${wipeEvery}): Head: [0,${_state.headEnd}), Skeleton: [${_state.headEnd},${_state.tailStart}), Tail: [${_state.tailStart},${history.length})`
	);
	return true;
}

/**
 * Forced re-pass with no new messages (e.g. the server rejected the
 * request again after an earlier pass). Free space WITHOUT touching the
 * tail — the tail holds the live turn and its tool results.
 */
function forcedRepass(history) {
	const n = history.length;
	const zoneLen = _state.tailStart - _state.headEnd;

	// The zone holds more than the bare marker (stubbed messages) —
	// collapse it into the single marker.
	if (zoneLen > 1) {
		elideZone(history);
		_state.lastPassN = history.length;
		console.log(`[TRUNC] Forced re-pass: elided skeleton -> marker. Tail untouched: [${_state.tailStart},${history.length})`);
		return true;
	}

	// The zone is the bare marker. Last resort: stub the tail itself,
	// but keep the final group (the live turn the model must still
	// respond to) intact so live tool results survive even here.
	const tailGroups = getMessageGroups(history, _state.tailStart, n);
	const liveStart = tailGroups.length > 0 ? tailGroups[tailGroups.length - 1].start : n;
	if (liveStart <= _state.tailStart) return false; // tail IS the live turn — nothing to free

	for (let i = _state.tailStart; i < liveStart; i++) {
		summarizeInPlace(history[i]);
	}

	_state.tailStart = liveStart;
	_state.lastPassN = history.length;
	console.log(`[TRUNC] Forced re-pass (last resort): stubbed tail up to live turn. Tail: [${_state.tailStart},${history.length})`);
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
 * @param {boolean} force - If true, perform a pass regardless of threshold
 * @returns {boolean} true if any truncation was performed
 */
export function truncateContextIfNeeded(history, ctxPct, force = false) {
	const threshold = window.BARE.AUTO_TRUNCATE_THRESHOLD;

	if (!force && ctxPct <= threshold) return false;

	// Pass 1: initial split (only possible before any truncation).
	if (!_state.active) {
		if (history.length <= 10) return false;
		return doInitialSplit(history);
	}

	// Active: a new pass is a zone advance. If no new messages arrived
	// since the last pass, this is a forced re-pass — elide the skeleton
	// only, never the live tail.
	if (history.length > _state.lastPassN) {
		return advanceZones(history);
	}
	return forcedRepass(history);
}
