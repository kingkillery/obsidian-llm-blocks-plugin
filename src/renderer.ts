import { App, MarkdownRenderChild, MarkdownPostProcessorContext, MarkdownRenderer, TFile } from "obsidian";
import { CodexWebSocketClient } from "./websocket-client";
import { parseLLMBlock, applyWriteback } from "./writeback";
import { resolveScope } from "./scope";
import type { PromptPreset, WritebackDirective, ScopeDirective, LLMProvider } from "./types";
import { BUILT_IN_PROVIDERS } from "./types";
import type { VaultEmbeddings } from "./embeddings";

interface LLMBlockRendererOptions {
	initialPresetId?: string;
	promptPresets?: PromptPreset[];
	embeddings?: VaultEmbeddings | null;
	activeProviderId?: string;
}

export class LLMBlockRenderer extends MarkdownRenderChild {
	private app: App;
	private client: CodexWebSocketClient;
	private sourcePath: string;
	private rawSource: string;
	private promptBody: string;
	private directive: WritebackDirective;
	private scope: ScopeDirective;
	private embeddings: VaultEmbeddings | null;
	private promptPresets: PromptPreset[];
	private selectedPresetId = "";
	private unresolvedPresetId = "";
	private selectedProviderId = "";
	private additionalPrompts: string[] = [];
	private lastResult: string | null = null;
	private running = false;
	private static readonly runSetMarkerPrefix = "llm-execute-code:scope";

	constructor(
		app: App,
		containerEl: HTMLElement,
		sourcePrompt: string,
		client: CodexWebSocketClient,
		sourcePath: string,
		ctx: MarkdownPostProcessorContext,
		options: LLMBlockRendererOptions = {},
	) {
		super(containerEl);
		this.app = app;
		this.client = client;
		this.sourcePath = sourcePath;
		this.rawSource = sourcePrompt;
		this.promptPresets = this.sanitizePromptPresets(options.promptPresets ?? []);
		this.embeddings = options.embeddings ?? null;

		this.selectedProviderId = options.activeProviderId || BUILT_IN_PROVIDERS[0]?.id || "";

		const parsed = parseLLMBlock(sourcePrompt);
		this.directive = parsed.directive;
		this.promptBody = parsed.prompt;
		this.scope = parsed.scope;

		const explicitPresetId = options.initialPresetId ?? "";
		const presetId = explicitPresetId.trim() || parsed.presetId;
		this.selectedPresetId = this.resolvePresetId(presetId);
		if (presetId && !this.selectedPresetId) {
			this.unresolvedPresetId = presetId;
		}
	}

	async onload(): Promise<void> {
		this.render();
	}

