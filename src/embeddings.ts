import { App, TFile, TAbstractFile, EventRef } from "obsidian";

/**
 * Vault-wide semantic embeddings using Transformers.js.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (~23MB ONNX, 384-dim, fast)
 *
 * Created lazily on first @vault use — does NOT load at plugin startup.
 * Downloads the model on first use and caches it via the browser cache.
 * Indexes all .md files in the vault (first ~500 tokens each).
 */
export class VaultEmbeddings {
	private app: App;
	private vectors: Map<string, Float32Array> = new Map();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private embedder: any = null;
	private initialized = false;
	private initializing = false;
	private eventRefs: EventRef[] = [];

	constructor(app: App) {
		this.app = app;
	}

	async initialize(): Promise<void> {
		if (this.initialized || this.initializing) return;
		this.initializing = true;

		try {
			// Dynamic import — the library is bundled but only loaded here
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const transformers: any = await import("@huggingface/transformers");

			// Configure environment
			if (transformers.env) {
				transformers.env.allowLocalModels = false;
				transformers.env.useBrowserCache = true;
			}

			// Create the feature-extraction pipeline
			this.embedder = await transformers.pipeline(
				"feature-extraction",
				"Xenova/all-MiniLM-L6-v2",
			);

			// Index all markdown files
			await this.indexVault();

			// Listen for vault events to keep index current
			this.registerVaultEvents();

			this.initialized = true;
		} catch (e) {
			console.error("LLM Blocks: failed to initialize vault embeddings", e);
			throw e;
		} finally {
			this.initializing = false;
		}
	}

	async search(
		query: string,
		topK: number = 5,
	): Promise<{ path: string; score: number }[]> {
		if (!this.initialized) {
			await this.initialize();
		}

		const queryEmbedding = await this.embed(query);
		const scores: { path: string; score: number }[] = [];

		for (const [path, vector] of this.vectors) {
			const score = cosineSimilarity(queryEmbedding, vector);
			scores.push({ path, score });
		}

		scores.sort((a, b) => b.score - a.score);
		return scores.slice(0, topK);
	}

	async updateFile(path: string): Promise<void> {
		if (!this.initialized) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile) || file.extension !== "md") return;

		const content = await this.app.vault.cachedRead(file);
		const truncated = truncateToTokens(content, 500);
		const embedding = await this.embed(truncated);
		this.vectors.set(path, embedding);
	}

	removeFile(path: string): void {
		this.vectors.delete(path);
	}

	dispose(): void {
		for (const ref of this.eventRefs) {
			this.app.vault.offref(ref);
		}
		this.eventRefs = [];
		this.vectors.clear();
		this.embedder = null;
		this.initialized = false;
	}

	private async indexVault(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			try {
				const content = await this.app.vault.cachedRead(file);
				const truncated = truncateToTokens(content, 500);
				const embedding = await this.embed(truncated);
				this.vectors.set(file.path, embedding);
			} catch (e) {
				console.warn(`LLM Blocks: failed to embed ${file.path}`, e);
			}
		}
	}

	private registerVaultEvents(): void {
		const createRef = this.app.vault.on("create", (file: TAbstractFile) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.updateFile(file.path);
			}
		});

		const modifyRef = this.app.vault.on("modify", (file: TAbstractFile) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.updateFile(file.path);
			}
		});

		const deleteRef = this.app.vault.on("delete", (file: TAbstractFile) => {
			if (file instanceof TFile) {
				this.removeFile(file.path);
			}
		});

		const renameRef = this.app.vault.on(
			"rename",
			(file: TAbstractFile, oldPath: string) => {
				this.vectors.delete(oldPath);
				if (file instanceof TFile && file.extension === "md") {
					void this.updateFile(file.path);
				}
			},
		);

		this.eventRefs = [createRef, modifyRef, deleteRef, renameRef];
	}

	private async embed(text: string): Promise<Float32Array> {
		const output = await this.embedder(text, {
			pooling: "mean",
			normalize: true,
		});
		return new Float32Array(output.data);
	}
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rough truncation to approximate token count.
 * ~4 characters per token is a common heuristic.
 */
function truncateToTokens(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars);
}
