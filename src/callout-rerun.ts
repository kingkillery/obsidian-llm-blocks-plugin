import { App, MarkdownPostProcessorContext, TFile, setIcon } from "obsidian";
import { CodexWebSocketClient } from "./websocket-client";
import { applyRerunWriteback } from "./writeback";
import { resolveScope } from "./scope";
import type { ScopeDirective } from "./types";
import type { VaultEmbeddings } from "./embeddings";

/**
 * Post-processor that adds re-run / copy buttons to [!llm] callouts
 * and wraps response regions for hover copy.
 *
 * When a ```llm block runs with @keep, it produces:
 *   > [!llm]- Title           (or > [!llm|scope]- Title)
 *   > prompt lines...
 *
 *   response text...
 *   %%/llm%%
 *
 * This post-processor finds rendered callouts with data-callout="llm",
 * extracts the prompt, and adds:
 *   1. Re-run button in the title bar
 *   2. Copy button in the title bar (clipboard icon)
 *   3. Floating copy button on the response region (hover reveal)
 */
export function createCalloutRerunPostProcessor(
	app: App,
	wsClient: CodexWebSocketClient,
	embeddings?: VaultEmbeddings | null,
): (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const callouts = el.querySelectorAll<HTMLElement>('.callout[data-callout="llm"]');
		if (callouts.length === 0) return;

		for (const callout of Array.from(callouts)) {
			processCallout(app, wsClient, callout, ctx, embeddings);
		}
	};
}

function processCallout(
	app: App,
	wsClient: CodexWebSocketClient,
	callout: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	embeddings?: VaultEmbeddings | null,
): void {
	const titleEl = callout.querySelector(".callout-title");
	if (!titleEl) return;

	const prompt = extractPromptFromCallout(callout);
	if (!prompt) return;

	// Read scope from callout metadata (e.g. data-callout-metadata="file")
	const scopeStr = callout.getAttribute("data-callout-metadata") || "";
	const scope: ScopeDirective = isValidScope(scopeStr) ? scopeStr : "prompt";

	// Add Re-run button
	const rerunBtn = document.createElement("button");
	rerunBtn.className = "llm-rerun-btn";
	rerunBtn.textContent = "Re-run";
	rerunBtn.addEventListener("click", async (e) => {
		e.stopPropagation();
		await handleRerun(app, wsClient, callout, ctx, rerunBtn, scope, embeddings);
	});
	titleEl.appendChild(rerunBtn);

	// Add Copy button (clipboard icon)
	const copyBtn = document.createElement("button");
	copyBtn.className = "llm-copy-btn";
	copyBtn.setAttribute("aria-label", "Copy response");
	setIcon(copyBtn, "copy");
	copyBtn.addEventListener("click", async (e) => {
		e.stopPropagation();
		const response = await extractResponseFromFile(app, ctx, prompt);
		if (response) {
			await navigator.clipboard.writeText(response);
			setIcon(copyBtn, "check");
			setTimeout(() => setIcon(copyBtn, "copy"), 1500);
		}
	});
	titleEl.appendChild(copyBtn);

	// Wrap response siblings in a hoverable region with floating copy button
	wrapResponseRegion(app, callout, ctx, prompt);
}

function wrapResponseRegion(
	app: App,
	callout: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	prompt: string,
): void {
	const parent = callout.parentElement;
	if (!parent) return;

	// Collect siblings after the callout within the same container
	const siblings: Node[] = [];
	let current = callout.nextSibling;
	while (current) {
		siblings.push(current);
		current = current.nextSibling;
	}

	if (siblings.length === 0) return;

	// Create response region wrapper
	const wrapper = document.createElement("div");
	wrapper.className = "llm-response-region";

	// Move siblings into wrapper
	for (const sibling of siblings) {
		wrapper.appendChild(sibling);
	}

	// Insert wrapper after callout
	parent.appendChild(wrapper);

	// Add floating copy button
	const floatBtn = document.createElement("button");
	floatBtn.className = "llm-copy-float";
	floatBtn.setAttribute("aria-label", "Copy response");
	setIcon(floatBtn, "copy");
	floatBtn.addEventListener("click", async (e) => {
		e.stopPropagation();
		const response = await extractResponseFromFile(app, ctx, prompt);
		if (response) {
			await navigator.clipboard.writeText(response);
			setIcon(floatBtn, "check");
			setTimeout(() => setIcon(floatBtn, "copy"), 1500);
		}
	});
	wrapper.insertBefore(floatBtn, wrapper.firstChild);
}

