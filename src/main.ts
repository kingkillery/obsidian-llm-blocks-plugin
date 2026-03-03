import { Plugin } from "obsidian";
import { AuthState, ConnectionState, DEFAULT_SETTINGS, LLMBlocksSettings, PromptPreset } from "./types";
import { ResponseCache } from "./cache";
import { CodexWebSocketClient } from "./websocket-client";
import { LLMBlockRenderer } from "./renderer";
import { LLMBlocksSettingTab } from "./settings";
import { createCalloutRerunPostProcessor } from "./callout-rerun";
import { createInlineTemplateExtension, createFillAllTemplatesCommand } from "./inline-template";
import { VaultEmbeddings } from "./embeddings";

export default class LLMBlocksPlugin extends Plugin {
	settings: LLMBlocksSettings = DEFAULT_SETTINGS;
	cache = new ResponseCache();
	wsClient!: CodexWebSocketClient;
	embeddings: VaultEmbeddings | null = null;
	private statusBarEl: HTMLElement | null = null;
	private settingsTab: LLMBlocksSettingTab | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.wsClient = new CodexWebSocketClient(this.settings);

		// Vault embeddings (lazy — initialized on first @vault use, not here)
		this.embeddings = new VaultEmbeddings(this.app);

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("disconnected", "unchecked");

		this.wsClient.on("state-change", (state: ConnectionState) => {
			this.updateStatusBar(state, this.wsClient.authState);
		});

		this.wsClient.on("auth-change", (auth: AuthState) => {
			this.updateStatusBar(this.wsClient.connectionState, auth);
			// Refresh settings tab if open so login button appears/disappears
			this.settingsTab?.display();
		});

		this.wsClient.on("login-completed", (success: boolean) => {
			if (success) {
				this.settingsTab?.display();
			}
		});

		// Register the ```llm code block processor (write-back paradigm)
		this.registerMarkdownCodeBlockProcessor("llm", (source, el, ctx) => {
			const renderer = new LLMBlockRenderer(
				this.app,
				el,
				source,
				this.wsClient,
				ctx.sourcePath,
				ctx,
				{
					promptPresets: this.parsePromptPresets(this.settings.promptPresetsJson),
					embeddings: this.embeddings,
					activeProviderId: this.settings.activeProviderId,
				},
			);
			ctx.addChild(renderer);
		});

		// Register <llm>...</llm> and <llm-call>...</llm-call> tags
		this.registerMarkdownPostProcessor((el, ctx) => {
			const tagElements = this.collectLlmTagElements(el);
			for (const tagEl of tagElements) {
				const tagName = tagEl.tagName.toLowerCase();
				const initialPresetId = tagName.startsWith("llm-") ? tagName.slice(4) : "";
				const mount = document.createElement("div");
				tagEl.replaceWith(mount);

				const renderer = new LLMBlockRenderer(
					this.app,
					mount,
					tagEl.textContent ?? "",
					this.wsClient,
					ctx.sourcePath,
					ctx,
					{
						initialPresetId,
						promptPresets: this.parsePromptPresets(this.settings.promptPresetsJson),
						embeddings: this.embeddings,
						activeProviderId: this.settings.activeProviderId,
					},
				);
				ctx.addChild(renderer);
			}
		});

		// Register [!llm] callout re-run post-processor
		this.registerMarkdownPostProcessor(
			createCalloutRerunPostProcessor(this.app, this.wsClient, this.embeddings),
		);

		// Register CM6 extension for {{llm: prompt}} inline templates
		this.registerEditorExtension(
			createInlineTemplateExtension(this.wsClient),
		);

		// Settings tab
		this.settingsTab = new LLMBlocksSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		// Commands
		this.addCommand({
			id: "llm-reconnect",
			name: "Reconnect to Codex server",
			callback: () => {
				this.wsClient.disconnect();
				this.wsClient.connect();
			},
		});

		this.addCommand({
			id: "llm-clear-cache",
			name: "Clear LLM response cache",
			callback: () => { this.cache.clear(); },
		});

		this.addCommand({
			id: "llm-fill-all-templates",
			name: "Fill all LLM templates",
			editorCallback: createFillAllTemplatesCommand(this.wsClient),
		});

		// Connect immediately; onLayoutReady acts as a safe retry hook.
		this.wsClient.connect();

		// Connect on layout ready (deferred)
		this.app.workspace.onLayoutReady(() => {
			this.wsClient.connect();
		});
	}

	onunload(): void {
		this.wsClient.disconnect();
		this.embeddings?.dispose();
	}

	async loadSettings(): Promise<void> {
		const loaded = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		const normalizedEndpoint = this.normalizeEndpoint(loaded.wsEndpoint);
		this.settings = { ...loaded, wsEndpoint: normalizedEndpoint };
		if (normalizedEndpoint !== loaded.wsEndpoint) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.wsClient.updateSettings(this.settings);
	}

	private updateStatusBar(state: ConnectionState, auth: AuthState): void {
		if (!this.statusBarEl) return;
		const icon =
			state !== "connected" ? (state === "connecting" ? "\u{1F7E1}" : state === "error" ? "\u{1F534}" : "\u26AA") :
			auth === "authenticated" ? "\u{1F7E2}" :
			auth === "unauthenticated" ? "\u{1F534}" :
			"\u{1F7E1}";
		const label = state !== "connected" ? state : auth === "authenticated" ? "ready" : "login required";
		this.statusBarEl.setText(`${icon} LLM ${label}`);
		const err = this.wsClient?.lastErrorMessage ? `, err=${this.wsClient.lastErrorMessage}` : "";
		this.statusBarEl.setAttribute("title", `LLM Blocks: ${label} (state=${state}, auth=${auth}${err})`);
	}

	private normalizeEndpoint(endpoint: string): string {
		const trimmed = endpoint.trim();
		if (!trimmed) return DEFAULT_SETTINGS.wsEndpoint;
		if (/^ws:\/\/(127\.0\.0\.1|localhost):9001\/?$/i.test(trimmed)) {
			return "ws://127.0.0.1:4500";
		}
		return trimmed;
	}

	private parsePromptPresets(raw: string): PromptPreset[] {
		const trimmed = raw.trim();
		if (!trimmed) return [];
		try {
			const parsed = JSON.parse(trimmed);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter((item): item is PromptPreset => {
				return !!item && typeof item.id === "string" && typeof item.prompt === "string";
			});
		} catch {
			return [];
		}
	}

	private collectLlmTagElements(root: HTMLElement): HTMLElement[] {
		const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
		return all.filter((candidate) => {
			if (!(candidate instanceof HTMLElement)) return false;
			if (candidate.closest(".llm-block-content")) return false;
			const tagName = candidate.tagName.toLowerCase();
			if (tagName !== "llm" && !tagName.startsWith("llm-")) return false;

			// Ignore nested llm tags; only initialize the outermost tag in a subtree.
			let parent = candidate.parentElement;
			while (parent) {
				const parentTag = parent.tagName.toLowerCase();
				if (parentTag === "llm" || parentTag.startsWith("llm-")) {
					return false;
				}
				parent = parent.parentElement;
			}
			return true;
		});
	}
}
