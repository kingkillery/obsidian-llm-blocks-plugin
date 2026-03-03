import { App, PluginSettingTab, Setting } from "obsidian";
import type LLMBlocksPlugin from "./main";
import type { CustomModelConfig, PromptPreset } from "./types";

function parseCustomModels(raw: string): CustomModelConfig[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	try {
		const parsed = JSON.parse(trimmed);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is CustomModelConfig => {
			return !!item && typeof item.id === "string" && typeof item.model === "string";
		});
	} catch {
		return [];
	}
}

function parsePromptPresets(raw: string): PromptPreset[] {
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

export class LLMBlocksSettingTab extends PluginSettingTab {
	plugin: LLMBlocksPlugin;

	constructor(app: App, plugin: LLMBlocksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Connection + auth status
		const statusDiv = containerEl.createDiv({ cls: "llm-settings-status" });
		const connState = this.plugin.wsClient.connectionState;
		const authState = this.plugin.wsClient.authState;
		const allowDirectMode = this.plugin.settings.allowDirectMode;
		const customModels = parseCustomModels(this.plugin.settings.customModelsJson);
		const promptPresets = parsePromptPresets(this.plugin.settings.promptPresetsJson);
		const activeCustom = customModels.find((m) => m.id === this.plugin.settings.activeModelId) ?? null;
		const usingCustomModel = !!activeCustom;
		const connDot =
			connState === "connected" ? "llm-dot-green" :
			connState === "connecting" ? "llm-dot-yellow" :
			"llm-dot-red";
		statusDiv.createSpan({ cls: `llm-dot ${connDot}` });
		statusDiv.createSpan({ text: ` Connection: ${connState}` });
		statusDiv.createEl("br");
		statusDiv.createSpan({ text: ` Transport: ${allowDirectMode ? "direct API" : "websocket"} ` });
		if (usingCustomModel) {
			statusDiv.createEl("br");
			statusDiv.createSpan({ text: ` Active custom model: ${activeCustom.displayName ?? activeCustom.id}` });
		}

		if (connState === "connected") {
			const authDot =
				authState === "authenticated" ? "llm-dot-green" :
				authState === "unauthenticated" ? "llm-dot-red" :
				"llm-dot-yellow";
			statusDiv.createEl("br");
			statusDiv.createSpan({ cls: `llm-dot ${authDot}` });
			statusDiv.createSpan({ text: ` Auth: ${authState}` });
		}

		// Connection settings
		containerEl.createEl("h3", { text: "Connection" });

		new Setting(containerEl)
			.setName("Enable direct API mode")
			.setDesc("When enabled, queries call provider APIs directly using model/provider settings below (bypasses websocket)")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.allowDirectMode)
					.onChange(async (value) => {
						this.plugin.settings.allowDirectMode = value;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("WebSocket endpoint")
			.setDesc("Codex app-server WebSocket endpoint (used when direct API mode is disabled)")
			.addText((text) =>
				text
					.setPlaceholder("ws://127.0.0.1:4500")
					.setValue(this.plugin.settings.wsEndpoint)
					.onChange(async (value) => {
						this.plugin.settings.wsEndpoint = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-reconnect")
			.setDesc("Automatically reconnect on disconnection")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoReconnect)
					.onChange(async (value) => {
						this.plugin.settings.autoReconnect = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Reconnect now")
			.setDesc("Reconnect websocket mode")
			.addButton((btn) =>
				btn.setButtonText("Reconnect").onClick(() => {
					this.plugin.wsClient.disconnect();
					this.plugin.wsClient.connect();
					setTimeout(() => this.display(), 1500);
				})
			);

		// Custom model profiles
		containerEl.createEl("h3", { text: "Custom Models" });

		new Setting(containerEl)
			.setName("Custom models JSON")
			.setDesc("Paste an array of model configs. Fields: id, displayName, provider, baseUrl, apiKey, model, maxOutputTokens")
			.addTextArea((text) => {
				text
					.setPlaceholder('[{"id":"custom:model-1","provider":"anthropic","baseUrl":"https://api.example.com/anthropic","apiKey":"...","model":"ModelName","maxOutputTokens":64000}]')
					.setValue(this.plugin.settings.customModelsJson)
					.onChange(async (value) => {
						this.plugin.settings.customModelsJson = value;
						await this.plugin.saveSettings();
						this.display();
					});
				text.inputEl.rows = 8;
				text.inputEl.cols = 80;
			});

		if (this.plugin.settings.customModelsJson.trim() && customModels.length === 0) {
			new Setting(containerEl)
				.setName("Custom models JSON status")
				.setDesc("Could not parse JSON. Fix JSON syntax to enable profile switching.");
		}

		new Setting(containerEl)
			.setName("Active custom model")
			.setDesc("If selected, plugin uses this model/provider directly and bypasses websocket")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "(none)");
				for (const model of customModels) {
					dropdown.addOption(model.id, model.displayName ?? model.id);
				}
				dropdown
					.setValue(this.plugin.settings.activeModelId)
					.onChange(async (value) => {
						this.plugin.settings.activeModelId = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		// Prompt presets
		containerEl.createEl("h3", { text: "Prompt Presets" });

		new Setting(containerEl)
			.setName("Prompt presets JSON")
			.setDesc("Optional templates callable from <llm-{id}>...</llm-{id}> or @call <id> in ```llm blocks")
			.addTextArea((text) => {
				text
					.setPlaceholder('[{"id":"summarize","label":"Summarize","prompt":"Summarize the content below into bullet points."}]')
					.setValue(this.plugin.settings.promptPresetsJson)
					.onChange(async (value) => {
						this.plugin.settings.promptPresetsJson = value;
						await this.plugin.saveSettings();
						this.display();
					});
				text.inputEl.rows = 8;
				text.inputEl.cols = 80;
			});

		if (this.plugin.settings.promptPresetsJson.trim() && promptPresets.length === 0) {
			new Setting(containerEl)
				.setName("Prompt presets JSON status")
				.setDesc("Could not parse JSON. Fix syntax and ensure each item has id + prompt.");
		}

		// Auth settings
		containerEl.createEl("h3", { text: "Authentication" });

		new Setting(containerEl)
			.setName("Default API key")
			.setDesc("Used for direct API mode when active custom model has no apiKey")
			.addText((text) => {
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		if (
			authState === "unauthenticated" &&
			connState === "connected" &&
			!this.plugin.settings.apiKey.trim() &&
			!usingCustomModel &&
			!allowDirectMode
		) {
			new Setting(containerEl)
				.setName("Login with ChatGPT")
				.setDesc("Opens a browser window to authenticate with your ChatGPT account")
				.addButton((btn) =>
					btn.setButtonText("Login with ChatGPT").setCta().onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText("Opening browser...");
						try {
							const url = await this.plugin.wsClient.loginChatGPT();
							window.open(url);
							btn.setButtonText("Waiting for login...");
							// Auth change event will refresh settings tab
						} catch (e) {
							btn.setButtonText("Login failed - retry");
							btn.setDisabled(false);
						}
					})
				);
		}

		// Model settings
		containerEl.createEl("h3", { text: "Model" });

		new Setting(containerEl)
			.setName("Default provider")
			.setDesc("Direct API provider used when no active custom model is selected")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("openai", "OpenAI-compatible")
					.addOption("anthropic", "Anthropic-compatible")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as "openai" | "anthropic";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default base URL")
			.setDesc("Examples: https://api.openai.com or https://api.minimax.io/anthropic")
			.addText((text) =>
				text
					.setPlaceholder("https://api.openai.com")
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default model")
			.setDesc("Used for direct mode when no active custom model is selected")
			.addText((text) =>
				text
					.setPlaceholder("gpt-4.1-mini")
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max output tokens")
			.setDesc("Used for direct API calls")
			.addText((text) =>
				text
					.setPlaceholder("4096")
					.setValue(String(this.plugin.settings.maxOutputTokens))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings.maxOutputTokens = Math.floor(parsed);
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Sampling temperature (0.0 - 2.0)")
			.addSlider((slider) =>
				slider
					.setLimits(0, 2, 0.1)
					.setValue(this.plugin.settings.temperature)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.temperature = value;
						await this.plugin.saveSettings();
					})
			);

		// Cache
		containerEl.createEl("h3", { text: "Cache" });

		new Setting(containerEl)
			.setName("Clear response cache")
			.setDesc(`${this.plugin.cache.size} cached responses`)
			.addButton((btn) =>
				btn.setButtonText("Clear cache").onClick(() => {
					this.plugin.cache.clear();
					this.display();
				})
			);
	}
}
