import { getSystemPrompt } from './system-prompt.js';

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════

export const IMAGE_MARKER = "__IMAGE__|";

// Cached absolute path to the tool plugin template file.
// Resolved on first call to buildMessages() via IPC to main process.
let _toolTemplatePath = null;

/** Lazily fetch the absolute path to the tool plugin template. */
async function resolveToolTemplatePath() {
	if (_toolTemplatePath) return _toolTemplatePath;
	try {
		_toolTemplatePath = await window.electron.invoke('app:template-path');
	} catch {
		// Fallback: if IPC fails, use a relative path (may not resolve correctly)
		_toolTemplatePath = './tool-plugin-template.js';
	}
	return _toolTemplatePath;
}

// ═══════════════════════════════════════════════════════════
// Vision / Image Helpers
// ═══════════════════════════════════════════════════════════

/** Detect if a tool result is an image marker */
export function isImageResult(content) {
	return typeof content === "string" && content.startsWith(IMAGE_MARKER);
}

/** Parse an image marker into { filename, mimeType, base64 } */
export function parseImageMarker(content) {
	const parts = content.split("|");
	if (parts.length < 4) return null;
	return { filename: parts[1], mimeType: parts[2], base64: parts.slice(3).join("|") };
}

// ═══════════════════════════════════════════════════════════
// Message Building
// ═══════════════════════════════════════════════════════════

/** Dynamic tool list for system prompt generation */
let _currentTools = [];
export function setTools(tools) { _currentTools = tools; }

// ═══════════════════════════════════════════════════════════
// Stream Finalization (llama.cpp parser bug handling)
// ═══════════════════════════════════════════════════════════

/**
 * Detect if the stream output shows signs of a llama.cpp thinking-parser bug.
 * These bugs cause reasoning text to leak into tool call arguments or content.
 */
export function detectParserBug(thinkText, assistantText) {
	const thinkTrim = thinkText.trim();
	return thinkTrim.endsWith('`') || thinkTrim.endsWith('</think>') || assistantText.includes('</think>');
}

/**
 * Parse streamed tool-call entries into completed tool calls.
 *
 * Handles two llama.cpp parser bugs:
 *   1. Reasoning text leaking into tool-call JSON arguments
 *   2. Assistant content leaking inside thinking tags
 *
 * @param {Map} activeToolCalls - Map of index → { id, name, partialArgs }
 * @param {object} state - Mutable state: { assistantText, thinkText, hasThinking }
 * @param {boolean} hasParserBug - Whether a parser bug was detected
 * @returns {{ completedToolCalls: Array, assistantText: string, thinkText: string, hasThinking: boolean }}
 * @throws {Error} if tool-call args can't be parsed
 */
export function finalizeToolCalls(activeToolCalls, state, hasParserBug) {
	let { assistantText, thinkText, hasThinking } = state;
	const completedToolCalls = [];

	// --- 1. Retroactive Sweep-Up: Content Leak (Case 2) ---
	if (assistantText.includes('</think>')) {
		const lastIdx = assistantText.lastIndexOf('</think>');
		const leakedThinking = assistantText.substring(0, lastIdx);
		const realContent = assistantText.substring(lastIdx + 8); // length of '</think>'

		thinkText += '\n' + leakedThinking.trim();
		assistantText = realContent;
		hasThinking = true;
	}

	// --- 2. Parse tool call args & salvage leaked tools (Case 1) ---
	for (const [, entry] of activeToolCalls) {
		let parsedArgs = null;
		let leakedThinking = '';

		try {
			parsedArgs = JSON.parse(entry.partialArgs);
		} catch (err) {
			// Salvage attempt: find valid JSON boundaries inside partial args
			const str = entry.partialArgs;
			const startIdx = str.indexOf('{');
			const endIdx = str.lastIndexOf('}');

			if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
				for (let i = startIdx; i <= endIdx; i++) {
					if (str[i] === '{') {
						try {
							parsedArgs = JSON.parse(str.substring(i, endIdx + 1));
							leakedThinking = str.substring(0, i);
							break;
						} catch (e) { /* try next '{' */ }
					}
				}
			}
		}

		if (parsedArgs) {
			// Retroactively push leaked reasoning back into the think block
			if (leakedThinking.trim()) {
				thinkText += '\n' + leakedThinking.trim();
				hasThinking = true;
			}

			let finalName = entry.name;
			let finalArgs = parsedArgs;

			// Handle nested schema wrapping if llama.cpp mangled the tool name
			if (parsedArgs.name && parsedArgs.arguments) {
				finalName = parsedArgs.name;
				try {
					finalArgs = typeof parsedArgs.arguments === 'string'
						? JSON.parse(parsedArgs.arguments)
						: parsedArgs.arguments;
				} catch (e) { /* keep as-is */ }
			}

			completedToolCalls.push({
				id: entry.id,
				name: finalName,
				args: finalArgs,
			});
		} else {
			if (hasParserBug) {
				throw new Error('llama.cpp thinking parser bug ruined the tool call attempt. Auto-retrying...');
			}
			throw new Error(`Tool arg parse failure for '${entry.name}'. Invalid JSON: ${entry.partialArgs}`);
		}
	}

	return { completedToolCalls, assistantText, thinkText, hasThinking };
}

export async function buildMessages(history) {
	const toolList = _currentTools.map(t => {
		const fn = t.function;
		return `- ${fn.name}: ${fn.description}`;
	}).join('\n');

	let base = await getSystemPrompt();

	if (toolList) {
		base = `${base}\n\n## Available Tools\nYou have the following tools available:\n${toolList}`;
	}

	// Inject the absolute path to the tool plugin template
	if (base.includes('{{TOOL_TEMPLATE_PATH}}')) {
		const templatePath = await resolveToolTemplatePath();
		base = base.replace('{{TOOL_TEMPLATE_PATH}}', templatePath);
	}

	const messages = [{ role: "system", content: base }];

	for (const msg of history) {
		if (msg.role === "tool" && isImageResult(msg.content)) {
			// Convert image marker to multi-modal tool response
			const img = parseImageMarker(msg.content);
			if (!img) {
				messages.push(msg); // fallback: send as-is
				continue;
			}
			messages.push({
				role: "tool",
				tool_call_id: msg.tool_call_id,
				content: [
					{ type: "text", text: `Image: ${img.filename}` },
					{ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } },
				],
			});
		} else if (msg.role === "user" && Array.isArray(msg.images) && msg.images.length > 0) {
			// User message with attached images
			messages.push({
				role: "user",
				content: [
					{ type: "text", text: msg.content },
					...msg.images.map(img => ({
						type: "image_url",
						image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
					})),
				],
			});
		} else {
			messages.push(msg);
		}
	}

	return messages;
}
