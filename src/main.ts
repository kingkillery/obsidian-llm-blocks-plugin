import { App, Editor, MarkdownView, Modal, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { AuthState, ConnectionState, DEFAULT_SETTINGS, LLMBlocksSettings, PromptPreset } from "./types";
import { ResponseCache } from "./cache";
import { CodexWebSocketClient, ClientRuntimeDebugState } from "./websocket-client";
import { LLMBlockRenderer } from "./renderer";
import { LLMBlocksSettingTab } from "./settings";
import { createCalloutRerunPostProcessor } from "./callout-rerun";
import { createInlineTemplateExtension, createFillAllTemplatesCommand } from "./inline-template";
import { VaultEmbeddings } from "./embeddings";

interface PkQmdSearchResult {
  docid?: string;
  score?: number;
  file?: string;
  title?: string;
  snippet?: string;
  line?: number;
  heading?: string;
}

interface PkQmdSearchOptions {
  backend?: "search" | "vsearch" | "query";
  limit?: number;
  collectionName?: string;
  useGlobalFallback?: boolean;
}

interface PkQmdSettingsLike {
  defaultBackend?: "search" | "vsearch" | "query";
  openInNewLeaf?: boolean;
}

type PkQmdPrimaryAction = "open" | "insert";

interface PkQmdSearchLaunchOptions {
	initialQuery?: string;
	primaryAction?: PkQmdPrimaryAction;
}

interface PkQmdPluginAPI {
  search: (query: string, options?: PkQmdSearchOptions) => Promise<PkQmdSearchResult[]>;
  searchAndOpen: (query: string, options?: PkQmdSearchOptions) => Promise<PkQmdSearchResult[]>;
  ensureCollection: () => Promise<string>;
  refreshIndex: (source?: "manual" | "filechange") => Promise<void>;
  resolveFile: (searchFile: string) => TFile | null;
  openResult: (result: PkQmdSearchResult) => Promise<void>;
  getSettings: () => Record<string, unknown>;
  getCollectionName: () => string;
}

export default class LLMBlocksPlugin extends Plugin {
	settings: LLMBlocksSettings = DEFAULT_SETTINGS;
	cache = new ResponseCache();
	wsClient!: CodexWebSocketClient;
	embeddings: VaultEmbeddings | null = null;
	private statusBarEl: HTMLElement | null = null;
	private settingsTab: LLMBlocksSettingTab | null = null;
	private pkqmdApi: PkQmdPluginAPI | null = null;
	private lastBlockRunTrace: string | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		console.info(
			"[llm-blocks] plugin load start",
			`activeProvider=${this.settings.activeProviderId}`,
			`directMode=${this.settings.allowDirectMode}`,
			`customModel=${this.settings.activeModelId || "(none)"}`,
		);

		window.addEventListener("llm-blocks-block-run", this.onBlockRunEvent);

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
					openRouterApiKey: this.settings.openRouterApiKey,
					allowDirectMode: this.settings.allowDirectMode,
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
						openRouterApiKey: this.settings.openRouterApiKey,
						allowDirectMode: this.settings.allowDirectMode,
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

		this.addCommand({
			id: "llm-debug-state",
			name: "Log LLM Blocks runtime state",
			callback: () => {
				const clientState: ClientRuntimeDebugState = this.wsClient.getRuntimeDebugState();
				console.info("LLM Blocks runtime state:", {
					activeProviderId: this.settings.activeProviderId,
					allowDirectMode: this.settings.allowDirectMode,
					activeModelId: this.settings.activeModelId || "(none)",
					client: clientState,
				});
				new Notice("LLM Blocks runtime state logged to console", 5000);
			},
		});

		this.addCommand({
			id: "llm-debug-block-state",
			name: "Log last LLM block run trace",
			callback: () => {
				if (!this.lastBlockRunTrace) {
					new Notice("LLM Blocks: no run trace yet. Click Run first.");
					return;
				}
				console.info("LLM Blocks block trace:", this.lastBlockRunTrace);
				new Notice("LLM Blocks block trace logged to console", 5000);
			},
		});

		this.addCommand({
			id: "llm-search-vault-notes",
			name: "Search vault notes with pk-qmd",
			hotkeys: [{ modifiers: ["Mod"], key: "k" }],
			callback: () => {
				void this.openPkQmdSearch();
			}
		});

		this.addCommand({
			id: "llm-insert-vault-link-pk-qmd",
			name: "Insert vault link with pk-qmd search",
			hotkeys: [{ modifiers: ["Mod", "Alt"], key: "k" }],
			callback: () => {
				void this.openPkQmdSearch({ primaryAction: "insert" });
			}
		});

		this.addCommand({
			id: "llm-search-vault-notes-from-selection",
			name: "Search vault notes from selection with pk-qmd",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "k" }],
			editorCallback: (editor) => {
				void this.openPkQmdSearch({
					initialQuery: this.getEditorSeedQuery(editor),
				});
			},
		});

		// Connect immediately; onLayoutReady acts as a safe retry hook.
		this.wsClient.connect();

		// Connect on layout ready (deferred)
		this.app.workspace.onLayoutReady(() => {
			this.wsClient.connect();
			this.checkExecuteCodeIntegration();
			this.detectPkqmdIntegration();
		});
	}

	private detectPkqmdIntegration(): void {
		const api = this.getPkqmdApi();
		if (!api) {
			console.debug("LLM Blocks: pk-qmd plugin/API not found; skip vault search integration.");
			return;
		}

		this.pkqmdApi = api;
		console.info(`LLM Blocks: pk-qmd API ready for collection ${api.getCollectionName()}`);
	}

	private getPkqmdApiFresh(): PkQmdPluginAPI | null {
		if (this.pkqmdApi) {
			return this.pkqmdApi;
		}
		this.pkqmdApi = this.getPkqmdApi();
		return this.pkqmdApi;
	}

	private async openPkQmdSearch(options: PkQmdSearchLaunchOptions = {}): Promise<void> {
		const api = this.getPkqmdApiFresh();
		if (!api) {
			new Notice("llm-blocks: pk-qmd plugin not found or API unavailable.");
			return;
		}
		new PkQmdSearchCommandModal(this.app, api, options).open();
	}

	private getEditorSeedQuery(editor: Editor): string {
		const selected = editor.getSelection().trim();
		if (selected) {
			return selected;
		}
		return editor.getLine(editor.getCursor().line).trim();
	}

	private checkExecuteCodeIntegration(): void {
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const internalApp = this.app as any;
			const commands = internalApp.commands;
			const hasCommand = typeof commands?.getCommand === "function" &&
				Boolean(commands.getCommand("execute-code:run-all-code-blocks-in-file"));
			const hasApi = typeof internalApp.plugins?.getPlugin === "function" &&
				Boolean(internalApp.plugins.getPlugin("execute-code"));
			if (!hasCommand && !hasApi) {
				console.debug("LLM Blocks: Execute Code plugin not found; Run-all integration unavailable.");
			}
		} catch {
			// Integration check is non-critical; never crash plugin load.
		}
	}

	private getPkqmdApi(): PkQmdPluginAPI | null {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const appAny = this.app as any;
		const installed = appAny.plugins?.getPlugin?.("pk-qmd");
		if (!installed || typeof installed.getAPI !== "function") {
			return null;
		}

		const api: PkQmdPluginAPI = installed.getAPI();
		if (!api?.search || !api?.openResult) {
			return null;
		}

		return api;
	}

	onunload(): void {
		this.wsClient.disconnect();
		this.embeddings?.dispose();
		window.removeEventListener("llm-blocks-block-run", this.onBlockRunEvent);
	}

	private onBlockRunEvent = (event: Event): void => {
		const payload = (event as CustomEvent).detail;
		if (payload && typeof payload.message === "string") {
			this.lastBlockRunTrace = payload.message;
		}
	};

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

