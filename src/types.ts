export type LLMProvider = "openai" | "anthropic";

export interface ProviderEntry {
	id: string;
	displayName: string;
	mode: "websocket" | "direct";
	provider: LLMProvider;
	baseUrl: string;
	apiKey: string;
	model: string;
	maxOutputTokens: number;
}

export const BUILT_IN_PROVIDERS: ProviderEntry[] = [
	{
		id: "minimax",
		displayName: "MiniMax M2.5",
		mode: "direct",
		provider: "anthropic",
		baseUrl: "https://api.minimax.io/anthropic",
		apiKey: "sk-cp-fy4T5BNLpZWeLEpMEKTFlc97cJyWJomb5IxSng2oFebJ_P4-psv54JoHzKbC5hQmMcEZhlYPTQcY3I6-RzH8MYTzcGqiTmgLzuJbA7dUS754_zbYmzsteQo",
		model: "MiniMax-M2.5-highspeed",
		maxOutputTokens: 4096,
	},
	{
		id: "zai",
		displayName: "Z.ai GLM-5",
		mode: "direct",
		provider: "anthropic",
		baseUrl: "https://api.z.ai/api/anthropic",
		apiKey: "f989b294425144a5851c978a5a8871a4.D0jL3hrwlR0jG0tv",
		model: "GLM-5",
		maxOutputTokens: 4096,
	},
	{
		id: "codex",
		displayName: "Codex App Server",
		mode: "websocket",
		provider: "openai",
		baseUrl: "",
		apiKey: "",
		model: "",
		maxOutputTokens: 20000,
	},
];

export interface CustomModelConfig {
	id: string;
	displayName?: string;
	provider?: LLMProvider;
	baseUrl?: string;
	apiKey?: string;
	model: string;
	maxOutputTokens?: number;
}

export interface PromptPreset {
	id: string;
	label?: string;
	prompt: string;
}

export interface LLMBlocksSettings {
	wsEndpoint: string;
	allowDirectMode: boolean;
	model: string;
	provider: LLMProvider;
	baseUrl: string;
	temperature: number;
	maxOutputTokens: number;
	autoReconnect: boolean;
	maxReconnectAttempts: number;
	apiKey: string;
	customModelsJson: string;
	activeModelId: string;
	promptPresetsJson: string;
	activeProviderId: string;
}

export const DEFAULT_SETTINGS: LLMBlocksSettings = {
	wsEndpoint: "ws://127.0.0.1:4500",
	allowDirectMode: false,
	model: "",
	provider: "openai",
	baseUrl: "https://api.openai.com",
	temperature: 0.7,
	maxOutputTokens: 4096,
	autoReconnect: true,
	maxReconnectAttempts: 0,
	apiKey: "",
	customModelsJson: "",
	activeModelId: "",
	promptPresetsJson: "",
	activeProviderId: "minimax",
};

export type AuthState = "unchecked" | "authenticated" | "unauthenticated";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: string;
	method?: string;
	result?: unknown;
	params?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

export interface CachedResponse {
	markdown: string;
	timestamp: number;
}

export interface QueryResult {
	text: string;
	model: string;
	threadId?: string;
}

export type WritebackDirective = "keep" | "consume";

export type ScopeDirective = "prompt" | "file" | "linked" | "vault";

export interface ParsedLLMBlock {
	directive: WritebackDirective;
	prompt: string;
	presetId: string;
	scope: ScopeDirective;
}
