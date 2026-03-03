import { Events } from "obsidian";
import {
	AuthState,
	ConnectionState,
	CustomModelConfig,
	JsonRpcRequest,
	JsonRpcResponse,
	LLMBlocksSettings,
	LLMProvider,
	QueryResult,
} from "./types";
import { NodeWebSocket } from "./node-websocket";

interface ActiveTurn {
	resolve: (result: QueryResult) => void;
	reject: (e: Error) => void;
	chunks: string[];
	modelHint: string;
}

interface DirectConfig {
	provider: LLMProvider;
	baseUrl: string;
	apiKey: string;
	model: string;
	maxOutputTokens: number;
}

interface QueryOptions {
	threadId?: string;
	directConfig?: DirectConfig;
}

export class CodexWebSocketClient extends Events {
	private ws: NodeWebSocket | null = null;
	private state: ConnectionState = "disconnected";
	private auth: AuthState = "unchecked";
	private rpcId = 0;
	private pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private sessionReady = false;
	private lastError = "";
	private activeTurns = new Map<string, ActiveTurn>();

	constructor(private settings: LLMBlocksSettings) {
		super();
	}

	get connectionState(): ConnectionState { return this.state; }
	get authState(): AuthState { return this.auth; }
	get lastErrorMessage(): string { return this.lastError; }

	get isReady(): boolean {
		return this.state === "connected" && this.sessionReady && this.auth === "authenticated";
	}

	connect(): void {
		const direct = this.getDirectConfig();
		if (direct) {
			this.sessionReady = true;
			this.setAuth(direct.apiKey ? "authenticated" : "unauthenticated");
			this.setState("connected");
			return;
		}

		if (this.ws && (this.ws.readyState === NodeWebSocket.OPEN || this.ws.readyState === NodeWebSocket.CONNECTING)) {
			return;
		}

		this.setState("connecting");
		this.setAuth("unchecked");
		this.sessionReady = false;
		this.lastError = "";
		const endpoints = this.connectionCandidates();
		this.connectToCandidate(endpoints, 0);
	}

