/**
 * Parse an OpenAI-compatible SSE stream into structured events.
 *
 * Yields:
 *   { type: 'reasoning', text }
 *   { type: 'content', text }
 *   { type: 'tool_call', index, id, name, arguments }
 *   { type: 'done', finishReason }
 *
 * Throws on server errors or malformed streams.
 *
 * NOTE: llama.cpp sometimes leaks reasoning tags (e.g. <think>, <|channel>thought)
 * into the `content` field instead of the `reasoning_content` field.
 * This parser detects those tags in-stream and splits them correctly.
 */
import { REASONING_TAGS } from './utils.js';

/**
 * Split a content string around reasoning tags, yielding reasoning and content chunks.
 * Maintains state across calls via `state` object so partial tags spanning chunks work.
 *
 * @param {string} text - Incoming content chunk
 * @param {{ inReasoning: boolean }} state - Persistent state
 * @yields {type: 'reasoning'|'content', text: string}
 */
function* splitReasoningFromContent(text, state) {
	// If we're inside a reasoning block, accumulate until we find a close tag
	if (state.inReasoning) {
		// Try each close tag
		for (const tag of REASONING_TAGS) {
			const closeIdx = text.indexOf(tag.close);
			if (closeIdx !== -1) {
				// Everything before the close tag is reasoning
				if (closeIdx > 0) {
					yield { type: 'reasoning', text: text.slice(0, closeIdx) };
				}
				// Everything after the close tag is content
				state.inReasoning = false;
				const remaining = text.slice(closeIdx + tag.close.length);
				if (remaining.length > 0) {
					// Recursively process remaining content (could have another open tag)
					yield* splitReasoningFromContent(remaining, state);
				}
				return;
			}
		}
		// No close tag found — entire chunk is reasoning
		if (text.length > 0) yield { type: 'reasoning', text };
		return;
	}

	// We're in content mode — look for an open reasoning tag
	// Find the earliest open tag across all formats
	let earliestOpen = -1;
	let earliestTag = null;
	for (const tag of REASONING_TAGS) {
		const idx = text.indexOf(tag.open);
		if (idx !== -1 && (earliestOpen === -1 || idx < earliestOpen)) {
			earliestOpen = idx;
			earliestTag = tag;
		}
	}

	if (earliestOpen === -1) {
		// No reasoning tag found — entire chunk is content
		if (text.length > 0) yield { type: 'content', text };
		return;
	}

	// Content before the open tag
	if (earliestOpen > 0) {
		yield { type: 'content', text: text.slice(0, earliestOpen) };
	}

	// Switch to reasoning mode and process the rest
	state.inReasoning = true;
	const afterOpen = text.slice(earliestOpen + earliestTag.open.length);
	// Skip optional newline after open tag
	let contentStart = 0;
	if (afterOpen.startsWith('\n')) contentStart = 1;
	if (afterOpen.length > contentStart) {
		yield* splitReasoningFromContent(afterOpen.slice(contentStart), state);
	}
}

export async function* parseSSE(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finishReason = null;
	// State for client-side reasoning detection (when server leaks tags into content)
	const reasoningState = { inReasoning: false };

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			yield { type: 'done', finishReason };
			break;
		}

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop();

		for (const line of lines) {
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === '[DONE]') continue;

			let parsed;
			try {
				parsed = JSON.parse(payload);
			} catch {
				console.warn('Skipped malformed SSE chunk:', payload);
				continue;
			}

			if (parsed.error) throw new Error(parsed.error.message || parsed.error);

			const choice = parsed.choices?.[0];
			if (!choice) continue;

			if (choice.finish_reason) finishReason = choice.finish_reason;

			const delta = choice.delta;
			if (!delta) continue;

			// ── 1. Server-provided reasoning (reasoning_content / reasoning field) ──
			if (delta.reasoning_content || delta.reasoning) {
				const reasoningText = delta.reasoning_content || delta.reasoning;
				yield { type: 'reasoning', text: reasoningText };
			}

			// ── 2. Content — split out leaked reasoning tags ──
			if (delta.content) {
				// Feed content through the reasoning splitter
				for (const chunk of splitReasoningFromContent(delta.content, reasoningState)) {
					yield chunk;
				}
			}

			// ── 3. Tool calls ──
			if (delta.tool_calls) {
				for (const tc of delta.tool_calls) {
					yield {
						type: 'tool_call',
						index: tc.index,
						id: tc.id || '',
						name: tc.function?.name || '',
						arguments: tc.function?.arguments || '',
					};
				}
			}
		}
	}
}
