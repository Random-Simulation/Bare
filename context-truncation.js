/**
 * Prefix-slice context truncation with KV cache awareness.
 *
 * When context usage exceeds a threshold, this function drops the middle
 * 50% of the message history while preserving:
 *   - Head (first 20%): KV cache anchor — reused for free by llama.cpp
 *   - Tail (last 30%): Recent context — re-encoded once, then cached
 *
 * Cut boundaries are aligned to clean message edges so assistant→tool
 * chains are never orphaned across a slice point.
 */

/**
 * Align a cut index to a clean message boundary.
 * Walks backward from `idx` to avoid orphaning a tool response from its
 * assistant caller, or an assistant's tool_calls from a tool result.
 *
 * @param {Array} history - The full message history
 * @param {number} idx - Raw cut index (exclusive — messages before this are kept)
 * @returns {number} Adjusted cut index aligned to a complete message group
 */
function alignBoundary(history, idx) {
	let i = idx;

	// Walk back: if we land inside a tool→assistant chain, include the whole group
	while (i > 0) {
		const msg = history[i - 1];
		if (msg.role === 'tool') {
			// This tool response belongs to an assistant above it — include it
			i--;
		} else if (msg.role === 'assistant' && msg.tool_calls) {
			// This assistant made tool calls — its results are below it.
			// If we're cutting here, either include the whole chain or stop.
			// Since we're walking backward and the tools are AFTER this assistant,
			// the tools are on the other side of the cut. Drop the assistant too
			// so its tool results aren't orphaned.
			i--;
			break;
		} else {
			break;
		}
	}

	return i;
}

/**
 * Truncate the middle of the history array in-place when context is near capacity.
 *
 * @param {Array} history - The message history array (mutated in-place)
 * @param {number} ctxPct - Current context usage percentage
 * @param {boolean} force - If true, truncate regardless of ctxPct (e.g. after server error)
 * @returns {boolean} true if truncation was performed
 */
export function truncateContextIfNeeded(history, ctxPct, force = false) {
	if (!force && ctxPct <= 85) return false;
	if (history.length <= 10) return false;

	const n = history.length;

	// Head: first 17.5% — KV cache anchor (free to reuse)
	// Tail: last 25% — recent context (re-encoded once)
	// Middle 57.5% — dropped
	const headSize = Math.floor(n * 0.175);
	const tailSize = Math.floor(n * 0.25);
	const tailStart = n - tailSize;

	if (tailStart <= headSize) return false; // Not enough to meaningfully truncate

	// Align cut points to clean message boundaries
	const headEnd = alignBoundary(history, headSize);
	const tailBegin = alignBoundary(history, tailStart);

	if (tailBegin <= headEnd) return false; // Boundaries collapsed

	const dropped = tailBegin - headEnd;

	console.log(`Context at ${ctxPct.toFixed(1)}%. Slicing middle ${dropped} messages (${headEnd}–${tailBegin - 1}) of ${n}. Head: ${headEnd}, Tail: ${tailBegin}.`);

	const separator = {
		role: 'user',
		content: `--- context boundary (${dropped} messages elided) ---`,
		_isContextSeparator: true,
	};

	// Rebuild: head + separator + tail
	const head = history.slice(0, headEnd);
	const tail = history.slice(tailBegin);
	history.length = 0;
	history.push(...head, separator, ...tail);

	console.log(`History compacted to ${history.length} messages (${dropped} dropped).`);
	return true;
}