	disconnect(): void {
		this.clearReconnect();
		this.sessionReady = false;
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.close();
			this.ws = null;
		}
		this.rejectAllPending("Disconnected");
		this.setState("disconnected");
		this.setAuth("unchecked");
	}

	updateSettings(settings: LLMBlocksSettings): void {
		const normalized = this.normalizeEndpoint(settings.wsEndpoint);
		this.settings = { ...settings, wsEndpoint: normalized };
		this.disconnect();
		this.connect();
	}

	async loginApiKey(apiKey: string): Promise<void> {
		this.settings.apiKey = apiKey;
		const direct = this.getDirectConfig();
		if (direct) {
			this.sessionReady = true;
			this.setAuth("authenticated");
			this.setState("connected");
			return;
		}

		await this.rpcCall("account/login/start", { type: "apiKey", apiKey });
		this.setAuth("authenticated");
	}

	async loginChatGPT(): Promise<string> {
		if (this.getDirectConfig()) {
			throw new Error("ChatGPT login is disabled while direct model mode is active.");
		}
		const result = await this.rpcCall("account/login/start", { type: "chatgpt" }) as
			{ authUrl?: string; type?: string } | null;
		if (!result?.authUrl) {
			throw new Error("Server did not return an auth URL");
		}
		return result.authUrl;
	}

	async query(prompt: string, options?: QueryOptions): Promise<QueryResult> {
		if (options?.directConfig) {
			return this.queryViaDirectApi(prompt, options.directConfig, options);
		}

		const direct = this.getDirectConfig();
		if (direct) {
			return this.queryViaDirectApi(prompt, direct, options);
		}

		if (!this.isReady) {
			throw new Error(
				this.auth === "unauthenticated"
					? "Not logged in. Configure an API key or click Login in settings."
					: "Not connected to Codex server"
			);
		}

		const requestedModel = (this.settings.model ?? "").trim();
		let threadId = (options?.threadId ?? "").trim();
		let modelHint = this.resolveModelName(requestedModel);
		if (!threadId) {
			const threadResult = await this.rpcCall("thread/start", {
				...(this.settings.model ? { model: this.settings.model } : {}),
			}) as { thread?: { id?: string; model?: string } } | null;
			threadId = threadResult?.thread?.id ?? "";
			if (!threadId) throw new Error("Server did not return a thread ID");
			modelHint = this.resolveModelName(threadResult?.thread?.model, requestedModel);
		}

		const turnPromise = new Promise<QueryResult>((resolve, reject) => {
			this.activeTurns.set(threadId, { resolve, reject, chunks: [], modelHint });
		});

		const turnParams: Record<string, unknown> = {
			threadId,
			input: [{ type: "text", text: prompt }],
		};
		if (this.settings.model) turnParams.model = this.settings.model;

		await this.rpcCall("turn/start", turnParams);

		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Query timed out after 120s")), 120_000)
		);

		try {
			return await Promise.race([turnPromise, timeout]);
		} finally {
			this.activeTurns.delete(threadId);
		}
	}

	private async queryViaDirectApi(prompt: string, cfg: DirectConfig, options?: QueryOptions): Promise<QueryResult> {
		if (!cfg.apiKey.trim()) {
			throw new Error("Missing API key for active direct model.");
		}
		if (!cfg.model.trim()) {
			throw new Error("Missing model for active direct mode.");
		}
		if (cfg.provider === "anthropic") {
			return this.queryViaAnthropicCompatible(prompt, cfg, options);
		}
		return this.queryViaOpenAICompatible(prompt, cfg, options);
	}

	private async queryViaOpenAICompatible(prompt: string, cfg: DirectConfig, options?: QueryOptions): Promise<QueryResult> {
		const endpoint = this.resolveEndpoint(cfg.baseUrl || "https://api.openai.com", "/v1/responses");
		const body: Record<string, unknown> = {
			model: cfg.model || "gpt-4.1-mini",
			input: prompt,
			temperature: this.settings.temperature,
			max_output_tokens: cfg.maxOutputTokens,
		};

		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`OpenAI-compatible API error ${response.status}: ${text}`);
		}
		const payload = await response.json() as unknown;
		const text = this.extractText(payload);
		if (!text) {
			throw new Error("No text returned by OpenAI-compatible response.");
		}
		return { text, model: (cfg.model || "openai-compatible").trim(), threadId: options?.threadId };
	}

	private async queryViaAnthropicCompatible(prompt: string, cfg: DirectConfig, options?: QueryOptions): Promise<QueryResult> {
		const endpoint = this.resolveEndpoint(cfg.baseUrl || "https://api.anthropic.com", "/v1/messages");
		const body: Record<string, unknown> = {
			model: cfg.model,
			max_tokens: cfg.maxOutputTokens,
			temperature: this.settings.temperature,
			messages: [{ role: "user", content: prompt }],
		};

		type HeaderSet = Record<string, string>;
		const headerAttempts: HeaderSet[] = [
			{
				"Content-Type": "application/json",
				"x-api-key": cfg.apiKey,
				"anthropic-version": "2023-06-01",
			},
			{
				"Content-Type": "application/json",
				Authorization: `Bearer ${cfg.apiKey}`,
				"anthropic-version": "2023-06-01",
			},
			{
				"Content-Type": "application/json",
				"x-api-key": cfg.apiKey,
				Authorization: `Bearer ${cfg.apiKey}`,
				"anthropic-version": "2023-06-01",
			},
		];

		let lastError = "Unknown Anthropic-compatible request error";
		for (const headers of headerAttempts) {
			try {
				const response = await fetch(endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				});

				if (!response.ok) {
					const text = await response.text();
					lastError = `Anthropic-compatible API error ${response.status}: ${text}`;
					continue;
				}

				const payload = await response.json() as unknown;
				const text = this.extractText(payload);
				if (!text) {
					lastError = "No text returned by Anthropic-compatible response.";
					continue;
				}
					return { text, model: (cfg.model || "anthropic-compatible").trim(), threadId: options?.threadId };
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
			}
		}

		throw new Error(lastError);
	}

	private setState(state: ConnectionState): void {
		if (this.state !== state) {
			this.state = state;
			this.trigger("state-change", state);
		}
	}

	private setAuth(auth: AuthState): void {
		if (this.auth !== auth) {
			this.auth = auth;
			this.trigger("auth-change", auth);
		}
	}

	private nextId(): string {
		return String(++this.rpcId);
	}

	private rpcCall(method: string, params?: Record<string, unknown>): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== NodeWebSocket.OPEN) {
				reject(new Error("WebSocket not open"));
				return;
			}
			const id = this.nextId();
			this.pendingRpc.set(id, { resolve, reject });
			const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
			this.ws.send(JSON.stringify(msg));

			setTimeout(() => {
				if (this.pendingRpc.has(id)) {
					this.pendingRpc.delete(id);
					reject(new Error(`RPC call '${method}' timed out`));
				}
			}, 30_000);
		});
	}

	private rpcNotify(method: string, params?: Record<string, unknown>): void {
		if (!this.ws || this.ws.readyState !== NodeWebSocket.OPEN) return;
		this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
	}

	private async handshake(): Promise<void> {
		try {
			console.info("LLM Blocks: handshake start");
			await this.rpcCall("initialize", {
				protocolVersion: "2025-03-26",
				clientInfo: { name: "obsidian-llm-blocks", version: "0.1.0" },
				capabilities: {},
			});
			this.rpcNotify("initialized", {});
			this.sessionReady = true;
			this.reconnectAttempts = 0;
			this.setState("connected");
			console.info("LLM Blocks: handshake success");
			await this.checkAndApplyAuth();
		} catch (e) {
			this.lastError = e instanceof Error ? e.message : String(e);
			console.error("LLM Blocks: handshake failed", e);
			this.setState("error");
		}
	}

	private async checkAndApplyAuth(): Promise<void> {
		try {
			const result = await this.rpcCall("account/read", {}) as
				{ requiresOpenaiAuth?: boolean; account?: { type?: string } } | null;

			if (result?.account) {
				this.setAuth("authenticated");
				return;
			}

			if (this.settings.apiKey) {
				await this.loginApiKey(this.settings.apiKey);
				return;
			}

			this.setAuth("unauthenticated");
		} catch {
			if (this.settings.apiKey) {
				try {
					await this.loginApiKey(this.settings.apiKey);
					return;
				} catch {
					// fall through
				}
			}
			this.setAuth("unauthenticated");
		}
	}

	private handleMessage(raw: string): void {
		let msg: JsonRpcResponse;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.id && this.pendingRpc.has(String(msg.id))) {
			const pending = this.pendingRpc.get(String(msg.id))!;
			this.pendingRpc.delete(String(msg.id));
			if (msg.error) {
				pending.reject(new Error(msg.error.message));
			} else {
				pending.resolve(msg.result);
			}
			return;
		}

		if (msg.method) {
			this.handleNotification(msg.method, (msg.params ?? {}) as Record<string, unknown>);
		}
	}

	private handleNotification(method: string, params: Record<string, unknown>): void {
		const threadId = params.threadId as string | undefined;

		switch (method) {
			case "account/login/completed": {
				const success = params.success as boolean | undefined;
				if (success) {
					this.setAuth("authenticated");
					this.trigger("login-completed", true);
				} else {
					this.trigger("login-completed", false);
				}
				break;
			}
			case "item/agentMessage/delta": {
				const delta = (params.delta as string) ?? "";
				if (threadId && this.activeTurns.has(threadId)) {
					this.activeTurns.get(threadId)!.chunks.push(delta);
				}
				this.trigger("delta", delta);
				break;
			}
			case "turn/completed": {
				if (!threadId || !this.activeTurns.has(threadId)) break;
				const turn = this.activeTurns.get(threadId)!;
				const turnObj = params.turn as {
					status?: string;
					error?: { message?: string };
					model?: string;
					modelName?: string;
				} | undefined;
				if (turnObj?.status === "failed") {
					turn.reject(new Error(turnObj.error?.message ?? "Turn failed"));
					} else {
						const resolvedModel = this.resolveModelName(
							turnObj?.model,
							turnObj?.modelName,
							turn.modelHint,
							this.settings.model,
						);
						turn.resolve({
							text: turn.chunks.join(""),
							model: resolvedModel,
							threadId,
						});
					}
					break;
				}
		}
	}

	private rejectAllPending(reason: string): void {
		for (const [, p] of this.pendingRpc) p.reject(new Error(reason));
		this.pendingRpc.clear();
		for (const [, t] of this.activeTurns) t.reject(new Error(reason));
		this.activeTurns.clear();
	}

	private scheduleReconnect(): void {
		if (!this.settings.autoReconnect) return;
		const maxAttempts = this.settings.maxReconnectAttempts;
		const unlimited = maxAttempts <= 0;
		if (!unlimited && this.reconnectAttempts >= maxAttempts) return;
		this.clearReconnect();
		const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private connectionCandidates(): string[] {
		const primary = this.normalizeEndpoint(this.settings.wsEndpoint);
		this.settings.wsEndpoint = primary;
		const fallbacks = [
			"wss://codex-appserver.tail1b8705.ts.net",
			"ws://127.0.0.1:4500",
			"ws://localhost:4500",
			"ws://127.0.0.1:9001",
			"ws://100.113.69.98:4500",
		];
		const merged = [primary, ...fallbacks];
		const seen = new Set<string>();
		const deduped: string[] = [];
		for (const endpoint of merged) {
			const normalized = this.normalizeEndpoint(endpoint);
			if (!normalized || seen.has(normalized)) continue;
			seen.add(normalized);
			deduped.push(normalized);
		}
		return deduped;
	}

	private connectToCandidate(candidates: string[], index: number): void {
		if (index >= candidates.length) {
			this.lastError = "no reachable websocket endpoint";
			this.setState("error");
			this.scheduleReconnect();
			return;
		}

		const endpoint = candidates[index];
		let opened = false;
		let advanced = false;
		let ws: NodeWebSocket;
		try {
			ws = new NodeWebSocket(endpoint);
		} catch {
			this.connectToCandidate(candidates, index + 1);
			return;
		}

		this.ws = ws;
		console.info(`LLM Blocks: attempting websocket ${endpoint}`);

		const advance = () => {
			if (advanced) return;
			advanced = true;
			try {
				ws.onopen = null;
				ws.onmessage = null;
				ws.onclose = null;
				ws.onerror = null;
				ws.close();
			} catch {
				// noop
			}
			this.connectToCandidate(candidates, index + 1);
		};

		ws.onopen = () => {
			opened = true;
			console.info(`LLM Blocks: websocket open ${endpoint}`);
			this.settings.wsEndpoint = endpoint;
			this.ws = ws;
			this.handshake();
		};

		ws.onmessage = (event) => {
			this.handleMessage(event.data as string);
		};

		ws.onclose = (event) => {
			console.warn(
				`LLM Blocks: websocket close ${endpoint} code=${event.code} reason=${event.reason || "(none)"} opened=${opened}`
			);
			if (!opened && index + 1 < candidates.length) {
				advance();
				return;
			}
			this.sessionReady = false;
			this.setAuth("unchecked");
			this.lastError = `close code=${event.code}${event.reason ? ` reason=${event.reason}` : ""}`;
			this.setState("disconnected");
			this.rejectAllPending("Connection closed");
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			console.warn(`LLM Blocks: websocket error ${endpoint} opened=${opened}`);
			this.lastError = `websocket error (${endpoint})`;
			if (!opened && index + 1 < candidates.length) {
				advance();
				return;
			}
			this.setState("error");
			try { ws.close(); } catch { /* noop */ }
		};
	}

	private normalizeEndpoint(endpoint: string): string {
		const trimmed = endpoint.trim();
		if (!trimmed) return "ws://127.0.0.1:4500";
		if (/^ws:\/\/(127\.0\.0\.1|localhost):(9001|4510)\/?$/i.test(trimmed)) {
			return "ws://127.0.0.1:4500";
		}
		return trimmed;
	}

	private parseCustomModels(raw: string): CustomModelConfig[] {
		const trimmed = (raw ?? "").trim();
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

	private getActiveCustomModel(): CustomModelConfig | null {
		const id = (this.settings.activeModelId ?? "").trim();
		if (!id) return null;
		const models = this.parseCustomModels(this.settings.customModelsJson);
		return models.find((m) => m.id === id) ?? null;
	}

	private getDirectConfig(): DirectConfig | null {
		if (!this.settings.allowDirectMode) return null;

		const activeCustom = this.getActiveCustomModel();
		const provider = activeCustom?.provider ?? this.settings.provider;
		const baseUrl = (activeCustom?.baseUrl ?? this.settings.baseUrl).trim();
		const apiKey = (activeCustom?.apiKey ?? this.settings.apiKey).trim();
		const model =
			(activeCustom?.model ?? this.settings.model).trim() ||
			(provider === "openai" ? "gpt-4.1-mini" : "");
		const maxTokensCandidate = activeCustom?.maxOutputTokens ?? this.settings.maxOutputTokens;
		const maxOutputTokens = Number.isFinite(maxTokensCandidate) && maxTokensCandidate > 0
			? Math.floor(maxTokensCandidate)
			: this.settings.maxOutputTokens;

		return {
			provider,
			baseUrl,
			apiKey,
			model,
			maxOutputTokens,
		};
	}

	private resolveEndpoint(baseUrl: string, suffixPath: string): string {
		const trimmed = (baseUrl ?? "").trim();
		if (!trimmed) {
			if (suffixPath === "/v1/messages") return "https://api.anthropic.com/v1/messages";
			return "https://api.openai.com/v1/responses";
		}
		if (trimmed.endsWith("/v1/messages") || trimmed.endsWith("/v1/responses")) {
			return trimmed;
		}
		return `${trimmed.replace(/\/+$/, "")}${suffixPath}`;
	}

	private extractText(payload: unknown): string {
		const p = payload as Record<string, unknown>;

		if (typeof p.output_text === "string" && p.output_text.trim()) {
			return p.output_text.trim();
		}

		if (Array.isArray(p.output)) {
			const text = p.output
				.flatMap((item) => {
					const content = (item as { content?: unknown }).content;
					return Array.isArray(content) ? content : [];
				})
				.map((item) => {
					if (typeof item === "string") return item;
					const type = (item as { type?: unknown }).type;
					const text = (item as { text?: unknown }).text;
					if ((type === "output_text" || type === "text") && typeof text === "string") {
						return text;
					}
					return "";
				})
				.join("")
				.trim();
			if (text) return text;
		}

		if (Array.isArray(p.content)) {
			const text = p.content
				.map((item) => {
					if (typeof item === "string") return item;
					const type = (item as { type?: unknown }).type;
					const text = (item as { text?: unknown }).text;
					if ((type === "text" || type === "output_text") && typeof text === "string") {
						return text;
					}
					return "";
				})
				.join("")
				.trim();
			if (text) return text;
		}

		if (Array.isArray(p.choices)) {
			const text = p.choices
				.map((choice) => {
					const message = (choice as { message?: { content?: unknown } }).message;
					if (!message) return "";
					if (typeof message.content === "string") return message.content;
					if (!Array.isArray(message.content)) return "";
					return message.content
						.map((part) => {
							if (typeof part === "string") return part;
							if (typeof (part as { text?: unknown }).text === "string") {
								return (part as { text: string }).text;
							}
							return "";
						})
						.join("");
				})
				.join("")
				.trim();
			if (text) return text;
		}

		return "";
	}

	private resolveModelName(...candidates: Array<string | undefined>): string {
		for (const candidate of candidates) {
			const value = (candidate ?? "").trim();
			if (value) return value;
		}
		return "server default";
	}
}
