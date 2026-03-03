import { App, MarkdownRenderChild, MarkdownPostProcessorContext, TFile } from "obsidian";
import { CodexWebSocketClient } from "./websocket-client";
import { parseLLMBlock, applyWriteback } from "./writeback";
import type { PromptPreset, WritebackDirective } from "./types";

interface LLMBlockRendererOptions {
	initialPresetId?: string;
	promptPresets?: PromptPreset[];
}

export class LLMBlockRenderer extends MarkdownRenderChild {
	private app: App;
	private client: CodexWebSocketClient;
	private sourcePath: string;
	private rawSource: string;
	private promptBody: string;
	private directive: WritebackDirective;
	private promptPresets: PromptPreset[];
	private selectedPresetId = "";
	private unresolvedPresetId = "";
	private running = false;

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

		const parsed = parseLLMBlock(sourcePrompt);
		this.directive = parsed.directive;
		this.promptBody = parsed.prompt;

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

		const primaryPrompt = this.buildPrimaryPrompt();

		const btn = controls.createEl("button", {
			cls: "llm-block-run-btn",
			text: "Run",
		});
		btn.addClass("mod-cta");
		btn.disabled = !primaryPrompt;
		btn.addEventListener("click", () => {
			void this.executeAndWriteBack();
		});

		if (this.unresolvedPresetId && !activePreset) {
			const warn = el.createDiv({ cls: "llm-block-warning" });
			warn.createSpan({ text: `Preset '${this.unresolvedPresetId}' was not found. Running raw prompt.` });
		}

		const promptEl = el.createDiv({ cls: "llm-block-prompt" });
		promptEl.createEl("pre", {
			text: primaryPrompt || "(Add prompt text or choose a preset.)",
		});
	}

	private async executeAndWriteBack(): Promise<void> {
		const primaryPrompt = this.buildPrimaryPrompt();
		if (!primaryPrompt || this.running) return;
		this.running = true;

		const el = this.containerEl;
		const btn = el.querySelector(".llm-block-run-btn") as HTMLButtonElement | null;
		const presetSelect = el.querySelector(".llm-block-preset-select") as HTMLSelectElement | null;

		if (btn) {
			btn.disabled = true;
			btn.setText("Running...");
		}
		if (presetSelect) presetSelect.disabled = true;

		const spinner = el.createDiv({ cls: "llm-block-spinner" });
		spinner.createSpan({ text: "Querying..." });

		try {
			const result = await this.client.query(primaryPrompt);
			const file = this.app.vault.getAbstractFileByPath(this.sourcePath);
			if (!(file instanceof TFile)) {
				throw new Error("Source file not found: " + this.sourcePath);
			}

			await this.app.vault.process(file, (content) => {
				const updated = applyWriteback(
					content,
					this.rawSource,
					result.text,
					this.directive,
				);
				if (updated === null) {
					throw new Error(
						"Could not find the LLM block in the file. It may have been edited since rendering.",
					);
				}
				return updated;
			});

			// Obsidian re-renders automatically — this MarkdownRenderChild
			// gets unloaded naturally when the code block disappears from the file.
		} catch (e) {
			spinner.remove();
			const errDiv = el.createDiv({ cls: "llm-block-error" });
			errDiv.createSpan({ text: `Error: ${(e as Error).message}` });

			if (btn) {
				btn.disabled = false;
				btn.setText("Run");
			}
			if (presetSelect) presetSelect.disabled = false;
			this.running = false;
		}
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
}