class PkQmdSearchCommandModal extends Modal {
	private static readonly RECENT_QUERIES_KEY = "llmblocks.pkqmd.recentQueries";
	private static readonly PINNED_QUERIES_KEY = "llmblocks.pkqmd.pinnedQueries";
	private static readonly MAX_RECENT_QUERIES = 8;
	private static readonly MAX_PINNED_QUERIES = 6;
	private query = "";
	private results: PkQmdSearchResult[] = [];
	private recentQueries: string[] = [];
	private pinnedQueries: string[] = [];
	private backend: PkQmdSearchOptions["backend"] = "query";
	private primaryAction: PkQmdPrimaryAction = "open";
	private collectionName = "";
	private openInNewLeaf = false;
	private searchTimer: number | null = null;
	private selectedIndex = 0;
	private statusEl?: HTMLDivElement;
	private inputEl?: HTMLInputElement;
	private modeEl?: HTMLSelectElement;
	private actionEl?: HTMLSelectElement;
	private recentQueriesEl?: HTMLDivElement;
	private resultsEl?: HTMLDivElement;
	private openInNewLeafEl?: HTMLInputElement;

	constructor(
		app: App,
		private api: PkQmdPluginAPI,
		private options: PkQmdSearchLaunchOptions = {}
	) {
		super(app);
		this.collectionName = this.getCollectionNameHint();
		this.applyApiDefaults();
		this.recentQueries = this.loadRecentQueries();
		this.pinnedQueries = this.loadPinnedQueries();
		this.query = (this.options.initialQuery || "").trim();
		this.primaryAction = this.options.primaryAction || "open";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Search Vault Notes (pk-qmd)" });
		const input = contentEl.createEl("input", {
			attr: {
				type: "text",
				placeholder: "Search notes, headings, and snippets..."
			}
		});
		input.addClass("pk-qmd-search-input");
		this.inputEl = input;
		this.inputEl.value = this.query;
		this.inputEl.focus();
		this.inputEl.addEventListener("keydown", (event) => {
			this.handleKeydown(event);
		});

		this.inputEl.addEventListener("input", () => {
			this.query = this.inputEl?.value ?? "";
			this.scheduleSearch();
		});

		const controlRow = contentEl.createDiv({ cls: "llmblocks-pkqmd-controls" });
		const modeWrap = controlRow.createDiv({ cls: "llmblocks-pkqmd-controls-group" });
		modeWrap.createEl("span", { text: "Mode" });
		this.modeEl = modeWrap.createEl("select");
		const searchModes = [
			{ label: "search", value: "search" },
			{ label: "vsearch", value: "vsearch" },
			{ label: "query", value: "query" },
		];
		for (const option of searchModes) {
			this.modeEl.createEl("option", {
				value: option.value,
				text: option.label,
			});
		}
		this.modeEl.value = this.backend;
		this.modeEl.addEventListener("change", () => {
			const nextMode = this.modeEl?.value as PkQmdSearchOptions["backend"];
			if (nextMode) {
				this.backend = nextMode;
				void this.searchNow();
			}
		});

		const actionWrap = controlRow.createDiv({ cls: "llmblocks-pkqmd-controls-group" });
		actionWrap.createEl("span", { text: "Enter action" });
		this.actionEl = actionWrap.createEl("select");
		this.actionEl.createEl("option", { text: "Open note", value: "open" });
		this.actionEl.createEl("option", { text: "Insert link", value: "insert" });
		this.actionEl.value = this.primaryAction;
		this.actionEl.addEventListener("change", () => {
			const nextAction = this.actionEl?.value as PkQmdPrimaryAction;
			if (nextAction === "open" || nextAction === "insert") {
				this.primaryAction = nextAction;
			}
		});

		const pinWrap = controlRow.createDiv({ cls: "llmblocks-pkqmd-controls-group" });
		const pinCurrentButton = pinWrap.createEl("button", { text: "Pin current" });
		pinCurrentButton.addClass("llmblocks-pkqmd-pin-current");
		pinCurrentButton.addEventListener("click", () => {
			this.pinCurrentQuery();
		});

		const collectionWrap = controlRow.createDiv({ cls: "llmblocks-pkqmd-controls-group" });
		collectionWrap.createEl("span", { text: "Collection" });
		collectionWrap.createEl("span", { text: this.collectionName || "default" });

		const leafWrap = controlRow.createDiv({ cls: "llmblocks-pkqmd-controls-group" });
		leafWrap.createEl("span", { text: "Open in new pane" });
		this.openInNewLeafEl = leafWrap.createEl("input", {
			attr: {
				type: "checkbox"
			}
		});
		this.openInNewLeafEl.checked = this.openInNewLeaf;
		this.openInNewLeafEl.addEventListener("change", () => {
			this.openInNewLeaf = this.openInNewLeafEl?.checked === true;
		});

		controlRow.createEl("span", { text: "Tip: Enter runs selected action, Alt+Enter runs the alternate action, 1/2/3 switches mode" });

		this.recentQueriesEl = contentEl.createDiv({ cls: "llmblocks-pkqmd-recent" });
		this.renderRecentQueries();

		this.statusEl = contentEl.createDiv({ cls: "pk-qmd-search-status", text: "Type to search your vault." });
		this.resultsEl = contentEl.createDiv({ cls: "pk-qmd-search-results" });

		if (this.query) {
			this.setStatus("Searching...");
			this.renderResults();
			void this.searchNow();
			return;
		}

		this.setStatus("Type to search your vault.");
		this.renderResults();
	}