async function handleRerun(
	app: App,
	wsClient: CodexWebSocketClient,
	callout: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	btn: HTMLButtonElement,
	scope: ScopeDirective,
	embeddings?: VaultEmbeddings | null,
): Promise<void> {
	const prompt = extractPromptFromCallout(callout);
	if (!prompt) {
		console.error("LLM Blocks: could not extract prompt from callout");
		return;
	}

	btn.disabled = true;
	btn.textContent = "Running...";

	try {
		// Resolve scope before querying
		const augmentedPrompt = await resolveScope(
			app,
			ctx.sourcePath,
			prompt,
			scope,
			embeddings,
		);

		const result = await wsClient.query(augmentedPrompt);
		const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) {
			throw new Error("Source file not found");
		}

		await app.vault.process(file, (content) => {
			const updated = applyRerunWriteback(content, prompt, result.text);
			if (updated === null) {
				throw new Error("Could not find callout boundaries in file");
			}
			return updated;
		});

		// Obsidian re-renders automatically after vault.process
	} catch (e) {
		console.error("LLM Blocks: re-run failed", e);
		btn.textContent = "Error - Retry";
		btn.disabled = false;
	}
}

/**
 * Extract the prompt text from a rendered [!llm] callout.
 *
 * The callout content contains the prompt lines (each was prefixed with "> "
 * in the source, but Obsidian strips those in rendering).
 */
function extractPromptFromCallout(callout: HTMLElement): string | null {
	const contentEl = callout.querySelector(".callout-content");
	if (!contentEl) return null;

	const text = contentEl.textContent?.trim();
	return text || null;
}

/**
 * Read the raw file and extract the response text between a [!llm] callout
 * and its %%/llm%% end marker.
 */
async function extractResponseFromFile(
	app: App,
	ctx: MarkdownPostProcessorContext,
	prompt: string,
): Promise<string | null> {
	const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
	if (!(file instanceof TFile)) return null;

	const content = await app.vault.cachedRead(file);
	const normalized = content.replace(/\r\n/g, "\n");

	const calloutLines = prompt.split(/\r?\n/).map((line) => `> ${line}`);
	const calloutBody = calloutLines.join("\n");

	const calloutPrefix = "> [!llm";
	let searchStart = 0;
	let calloutEnd = -1;

	while (searchStart < normalized.length) {
		const headerIdx = normalized.indexOf(calloutPrefix, searchStart);
		if (headerIdx === -1) break;

		const headerLineEnd = normalized.indexOf("\n", headerIdx);
		if (headerLineEnd === -1) break;

		const headerLine = normalized.slice(headerIdx, headerLineEnd);
		if (!/^> \[!llm(?:\|[a-z]+)?\]-/.test(headerLine)) {
			searchStart = headerLineEnd + 1;
			continue;
		}

		const bodyStart = headerLineEnd + 1;
		if (normalized.startsWith(calloutBody, bodyStart)) {
			calloutEnd = bodyStart + calloutBody.length;
			break;
		}

		searchStart = headerLineEnd + 1;
	}

	if (calloutEnd === -1) return null;

	const endMarker = "%%/llm%%";
	const endMarkerIdx = normalized.indexOf(endMarker, calloutEnd);
	if (endMarkerIdx === -1) return null;

	return normalized.slice(calloutEnd, endMarkerIdx).trim();
}

function isValidScope(s: string): s is ScopeDirective {
	return s === "prompt" || s === "file" || s === "linked" || s === "vault";
}
