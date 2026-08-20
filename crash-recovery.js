import { escHtml, normalizeGemmaTokens } from './utils.js';
import { logSystemMessage, logUserMessage } from './verbose-mode.js';

/**
 * Handle a crash in the agentic loop by salvaging partial state,
 * showing a warning to the user, and building a recovery prompt.
 *
 * @param {Error} err - The error that caused the crash
 * @param {number} maxRetries - Maximum retry attempts
 * @param {Map} activeToolCalls - In-progress tool calls from the interrupted stream
 * @param {string} assistantText - Partial assistant text accumulated so far
 * @param {string} thinkText - Partial thinking/reasoning text
 * @param {Object} think - The thinking block DOM object
 * @param {number} currentRetry - Current retry attempt number
 * @param {Array} history - The message history array (mutated)
 * @param {HTMLElement} chat - The chat container element
 * @param {Function} scrollToBottom - Callback to scroll chat to bottom
 */
/**
 * Salvage partial assistant state from an interrupted stream into history.
 *
 * Pushes a single assistant message carrying whatever was streamed so far
 * (text and/or reasoning, plus — optionally — fully-parsed tool calls).
 *
 * @param {Object} opts
 * @param {Map} opts.activeToolCalls - In-progress tool calls from the interrupted stream
 * @param {string} opts.assistantText - Partial assistant text accumulated so far
 * @param {string} opts.thinkText - Partial thinking/reasoning text
 * @param {Array} opts.history - The message history array (mutated)
 * @param {boolean} opts.includeToolCalls - When true, tool calls whose args
 *   fully parse are attached to the message. Only safe when a matching tool
 *   result follows (crash-retry path). The user-stop path must pass false,
 *   since unexecuted tool_calls would break the request protocol.
 * @returns {boolean} true if a message was pushed to history
 */
export function salvagePartialAssistant({ activeToolCalls, assistantText, thinkText, history, includeToolCalls = false }) {
	const partialToolCalls = [];
	if (includeToolCalls) {
		// Salvage partial tool calls from the interrupted stream
		for (const [, entry] of activeToolCalls) {
			if (!entry.id || !entry.name) continue;
			let args;
			// Normalize Gemma 4 <|"|> tokens before JSON parsing
			try { args = JSON.parse(normalizeGemmaTokens(entry.partialArgs)); } catch { continue; }
			partialToolCalls.push({
				id: entry.id,
				type: 'function',
				function: { name: entry.name, arguments: JSON.stringify(args) },
			});
		}
	}

	const content = (assistantText || '').trim();
	const reasoning = (thinkText || '').trim();

	if (content || reasoning || partialToolCalls.length > 0) {
		history.push({
			role: 'assistant',
			content,
			reasoning: reasoning || undefined,
			tool_calls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
		});
		return true;
	}
	return false;
}

export async function handleCrashRecovery(err, maxRetries, activeToolCalls, assistantText, thinkText, think, currentRetry, history, chat, scrollToBottom) {
	const attempt = currentRetry;

	// Salvage partial text/reasoning/tool calls into history
	salvagePartialAssistant({ activeToolCalls, assistantText, thinkText, history, includeToolCalls: true });

	// Clean up thinking block
	if (think && think.details) think.details.remove();

	// Show warning to user (commented out — silent retries for cleaner UX)
	// const warningText = `[Error: ${err.message}. Auto-retrying ${attempt}/${maxRetries}...]`;
	// logSystemMessage(warningText);
	// const warningDiv = document.createElement('div');
	// warningDiv.className = 'chat-item msg ai markdown-content';
	// warningDiv.innerHTML = `<span style="color: #9a9a9a; font-size: 0.9em;"><em>${escHtml(warningText)}</em></span>`;
	// chat.appendChild(warningDiv);
	// scrollToBottom();

	// Generic recovery prompt with last user message for context
	const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content;
	const recoveryPrompt = lastUserMsg
		? `You were responding to: "${lastUserMsg.slice(0, 200)}"\nAn unexpected error terminated your output early. This message is invisible to the user - do not mention it. Please continue now.`
		: 'An unexpected error terminated your output early. This message is invisible to the user - do not mention it. Please continue now.';
	logUserMessage(recoveryPrompt);
	history.push({ role: 'user', content: recoveryPrompt });

	// Exponential backoff
	const backoffMs = Math.min(2000 * Math.pow(2, currentRetry), 30000);
	await new Promise(resolve => setTimeout(resolve, backoffMs));
}