	private render(): void {
		const el = this.containerEl;
		el.empty();
		el.addClass("llm-block");

		// ── Header ──────────────────────────────────────────────────────────
		const header = el.createDiv({ cls: "llm-block-header" });
		const titleGroup = header.createDiv({ cls: "llm-block-title-group" });
		titleGroup.createSpan({ cls: "llm-block-label", text: "LLM" });

		const activePreset = this.getActivePreset();
		if (activePreset) {
			titleGroup.createSpan({
				cls: "llm-block-preset-pill",
				text: activePreset.label?.trim() || activePreset.id,
			});
		}

		const controls = header.createDiv({ cls: "llm-block-controls" });

		if (this.promptPresets.length > 0) {
			const presetSelect = controls.createEl("select", { cls: "llm-block-preset-select" });
			presetSelect.createEl("option", { text: "No preset", value: "" });
			for (const preset of this.promptPresets) {
				presetSelect.createEl("option", {
					text: preset.label?.trim() || preset.id,
					value: preset.id,
				});
			}
			presetSelect.value = this.selectedPresetId;
			presetSelect.addEventListener("change", () => {
				this.selectedPresetId = this.resolvePresetId(presetSelect.value);
				this.unresolvedPresetId = "";
				this.render();
			});
		}

		// Provider dropdown
		const providerSelect = controls.createEl("select", { cls: "llm-block-provider-select" });
		for (const p of BUILT_IN_PROVIDERS) {
			providerSelect.createEl("option", { text: p.displayName, value: p.id });
		}
		providerSelect.value = this.selectedProviderId;
		providerSelect.addEventListener("change", () => {
			this.selectedProviderId = providerSelect.value;
		});

		const primaryPrompt = this.buildPrimaryPrompt();
		const hasAnyPrompt = !!primaryPrompt || this.additionalPrompts.some(p => p.trim());

		const btn = controls.createEl("button", { cls: "llm-block-run-btn", text: "Run" });
		btn.addClass("mod-cta");
		btn.disabled = !hasAnyPrompt;
		btn.addEventListener("click", () => { void this.executeQuery(); });

		// ── Unresolved preset warning ────────────────────────────────────────
		if (this.unresolvedPresetId && !activePreset) {
			const warn = el.createDiv({ cls: "llm-block-warning" });
			warn.createSpan({ text: `Preset '${this.unresolvedPresetId}' was not found. Running raw prompt.` });
		}

		// ── Init hints (shown when block is empty) ───────────────────────────
		if (!primaryPrompt && !this.lastResult) {
			const hints = el.createDiv({ cls: "llm-block-hints" });
			hints.createSpan({ cls: "llm-block-hints-icon", text: "ℹ" });
			const hintText = hints.createDiv({ cls: "llm-block-hints-body" });
			hintText.createEl("p", { text: "Write a prompt inside the code block, then click Run." });
			const ul = hintText.createEl("ul");
			ul.createEl("li", { text: "@keep (default) — wraps output in a collapsible callout below" });
			ul.createEl("li", { text: "@consume — replaces this block with the raw response" });
			ul.createEl("li", { text: "@file — appends current file contents as context" });
			ul.createEl("li", { text: "@linked — appends all linked notes as context" });
			ul.createEl("li", { text: "@vault — searches vault for relevant notes" });
			ul.createEl("li", { text: "Use + Add a prompt to chain multiple prompt segments" });
		}

		// ── Prompt display ───────────────────────────────────────────────────
		const promptEl = el.createDiv({ cls: "llm-block-prompt" });
		promptEl.createEl("pre", {
			text: primaryPrompt || "(No prompt — type text in the code block above.)",
		});

		// ── Additional prompts ───────────────────────────────────────────────
		const additionalPromptsEl = el.createDiv({ cls: "llm-block-additional-prompts" });
		this.additionalPrompts.forEach((text, index) => {
			const row = additionalPromptsEl.createDiv({ cls: "llm-block-additional-prompt" });
			const textarea = row.createEl("textarea");
			textarea.value = text;
			textarea.placeholder = "Additional prompt segment…";
			textarea.addEventListener("input", () => {
				this.additionalPrompts[index] = textarea.value;
			});
			const removeBtn = row.createEl("button", { cls: "llm-remove-btn", text: "×" });
			removeBtn.addEventListener("click", () => {
				this.additionalPrompts.splice(index, 1);
				this.render();
			});
		});

		const addBtn = el.createEl("button", { cls: "llm-block-add-prompt-btn", text: "+ Add a prompt" });
		addBtn.addEventListener("click", () => {
			this.additionalPrompts.push("");
			this.render();
		});

		// ── Output preview (shown after a successful query) ──────────────────
		if (this.lastResult !== null) {
			this.renderOutputPreview(el, this.lastResult);
		}
	}

	private renderOutputPreview(el: HTMLElement, text: string): void {
		const outputWrap = el.createDiv({ cls: "llm-block-output" });

		// Top bar: label + top copy button
		const topBar = outputWrap.createDiv({ cls: "llm-block-output-bar llm-block-output-bar--top" });
		topBar.createSpan({ cls: "llm-block-output-label", text: "Output" });
		const topCopy = topBar.createEl("button", { cls: "llm-copy-btn llm-copy-icon", text: "⎘" });
		topCopy.setAttribute("aria-label", "Copy output");
		topCopy.addEventListener("click", () => this.copyToClipboard(text, topCopy));

		// Rendered markdown body
		const body = outputWrap.createDiv({ cls: "llm-block-output-body" });
		void MarkdownRenderer.render(this.app, text, body, this.sourcePath, this);

		// Bottom action bar
		const bottomBar = outputWrap.createDiv({ cls: "llm-block-output-bar llm-block-output-bar--bottom" });

		const bottomCopy = bottomBar.createEl("button", { cls: "llm-copy-btn llm-copy-icon", text: "⎘" });
		bottomCopy.setAttribute("aria-label", "Copy output");
		bottomCopy.addEventListener("click", () => this.copyToClipboard(text, bottomCopy));

		const saveBtn = bottomBar.createEl("button", { cls: "llm-block-save-btn" });
		saveBtn.setText("↓ Save to file");
		saveBtn.setAttribute("aria-label", "Append output below this block (leaves block intact)");
		saveBtn.addEventListener("click", () => {
			void this.appendOutputBelowBlock(text, saveBtn);
		});

		const commitBtn = bottomBar.createEl("button", { cls: "llm-block-commit-btn mod-cta" });
		commitBtn.setText("✓ Commit");
		commitBtn.setAttribute("aria-label", "Write back — converts block to callout (@keep) or replaces it (@consume)");
		commitBtn.addEventListener("click", () => {
			void this.commitWriteback(text);
		});

		const clearBtn = bottomBar.createEl("button", { cls: "llm-block-clear-btn" });
		clearBtn.setText("✕ Clear");
		clearBtn.addEventListener("click", () => {
			this.lastResult = null;
			this.render();
		});

		const runAllBtn = bottomBar.createEl("button", { cls: "llm-block-runall-btn" });
		runAllBtn.setText("▶ Run all cells");
		runAllBtn.setAttribute("aria-label", "Save output and run all code blocks in this note");
		runAllBtn.addEventListener("click", () => {
			void this.saveAndRunAllCells(text, runAllBtn, "all");
		});

		const runGeneratedBtn = bottomBar.createEl("button", { cls: "llm-block-runllm-btn" });
		runGeneratedBtn.setText("▶ Run generated cells");
		runGeneratedBtn.setAttribute("aria-label", "Save output and run only code blocks generated by this run");
		runGeneratedBtn.addEventListener("click", () => {
			void this.saveAndRunAllCells(text, runGeneratedBtn, "scope");
		});
	}

