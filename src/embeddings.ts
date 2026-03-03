import { App } from "obsidian";

/**
 * Stub — @vault semantic search is disabled (requires @huggingface/transformers).
 * Using @vault scope falls back to returning the prompt unchanged.
 */
export class VaultEmbeddings {
	constructor(_app: App) {}

	async search(_query: string, _topK = 5): Promise<{ path: string; score: number }[]> {
		return [];
	}

	dispose(): void {}
}