	onClose() {
		if (this.searchTimer !== null) {
			window.clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}
		this.contentEl.empty();
	}

	private scheduleSearch() {
		if (this.searchTimer !== null) {
			window.clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}

		this.searchTimer = window.setTimeout(() => {
			this.searchTimer = null;
			void this.searchNow();
		}, 250);
	}

	private async searchNow(): Promise<void> {
		const query = this.query.trim();
		if (!this.inputEl || !this.resultsEl) {
			return;
		}

		if (!query) {
			this.setStatus("Type to search your vault.");
			this.results = [];
			this.renderResults();
			return;
		}

		this.setStatus("Searching...");
		this.renderResults();

		this.results = await this.api.search(query, {
			backend: this.backend,
			limit: 12,
			collectionName: this.collectionName || undefined,
			useGlobalFallback: true
		});
		this.rememberRecentQuery(query);
		this.selectedIndex = 0;

		if (this.results.length === 0) {
			this.setStatus(`No results for "${query}"`);
		} else {
			const collectionText = this.collectionName ? ` in ${this.collectionName}` : "";
			const primaryText = this.primaryAction === "insert" ? "Enter inserts link" : "Enter opens note";
			this.setStatus(`Found ${this.results.length} result(s)${collectionText} using ${this.backend}. ${primaryText}.`);
		}
		this.renderResults();
	}

