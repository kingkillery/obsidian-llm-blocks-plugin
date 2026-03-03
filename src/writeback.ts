import type { WritebackDirective, ParsedLLMBlock } from "./types";

/**
 * Parse the raw source of a ```llm block into directive, prompt, and preset.
 *
 * First line is checked for directives (@keep, @consume) and preset
 * references (@call <id>, @preset <id>). Directives are combinable:
 *   @keep                    → directive=keep, no preset
 *   @consume                 → directive=consume, no preset
 *   @keep @call summarize    → directive=keep, preset=summarize
 *   @call summarize          → directive=keep (default), preset=summarize
 *   (no directive line)      → directive=keep (default)
 */
export function parseLLMBlock(source: string): ParsedLLMBlock {
	const lines = source.split(/\r?\n/);
	const firstLine = (lines[0] ?? "").trim();

	let directive: WritebackDirective = "keep";
	let presetId = "";
	let promptStartLine = 0;

	// Check if the first line contains any directive tokens
	const directivePattern = /^@/;
	if (directivePattern.test(firstLine)) {
		promptStartLine = 1;

		// Parse directive
		if (/\b@consume\b/i.test(firstLine)) {
			directive = "consume";
		}
		// @keep is default, but accept it explicitly too

		// Parse preset reference
		const presetMatch = firstLine.match(/@(?:call|preset)\s+([a-z0-9._-]+)/i);
		if (presetMatch) {
			presetId = presetMatch[1];
		}
	}

	const prompt = lines.slice(promptStartLine).join("\n").trim();
	return { directive, prompt, presetId };
}

/**
 * Build the replacement string for a ```llm block after LLM response.
 *
 * @keep (default):
 *   > [!llm]- <title>
 *   > <prompt lines prefixed with "> ">
 *
 *   <response>
 *   %%/llm%%
 *
 * @consume:
 *   <response>
 */
export function buildReplacement(
	prompt: string,
	response: string,
	directive: WritebackDirective,
): string {
	if (directive === "consume") {
		return response;
	}

	// @keep: build callout + response + end marker
	const title = buildCalloutTitle(prompt);
	const calloutLines = prompt.split(/\r?\n/).map((line) => `> ${line}`);
	const callout = `> [!llm]- ${title}\n${calloutLines.join("\n")}`;
	return `${callout}\n\n${response}\n%%/llm%%`;
}

/**
 * Derive a short callout title from the prompt (first ~60 chars of first line).
 */
function buildCalloutTitle(prompt: string): string {
	const firstLine = prompt.split(/\r?\n/)[0] ?? "";
	const trimmed = firstLine.trim();
	if (trimmed.length <= 60) return trimmed;
	return trimmed.slice(0, 57) + "...";
}

/**
 * Find and replace a ```llm code block in file content with the rendered output.
 *
 * Uses content-based search (not line numbers) to avoid stale position bugs.
 *
 * Returns the modified content, or null if the block cannot be found unambiguously.
 */
export function applyWriteback(
	fileContent: string,
	originalSource: string,
	response: string,
	directive: WritebackDirective,
): string | null {
	const normalized = fileContent.replace(/\r\n/g, "\n");
	const normalizedSource = originalSource.replace(/\r\n/g, "\n");

	// Build the exact fence to search for
	const searchString = "```llm\n" + normalizedSource + "\n```";

	const occurrences = findAllOccurrences(normalized, searchString);

	if (occurrences.length === 0) {
		return null; // Block was edited or removed
	}

	// Pick the first occurrence NOT already followed by %%/llm%%
	let targetIndex = -1;
	for (const idx of occurrences) {
		const afterBlock = normalized.slice(idx + searchString.length).trimStart();
		if (!afterBlock.startsWith("%%/llm%%")) {
			targetIndex = idx;
			break;
		}
	}

	// If all are followed by the marker, use the first one
	if (targetIndex === -1) {
		targetIndex = occurrences[0];
	}

	const parsed = parseLLMBlock(normalizedSource);
	const replacement = buildReplacement(
		parsed.prompt,
		response,
		directive,
	);

	const result =
		normalized.slice(0, targetIndex) +
		replacement +
		normalized.slice(targetIndex + searchString.length);

	// Restore original line endings if file used CRLF
	if (fileContent.includes("\r\n")) {
		return result.replace(/\n/g, "\r\n");
	}
	return result;
}

/**
 * Replace content between a [!llm] callout and its %%/llm%% end marker
 * with a new LLM response. Used for re-running from callouts.
 *
 * The callout block is preserved. Only the response between the callout
 * and the %%/llm%% marker is replaced.
 *
 * Returns modified content, or null if boundary markers can't be found.
 */
export function applyRerunWriteback(
	fileContent: string,
	prompt: string,
	newResponse: string,
): string | null {
	const normalized = fileContent.replace(/\r\n/g, "\n");

	// Find the callout that contains this prompt
	const calloutLines = prompt.split(/\r?\n/).map((line) => `> ${line}`);
	const calloutBody = calloutLines.join("\n");

	// Search for the callout header pattern followed by the prompt body
	const calloutHeaderPattern = "> [!llm]-";
	let searchStart = 0;
	let calloutEnd = -1;

	while (searchStart < normalized.length) {
		const headerIdx = normalized.indexOf(calloutHeaderPattern, searchStart);
		if (headerIdx === -1) break;

		// Find the end of the callout header line
		const headerLineEnd = normalized.indexOf("\n", headerIdx);
		if (headerLineEnd === -1) break;

		// Check if the callout body follows
		const bodyStart = headerLineEnd + 1;
		if (normalized.startsWith(calloutBody, bodyStart)) {
			calloutEnd = bodyStart + calloutBody.length;
			break;
		}

		searchStart = headerLineEnd + 1;
	}

	if (calloutEnd === -1) return null;

	// Find the %%/llm%% end marker after the callout
	const endMarker = "%%/llm%%";
	const endMarkerIdx = normalized.indexOf(endMarker, calloutEnd);
	if (endMarkerIdx === -1) return null;

	// Replace everything between callout end and end marker (inclusive of marker)
	const result =
		normalized.slice(0, calloutEnd) +
		"\n\n" + newResponse + "\n" +
		endMarker +
		normalized.slice(endMarkerIdx + endMarker.length);

	if (fileContent.includes("\r\n")) {
		return result.replace(/\n/g, "\r\n");
	}
	return result;
}

/**
 * Find all occurrences of a substring in a string.
 */
function findAllOccurrences(haystack: string, needle: string): number[] {
	const results: number[] = [];
	let pos = 0;
	while (pos < haystack.length) {
		const idx = haystack.indexOf(needle, pos);
		if (idx === -1) break;
		results.push(idx);
		pos = idx + 1;
	}
	return results;
}
