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
 */
export async function* parseSSE(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let finishReason = null;

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

			if (delta.reasoning_content || delta.reasoning) {
				yield { type: 'reasoning', text: delta.reasoning_content || delta.reasoning };
			}

			if (delta.content) {
				yield { type: 'content', text: delta.content };
			}

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
