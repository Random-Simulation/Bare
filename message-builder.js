import { getSystemPrompt } from './system-prompt.js';
import { normalizeGemmaTokens, REASONING_TAGS } from './utils.js';

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
// Stream Finalization
// ═══════════════════════════════════════════════════════════

/**
 * Detect whether the streamed response likely has a parser bug
 * (e.g., leaked reasoning into tool-call args, or malformed JSON).
 * Checks for unclosed reasoning tags of any known format.
 * @param {string} thinkText
 * @param {string} assistantText
 * @returns {boolean}
 */
export function detectParserBug(thinkText, assistantText) {
	if (!assistantText) return false;

	for (const { open, close } of REASONING_TAGS) {
		if (assistantText.includes(open) && !assistantText.includes(close)) {
			return true; // Unclosed reasoning tag leaked into content
		}
	}
	return false;
}

/**
 * Parse streamed tool-call entries into completed tool calls.
 *
 * Handles two llama.cpp parser bugs:
 *   1. Gemma 4 `<|"|>` quote tokens breaking JSON parsing
 *   2. Nested schema wrapping from llama.cpp
 *
 * Also performs retroactive sweep-up of Qwen reasoning tags
 * that leaked into assistantText as a fallback (the SSE parser
 * should have caught these, but this is a safety net).
 *
 * @param {Map} activeToolCalls - Map of index → { id, name, partialArgs }
 * @param {string} assistantText - Current assistant text (mutated on sweep)
 * @returns {{ completedToolCalls: Array, assistantText: string }}
 * @throws {Error} if tool-call args can't be parsed
 */
export function finalizeToolCalls(activeToolCalls, assistantText) {
	const completedToolCalls = [];

	// --- 1. Retroactive Sweep-Up: Qwen content leak (fallback) ---
	// The SSE parser should have already split these, but if the server
	// sends  in a way that bypasses the parser, catch it here.
	if (assistantText.includes('\u003c' + '/think' + '\u003e')) {
		const lastIdx = assistantText.lastIndexOf('\u003c' + '/think' + '\u003e');
		const leakedThinking = assistantText.substring(0, lastIdx);
		const realContent = assistantText.substring(lastIdx + 8);
		// Push leaked thinking back into the think block (via return)
		// For now, just strip it from assistantText — the agentic loop
		// already captured thinkText from the reasoning events.
		assistantText = realContent;
	}

	// --- 2. Parse tool call args & handle Gemma normalization ---
	for (const [, entry] of activeToolCalls) {
		let parsedArgs = null;
		let leakedThinking = '';

		// Normalize Gemma 4 <|"|> tokens before JSON parsing
		const normalizedArgs = normalizeGemmaTokens(entry.partialArgs);

		try {
			parsedArgs = JSON.parse(normalizedArgs);
		} catch (err) {
			// Salvage attempt: find valid JSON boundaries inside partial args
			const str = normalizedArgs;
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
			const hasBug = detectParserBug('', assistantText);
			if (hasBug) {
				throw new Error('llama.cpp thinking parser bug ruined the tool call attempt. Auto-retrying...');
			}
			throw new Error(`Tool arg parse failure for '${entry.name}'. Invalid JSON: ${entry.partialArgs}`);
		}
	}

	return { completedToolCalls, assistantText };
}

// ═══════════════════════════════════════════════════════════
// Reasoning Extraction (for message building)
// ═══════════════════════════════════════════════════════════

/**
 * Universal reasoning extraction from content strings.
 * Handles all known reasoning tag formats:
 *   - DeepSeek/standard:  ... 
 *   - Gemma 4: <|channel>thought\n ... <channel|>
 *   - Gemma 4 alternate: <|think|> ... <|/think|>
 *
 * Multiple reasoning blocks can appear in a single string.
 * Returns { reasoning, content } with all reasoning blocks extracted.
 */
function extractReasoningFromContent(content) {
	let reasoningParts = [];
	let contentParts = [];
	let remaining = content;

	// Keep extracting until no more tags are found
	let foundAny = true;
	while (foundAny) {
		foundAny = false;

		// Find the earliest open tag across all formats
		let earliestOpen = -1;
		let earliestTag = null;
		for (const tag of REASONING_TAGS) {
			const idx = remaining.indexOf(tag.open);
			if (idx !== -1 && (earliestOpen === -1 || idx < earliestOpen)) {
				earliestOpen = idx;
				earliestTag = tag;
			}
		}

		if (earliestOpen === -1) break; // No more tags

		foundAny = true;

		// Save content BEFORE this reasoning block
		if (earliestOpen > 0) {
			contentParts.push(remaining.substring(0, earliestOpen));
		}

		// Skip the open tag (and optional newline after it)
		let afterOpen = earliestOpen + earliestTag.open.length;
		if (remaining[afterOpen] === '\n') afterOpen++;

		const closeIdx = remaining.indexOf(earliestTag.close, afterOpen);
		if (closeIdx === -1) {
			// Unclosed tag — treat everything after open tag as reasoning
			reasoningParts.push(remaining.substring(afterOpen).trim());
			remaining = '';
			break;
		}

		reasoningParts.push(remaining.substring(afterOpen, closeIdx).trim());
		remaining = remaining.substring(closeIdx + earliestTag.close.length);
	}

	// Save any remaining content after the last reasoning block
	if (remaining.length > 0) contentParts.push(remaining);

	if (reasoningParts.length === 0) return { reasoning: null, content };

	return {
		reasoning: reasoningParts.join('\n\n'),
		content: contentParts.join('').trim(),
	};
}

// ═══════════════════════════════════════════════════════════
// buildMessages
// ═══════════════════════════════════════════════════════════

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
		if (msg.role === "assistant") {
			// Handle reasoning — separate field (new) or embedded tags in content
			let reasoning = msg.reasoning;
			let content = msg.content;

			// Universal: extract any reasoning tags from content (Gemma 4, DeepSeek, etc.)
			// Also strips tags from content when reasoning is already provided separately,
			// to avoid sending duplicate reasoning to the server.
			if (typeof content === 'string') {
				const { reasoning: extractedReasoning, content: extractedContent } =
					extractReasoningFromContent(content);
				if (extractedReasoning) {
					// Prefer the explicit reasoning field if present; otherwise use extracted
					if (!reasoning) reasoning = extractedReasoning;
					// Always strip tags from content to avoid duplication
					content = extractedContent;
				}
			}

			const out = {
				role: "assistant",
				content: content || '',
			};
			// Send as 'reasoning_content' — this is the field name llama.cpp's
			// preserve_thinking Jinja template expects for reasoning preservation.
			if (reasoning) out.reasoning_content = reasoning;
			if (msg.tool_calls) out.tool_calls = msg.tool_calls;
			messages.push(out);

		} else if (msg.role === "tool" && isImageResult(msg.content)) {
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
