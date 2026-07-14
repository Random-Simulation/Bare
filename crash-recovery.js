import { escHtml } from './utils.js';
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
export async function handleCrashRecovery(err, maxRetries, activeToolCalls, assistantText, thinkText, think, currentRetry, history, chat, scrollToBottom) {
	const attempt = currentRetry;

	// Salvage partial tool calls from the interrupted stream
	const partialToolCalls = [];
	for (const [, entry] of activeToolCalls) {
		if (!entry.id || !entry.name) continue;
		let args;
		try { args = JSON.parse(entry.partialArgs); } catch { continue; }
		partialToolCalls.push({
			id: entry.id,
			type: 'function',
			function: { name: entry.name, arguments: JSON.stringify(args) },
		});
	}

	// Build partial assistant message with thinking if present
	const finalContent = thinkText.trim()
		? ` \n${assistantText || ''}`
		: assistantText || '';

	if (finalContent || partialToolCalls.length > 0) {
		history.push({
			role: 'assistant',
			content: finalContent,
			tool_calls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
		});
	}

	// Clean up thinking block
	if (think && think.details) think.details.remove();

	// Show warning to user
	const warningText = `[Error: ${err.message}. Auto-retrying ${attempt}/${maxRetries}...]`;
	logSystemMessage(warningText);
	const warningDiv = document.createElement('div');
	warningDiv.className = 'chat-item msg ai markdown-content';
	warningDiv.innerHTML = `<span style="color: #9a9a9a; font-size: 0.9em;"><em>${escHtml(warningText)}</em></span>`;
	chat.appendChild(warningDiv);
	scrollToBottom();

	// Generic recovery prompt with last user message for context
	const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content;
	const recoveryPrompt = lastUserMsg
		? `You were responding to: "${lastUserMsg.slice(0, 200)}"\nPlease continue.`
		: 'Please continue.';
	logUserMessage(recoveryPrompt);
	history.push({ role: 'user', content: recoveryPrompt });

	// Exponential backoff
	const backoffMs = Math.min(2000 * Math.pow(2, currentRetry), 30000);
	await new Promise(resolve => setTimeout(resolve, backoffMs));
}
