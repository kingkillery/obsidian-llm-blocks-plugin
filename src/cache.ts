import { CachedResponse } from "./types";

export class ResponseCache {
	private cache = new Map<string, CachedResponse>();

	async hashPrompt(prompt: string): Promise<string> {
		const encoded = new TextEncoder().encode(prompt.trim());
		const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	async get(prompt: string): Promise<CachedResponse | undefined> {
		const key = await this.hashPrompt(prompt);
		return this.cache.get(key);
	}

	async set(prompt: string, markdown: string): Promise<void> {
		const key = await this.hashPrompt(prompt);
		this.cache.set(key, { markdown, timestamp: Date.now() });
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}
