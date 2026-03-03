import { App, TFile } from "obsidian";
import type { ScopeDirective } from "./types";
import type { VaultEmbeddings } from "./embeddings";

/**
 * Resolve the scope directive by augmenting the prompt with additional context.
 *
 * - "prompt"  → prompt unchanged
 * - "file"    → current file content + separator + prompt
 * - "linked"  → [[links]] in prompt replaced with referenced file contents
 * - "vault"   → top-K semantically similar files + separator + prompt
 */
export async function resolveScope(
	app: App,
	sourcePath: string,
	prompt: string,
	scope: ScopeDirective,
	embeddings?: VaultEmbeddings | null,
): Promise<string> {
	switch (scope) {
		case "prompt":
			return prompt;
		case "file":
			return resolveFileScope(app, sourcePath, prompt);
		case "linked":
			return resolveLinkedScope(app, sourcePath, prompt);
		case "vault":
			return resolveVaultScope(app, prompt, embeddings);
	}
}

async function resolveFileScope(
	app: App,
	sourcePath: string,
	prompt: string,
): Promise<string> {
	const file = app.vault.getAbstractFileByPath(sourcePath);
	if (!(file instanceof TFile)) return prompt;
	const content = await app.vault.cachedRead(file);
	return `${content}\n\n---\n\n${prompt}`;
}

async function resolveLinkedScope(
	app: App,
	sourcePath: string,
	prompt: string,
): Promise<string> {
	// Match [[file]] and [[file|alias]] patterns
	const linkPattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
	const matches = [...prompt.matchAll(linkPattern)];

	if (matches.length === 0) return prompt;

	// Process in reverse order to preserve string positions
	let result = prompt;
	for (let i = matches.length - 1; i >= 0; i--) {
		const match = matches[i];
		const linkpath = match[1].trim();
		const fullMatch = match[0];
		const startIdx = match.index!;

		const linkedFile = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		if (linkedFile && linkedFile instanceof TFile) {
			const content = await app.vault.cachedRead(linkedFile);
			result =
				result.slice(0, startIdx) +
				content +
				result.slice(startIdx + fullMatch.length);
		} else {
			console.warn(`LLM Blocks: could not resolve link [[${linkpath}]]`);
		}
	}

	return result;
}

async function resolveVaultScope(
	app: App,
	prompt: string,
	embeddings?: VaultEmbeddings | null,
): Promise<string> {
	if (!embeddings) {
		console.warn("LLM Blocks: @vault scope requires embeddings (not initialized)");
		return prompt;
	}

	const results = await embeddings.search(prompt, 5);
	if (results.length === 0) return prompt;

	const contextBlocks: string[] = [];
	for (const result of results) {
		const file = app.vault.getAbstractFileByPath(result.path);
		if (file instanceof TFile) {
			const content = await app.vault.cachedRead(file);
			contextBlocks.push(`--- File: ${result.path} ---\n${content}`);
		}
	}

	if (contextBlocks.length === 0) return prompt;
	return `${contextBlocks.join("\n\n")}\n\n---\n\n${prompt}`;
}