	private setStatus(text: string) {
		if (!this.statusEl) {
			return;
		}
		this.statusEl.textContent = text;
	}

	private loadRecentQueries(): string[] {
		try {
			const raw = window.localStorage.getItem(PkQmdSearchCommandModal.RECENT_QUERIES_KEY);
			if (!raw) {
				return [];
			}
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean)
				.slice(0, PkQmdSearchCommandModal.MAX_RECENT_QUERIES);
		} catch {
			return [];
		}
	}

	private loadPinnedQueries(): string[] {
		try {
			const raw = window.localStorage.getItem(PkQmdSearchCommandModal.PINNED_QUERIES_KEY);
			if (!raw) {
				return [];
			}
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean)
				.slice(0, PkQmdSearchCommandModal.MAX_PINNED_QUERIES);
		} catch {
			return [];
		}
	}

	private persistRecentQueries() {
		try {
			window.localStorage.setItem(
				PkQmdSearchCommandModal.RECENT_QUERIES_KEY,
				JSON.stringify(this.recentQueries.slice(0, PkQmdSearchCommandModal.MAX_RECENT_QUERIES))
			);
		} catch {
			// Best effort only.
		}
	}

	private persistPinnedQueries() {
		try {
			window.localStorage.setItem(
				PkQmdSearchCommandModal.PINNED_QUERIES_KEY,
				JSON.stringify(this.pinnedQueries.slice(0, PkQmdSearchCommandModal.MAX_PINNED_QUERIES))
			);
		} catch {
			// Best effort only.
		}
	}

	private rememberRecentQuery(query: string) {
		const nextQuery = query.trim();
		if (!nextQuery) {
			return;
		}

		const normalized = nextQuery.toLowerCase();
		this.recentQueries = [
			nextQuery,
			...this.recentQueries.filter((item) => item.toLowerCase() !== normalized),
		].slice(0, PkQmdSearchCommandModal.MAX_RECENT_QUERIES);
		this.persistRecentQueries();
		this.renderRecentQueries();
	}

	private pinCurrentQuery() {
		const next = this.query.trim();
		if (!next) {
			new Notice("Type a query before pinning.");
			return;
		}
		this.upsertPinnedQuery(next);
		new Notice(`Pinned "${next}"`);
	}

	private upsertPinnedQuery(query: string) {
		const next = query.trim();
		if (!next) {
			return;
		}

		const normalized = next.toLowerCase();
		this.pinnedQueries = [
			next,
			...this.pinnedQueries.filter((item) => item.toLowerCase() !== normalized),
		].slice(0, PkQmdSearchCommandModal.MAX_PINNED_QUERIES);
		this.persistPinnedQueries();
		this.renderRecentQueries();
	}

	private unpinQuery(query: string) {
		const normalized = query.trim().toLowerCase();
		this.pinnedQueries = this.pinnedQueries.filter((item) => item.toLowerCase() !== normalized);
		this.persistPinnedQueries();
		this.renderRecentQueries();
	}

	private renderRecentQueries() {
		if (!this.recentQueriesEl) {
			return;
		}
		this.recentQueriesEl.empty();

		if (this.recentQueries.length === 0 && this.pinnedQueries.length === 0) {
			return;
		}

		if (this.pinnedQueries.length > 0) {
			const pinnedLabel = this.recentQueriesEl.createDiv({ cls: "llmblocks-pkqmd-recent-label", text: "Pinned" });
			pinnedLabel.setAttribute("aria-label", "Pinned queries");

			const pinnedChips = this.recentQueriesEl.createDiv({ cls: "llmblocks-pkqmd-recent-chips" });
			this.pinnedQueries.forEach((query) => {
				const item = pinnedChips.createDiv({ cls: "llmblocks-pkqmd-shortcut-item" });
				const chip = item.createEl("button", { text: query, cls: "llmblocks-pkqmd-recent-chip llmblocks-pkqmd-pinned-chip" });
				chip.addEventListener("click", () => {
					this.applyQuery(query);
				});

				const remove = item.createEl("button", { text: "x", cls: "llmblocks-pkqmd-shortcut-remove" });
				remove.addEventListener("click", () => {
					this.unpinQuery(query);
				});
			});

			const clearPinned = this.recentQueriesEl.createEl("button", {
				text: "Clear pinned",
				cls: "llmblocks-pkqmd-recent-clear",
			});
			clearPinned.addEventListener("click", () => {
				this.pinnedQueries = [];
				this.persistPinnedQueries();
				this.renderRecentQueries();
			});
		}

		if (this.recentQueries.length > 0) {
			const label = this.recentQueriesEl.createDiv({ cls: "llmblocks-pkqmd-recent-label", text: "Recent" });
			label.setAttribute("aria-label", "Recent queries");

			const chips = this.recentQueriesEl.createDiv({ cls: "llmblocks-pkqmd-recent-chips" });
			this.recentQueries.forEach((query) => {
				const item = chips.createDiv({ cls: "llmblocks-pkqmd-shortcut-item" });
				const chip = item.createEl("button", { text: query, cls: "llmblocks-pkqmd-recent-chip" });
				chip.addEventListener("click", () => {
					this.applyQuery(query);
				});

				const pin = item.createEl("button", { text: "+", cls: "llmblocks-pkqmd-shortcut-pin" });
				pin.addEventListener("click", () => {
					this.upsertPinnedQuery(query);
				});
			});

			const clearButton = this.recentQueriesEl.createEl("button", {
				text: "Clear recent",
				cls: "llmblocks-pkqmd-recent-clear",
			});
			clearButton.addEventListener("click", () => {
				this.recentQueries = [];
				this.persistRecentQueries();
				this.renderRecentQueries();
			});
		}
	}

	private applyQuery(query: string) {
		const next = query.trim();
		this.query = next;
		if (this.inputEl) {
			this.inputEl.value = next;
			this.inputEl.focus();
		}
		if (!next) {
			this.results = [];
			this.renderResults();
			this.setStatus("Type to search your vault.");
			return;
		}
		void this.searchNow();
	}

	private renderResults() {
		if (!this.resultsEl) {
			return;
		}

		this.resultsEl.empty();

		this.results.forEach((result, index) => {
			const row = this.resultsEl!.createDiv({ cls: "llmblocks-pkqmd-result-row" });
			if (index === this.selectedIndex) {
				row.addClass("is-active");
			}
			row.addEventListener("mouseenter", () => {
				this.selectedIndex = index;
				this.renderResults();
			});

			row.addEventListener("click", () => {
				this.selectedIndex = index;
				void this.runPrimaryAction(result, true);
			});

			const title = result.title || result.docid || result.file || "Untitled";
			row.createEl("div", {
				cls: "llmblocks-pkqmd-result-title",
				text: title,
			});

			const meta = [result.file, result.line ? `line ${result.line + 1}` : ""] .filter(Boolean).join(" | ");
			const scoreText = typeof result.score === "number" ? `score ${result.score.toFixed(3)}` : "";
			const scorePieces = [meta, scoreText].filter(Boolean);
			row.createEl("div", {
				cls: "llmblocks-pkqmd-result-meta",
				text: scorePieces.length ? scorePieces.join("  |  ") : "No file metadata",
			});

			if (result.snippet) {
				row.createEl("pre", {
					cls: "llmblocks-pkqmd-result-snippet",
					text: this.truncateSnippet(result.snippet),
				});
			}

			const actions = row.createDiv({ cls: "llmblocks-pkqmd-result-actions" });
			const openButton = actions.createEl("button", { text: "Open" });
			openButton.addEventListener("click", (event) => {
				event.stopPropagation();
				this.selectedIndex = index;
				void this.openResult(result, true);
			});

			const insertButton = actions.createEl("button", { text: "Insert Link" });
			insertButton.addEventListener("click", (event) => {
				event.stopPropagation();
				void this.insertResultLink(result, false);
			});
		});
	}

	private async runPrimaryAction(result: PkQmdSearchResult, closeAfter = true): Promise<void> {
		if (this.primaryAction === "insert") {
			await this.insertResultLink(result, closeAfter);
			return;
		}
		await this.openResult(result, closeAfter);
	}

	private async openResult(result: PkQmdSearchResult, closeAfter = true): Promise<void> {
		if (this.openInNewLeaf) {
			const file = this.api.resolveFile(result.file || "");
			if (file) {
				await this.openInNewLeafResult(file, result);
			} else {
				await this.api.openResult(result);
			}
		} else {
			await this.api.openResult(result);
		}

		if (closeAfter) {
			this.close();
		}
	}

	private async openInNewLeafResult(file: TFile, result: PkQmdSearchResult): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.openFile(file);
		const targetLine = await this.getResultLineTarget(file, result);
		if (targetLine !== null) {
			await this.setLeafCursor(leaf, file, targetLine);
		}
	}

	private truncateSnippet(snippet: string): string {
		if (!snippet) return "";
		return snippet.split("\n").slice(0, 3).join("\n");
	}

	private async insertResultLink(result: PkQmdSearchResult, closeAfter = false): Promise<void> {
		const resultFile = this.api.resolveFile(result.file || "");
		if (!resultFile) {
			new Notice(`Could not resolve file for ${result.title || result.docid || result.file}`);
			return;
		}

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.editor) {
			new Notice("No active markdown editor to insert link.");
			return;
		}

		const headingSuffix = result.heading ? `#${result.heading}` : "";
		const insertion = `[[${resultFile.path}${headingSuffix}]]`;
		const cursor = activeView.editor.getCursor("from");
		activeView.editor.replaceRange(insertion, cursor);
		activeView.editor.setCursor({ line: cursor.line, ch: cursor.ch + insertion.length });
		new Notice(`Inserted ${insertion}`);
		if (closeAfter) {
			this.close();
		}
	}

	private getCollectionNameHint(): string {
		const collection = this.api.getCollectionName();
		return (collection || "").trim();
	}

	private applyApiDefaults(): void {
		const settings = this.api.getSettings() as PkQmdSettingsLike;
		const defaultBackend = settings?.defaultBackend;
		if (defaultBackend === "search" || defaultBackend === "vsearch" || defaultBackend === "query") {
			this.backend = defaultBackend;
		}

		if (typeof settings?.openInNewLeaf === "boolean") {
			this.openInNewLeaf = settings.openInNewLeaf;
		}
	}

	private async getResultLineTarget(file: TFile, result: PkQmdSearchResult): Promise<number | null> {
		if (typeof result.line === "number" && Number.isFinite(result.line) && result.line >= 0) {
			return result.line;
		}

		if (result.snippet) {
			const match = /^(\d+):/.exec(result.snippet.trim());
			if (match) {
				const parsed = Number.parseInt(match[1], 10);
				if (Number.isFinite(parsed)) {
					return Math.max(0, parsed - 1);
				}
			}
		}

		if (result.heading) {
			return await this.findHeadingLine(file, result.heading);
		}

		return null;
	}

	private async findHeadingLine(file: TFile, heading: string): Promise<number | null> {
		const needle = heading.toLowerCase().trim();
		if (!needle) {
			return null;
		}

		const text = await this.app.vault.cachedRead(file);
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i].trim().toLowerCase();
			if (line.startsWith("#") && line.includes(needle)) {
				return i;
			}
		}
		return null;
	}

	private async setLeafCursor(leaf: WorkspaceLeaf, file: TFile, line: number) {
		const view = leaf.view as { file?: TFile; editor?: MarkdownView["editor"] };
		if (!view?.editor || view.file?.path !== file.path) {
			return;
		}

		const targetLine = Math.max(0, Math.min(line, view.editor.lastLine()));
		view.editor.setCursor({ line: targetLine, ch: 0 });
		view.editor.scrollTo(targetLine, 0);
	}

	private handleKeydown(event: KeyboardEvent) {
		if (event.key === "1" || event.key === "2" || event.key === "3") {
			const mapping: Record<string, PkQmdSearchOptions["backend"]> = {
				"1": "search",
				"2": "vsearch",
				"3": "query",
			};
			const next = mapping[event.key];
			if (next) {
				event.preventDefault();
				this.backend = next;
				if (this.modeEl) {
					this.modeEl.value = next;
				}
				this.searchNow();
			}
			return;
		}

		if (this.results.length === 0) {
			if (event.key === "Escape") {
				this.close();
			}
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			this.selectedIndex = Math.min(this.selectedIndex + 1, this.results.length - 1);
			this.renderResults();
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
			this.renderResults();
			return;
		}
		if (event.key === "Enter" && event.altKey) {
			event.preventDefault();
			const target = this.results[this.selectedIndex];
			if (target) {
				if (this.primaryAction === "insert") {
					void this.openResult(target, true);
				} else {
					void this.insertResultLink(target, false);
				}
			}
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const target = this.results[this.selectedIndex];
			if (target) {
				void this.runPrimaryAction(target, true);
			}
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			this.close();
		}
	}
}
