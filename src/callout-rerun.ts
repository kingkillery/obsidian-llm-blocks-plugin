import { App, MarkdownPostProcessorContext, TFile } from "obsidian";
import { CodexWebSocketClient } from "./websocket-client";
import { applyRerunWriteback } from "./writeback";

/**
 * Post-processor that adds a re-run button to [!llm] callouts.
 *
 * When a ```llm block runs with @keep, it produces:
 *   > [!llm]- Title
 *   > prompt lines...
 *
 *   response text...
 *   %%/llm%%
 *
 * This post-processor finds rendered callouts with data-callout="llm",
 * extracts the prompt from the source file, and adds a re-run button
 * that re-queries the LLM and replaces the response in-place.
 */
export function createCalloutRerunPostProcessor(
	app: App,
	wsClient: CodexWebSocketClient,
): (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const callouts = el.querySelectorAll<HTMLElement>('.callout[data-callout="llm"]');
		if (callouts.length === 0) return;

		for (const callout of Array.from(callouts)) {
			addRerunButton(app, wsClient, callout, ctx);
		}
	};
}

function addRerunButton(
	app: App,
	wsClient: CodexWebSocketClient,
	callout: HTMLElement,
	ctx: MarkdownPostProcessorContext,
): void {
	const titleEl = callout.querySelector(".callout-title");
	if (!titleEl) return;

	const btn = document.createElement("button");
	btn.className = "llm-rerun-btn";
	btn.textContent = "Re-run";
	btn.addEventListener("click", async (e) => {
		e.stopPropagation();
		await handleRerun(app, wsClient, callout, ctx, btn);
	});

	titleEl.appendChild(btn);
}

async function handleRerun(
	app: App,
	wsClient: CodexWebSocketClient,
	callout: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	btn: HTMLButtonElement,
): Promise<void> {
	// Extract prompt from the callout's rendered content
	const prompt = extractPromptFromCallout(callout);
	if (!prompt) {
		console.error("LLM Blocks: could not extract prompt from callout");
		return;
	}

	btn.disabled = true;
	btn.textContent = "Running...";

	try {
		const result = await wsClient.query(prompt);
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

	// Get the text content — Obsidian renders the "> prompt" lines as
	// paragraph elements inside .callout-content
	const text = contentEl.textContent?.trim();
	return text || null;
}