	private async saveAndRunAllCells(text: string, btn: HTMLButtonElement, mode: "all" | "scope"): Promise<void> {
		const restore = mode === "all" ? "▶ Run all cells" : "▶ Run generated cells";
		const runSetId = mode === "scope" ? this.makeRunSetId() : null;
		const payload = mode === "scope" ? this.wrapWithLlmScope(text, runSetId as string) : text;
		await this.appendOutputBelowBlock(payload, btn);
		btn.setText("▶ Running...");

		const commandRan = await this.executeCodeRun(mode, runSetId);
		if (!commandRan) {
			btn.disabled = true;
			btn.setText("Execution not available");
			setTimeout(() => {
				btn.disabled = false;
				btn.setText(restore);
			}, 2200);
		} else {
			setTimeout(() => btn.setText(restore), 1200);
		}
	}

	private async executeCodeRun(mode: "all" | "scope", runSetId: string | null): Promise<boolean> {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const internalApp = this.app as any;
		const plugin = internalApp.plugins?.getPlugin("execute-code") as
			| {
				runAllCodeBlocksInCurrentFile?: () => Promise<boolean> | boolean;
				runLlmCodeBlocksInCurrentFile?: (scopeId: string) => Promise<boolean> | boolean;
			}
			| undefined;

		try {
			if (mode === "all") {
				if (plugin?.runAllCodeBlocksInCurrentFile) {
					return !!(await plugin.runAllCodeBlocksInCurrentFile());
				}
				return !!internalApp.commands?.executeCommandById("execute-code:run-all-code-blocks-in-file");
			}

			if (runSetId && plugin?.runLlmCodeBlocksInCurrentFile) {
				return !!(await plugin.runLlmCodeBlocksInCurrentFile(runSetId));
			}
		} catch (error) {
			console.error("Failed to execute code with Execute Code plugin", error);
			return false;
		}

		return false;
	}

	private makeRunSetId(): string {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}

	private wrapWithLlmScope(text: string, scopeId: string): string {
		const startMarker = `<!-- ${LLMBlockRenderer.runSetMarkerPrefix}-start:${scopeId} -->`;
		const endMarker = `<!-- ${LLMBlockRenderer.runSetMarkerPrefix}-end:${scopeId} -->`;
		return `${startMarker}\n\n${text}\n\n${endMarker}`;
	}

	private copyToClipboard(text: string, btn: HTMLButtonElement): void {
		navigator.clipboard.writeText(text).then(() => {
			const original = btn.textContent ?? "⎘";
			btn.setText("✓");
			setTimeout(() => btn.setText(original), 1500);
		}).catch(() => {
			btn.setText("✗");
			setTimeout(() => btn.setText("⎘"), 1500);
		});
	}

	private async executeQuery(): Promise<void> {
		const fullPrompt = this.buildFullPrompt();
		if (!fullPrompt || this.running) return;
		this.running = true;

		const el = this.containerEl;
		const btn = el.querySelector(".llm-block-run-btn") as HTMLButtonElement | null;
		const presetSelect = el.querySelector(".llm-block-preset-select") as HTMLSelectElement | null;
		const providerSelect = el.querySelector(".llm-block-provider-select") as HTMLSelectElement | null;

		if (btn) { btn.disabled = true; btn.setText("Running…"); }
		if (presetSelect) presetSelect.disabled = true;
		if (providerSelect) providerSelect.disabled = true;

		const spinner = el.createDiv({ cls: "llm-block-spinner" });
		spinner.createSpan({ text: "Querying…" });

		try {
			const augmentedPrompt = await resolveScope(
				this.app, this.sourcePath, fullPrompt, this.scope, this.embeddings,
			);

			const provider = BUILT_IN_PROVIDERS.find(p => p.id === this.selectedProviderId);
			const queryOpts: {
				directConfig?: {
					provider: LLMProvider;
					baseUrl: string;
					apiKey: string;
					model: string;
					maxOutputTokens: number;
				};
			} = {};
			if (provider?.mode === "direct") {
				queryOpts.directConfig = {
					provider: provider.provider,
					baseUrl: provider.baseUrl,
					apiKey: provider.apiKey,
					model: provider.model,
					maxOutputTokens: provider.maxOutputTokens,
				};
			}

			const result = await this.client.query(augmentedPrompt, queryOpts);

			// Store result and re-render to show the output preview (no auto write-back)
			this.lastResult = result.text;
			this.running = false;
			this.render();
		} catch (e) {
			spinner.remove();
			const errDiv = el.createDiv({ cls: "llm-block-error" });
			errDiv.createSpan({ text: `Error: ${(e as Error).message}` });

			if (btn) { btn.disabled = false; btn.setText("Run"); }
			if (presetSelect) presetSelect.disabled = false;
			if (providerSelect) providerSelect.disabled = false;
			this.running = false;
		}
	}

	/** Append the response as plain markdown after the ```llm block, leaving the block intact. */
	private async appendOutputBelowBlock(text: string, btn: HTMLButtonElement): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) return;

		btn.disabled = true;
		btn.setText("Saving…");

		try {
			await this.app.vault.process(file, (content) => {
				const normalized = content.replace(/\r\n/g, "\n");
				const rawNorm = this.rawSource.replace(/\r\n/g, "\n");
				const searchStr = "```llm\n" + rawNorm + "\n```";
				const idx = normalized.indexOf(searchStr);
				if (idx === -1) return content;

				const insertAt = idx + searchStr.length;
				const result = normalized.slice(0, insertAt) + "\n\n" + text + normalized.slice(insertAt);
				return content.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
			});

			btn.setText("✓ Saved");
			setTimeout(() => { btn.disabled = false; btn.setText("↓ Save to file"); }, 2000);
		} catch (e) {
			btn.disabled = false;
			btn.setText("Save failed");
			setTimeout(() => btn.setText("↓ Save to file"), 2000);
		}
	}

	/** Write back via the existing callout/@consume mechanism. */
	private async commitWriteback(text: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) {
			throw new Error("Source file not found: " + this.sourcePath);
		}

		await this.app.vault.process(file, (content) => {
			const updated = applyWriteback(content, this.rawSource, text, this.directive);
			if (updated === null) {
				throw new Error("Could not find the LLM block in the file. It may have been edited since rendering.");
			}
			return updated;
		});
		// Obsidian re-renders automatically after file change
	}

	private sanitizePromptPresets(presets: PromptPreset[]): PromptPreset[] {
		const deduped = new Map<string, PromptPreset>();
		for (const preset of presets) {
			const id = (preset.id ?? "").trim();
			const prompt = (preset.prompt ?? "").trim();
			if (!id || !prompt) continue;
			if (!deduped.has(id.toLowerCase())) {
				deduped.set(id.toLowerCase(), {
					id,
					label: preset.label?.trim() || undefined,
					prompt,
				});
			}
		}
		return Array.from(deduped.values());
	}

	private resolvePresetId(requestedId: string): string {
		if (!requestedId.trim()) return "";
		const preset = this.findPreset(requestedId);
		return preset?.id ?? "";
	}

	private findPreset(id: string): PromptPreset | null {
		const normalized = id.trim().toLowerCase();
		if (!normalized) return null;
		return this.promptPresets.find((preset) => preset.id.toLowerCase() === normalized) ?? null;
	}

	private getActivePreset(): PromptPreset | null {
		if (!this.selectedPresetId) return null;
		return this.findPreset(this.selectedPresetId);
	}

	private buildPrimaryPrompt(): string {
		const preset = this.getActivePreset();
		const body = this.promptBody.trim();
		if (!preset) return body;
		if (!body) return preset.prompt;
		return `${preset.prompt}\n\n${body}`;
	}

	private buildFullPrompt(): string {
		const primary = this.buildPrimaryPrompt();
		const extras = this.additionalPrompts.map(p => p.trim()).filter(Boolean);
		if (extras.length === 0) return primary;
		return [primary, ...extras].filter(Boolean).join("\n\n");
	}
}
