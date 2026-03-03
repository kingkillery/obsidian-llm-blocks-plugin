import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Editor } from "obsidian";
import { CodexWebSocketClient } from "./websocket-client";

const TEMPLATE_RE = /\{\{llm:\s*([\s\S]*?)\}\}/g;

/**
 * Returns true if the given position sits inside a fenced code block
 * according to the Lezer syntax tree Obsidian exposes.
 */
function isInsideCodeBlock(state: EditorState, pos: number): boolean {
	let node = syntaxTree(state).resolve(pos);
	while (node) {
		const name = node.type.name;
		if (name.includes("CodeBlock") || name.includes("FencedCode")) {
			return true;
		}
		if (!node.parent || node.parent === node) break;
		node = node.parent;
	}
	return false;
}

/**
 * Scan visible ranges for {{llm: prompt}} matches that are NOT inside
 * fenced code blocks. Returns Decoration widgets positioned after each match.
 */
function buildDecorations(view: EditorView): DecorationSet {
	const widgets: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.sliceDoc(from, to);
		TEMPLATE_RE.lastIndex = 0;

		let match: RegExpExecArray | null;
		while ((match = TEMPLATE_RE.exec(text)) !== null) {
			const matchStart = from + match.index;
			const matchEnd = matchStart + match[0].length;

			if (isInsideCodeBlock(view.state, matchStart)) {
				continue;
			}

			const deco = Decoration.widget({
				widget: new PlayButtonWidget(matchStart, matchEnd, match[1]),
				side: 1,
			});
			widgets.push(deco.range(matchEnd));
		}
	}

	return Decoration.set(widgets, true);
}

class PlayButtonWidget extends WidgetType {
	constructor(
		private readonly matchFrom: number,
		private readonly matchTo: number,
		private readonly prompt: string,
	) {
		super();
	}

	eq(other: PlayButtonWidget): boolean {
		return (
			this.matchFrom === other.matchFrom &&
			this.matchTo === other.matchTo &&
			this.prompt === other.prompt
		);
	}

	toDOM(): HTMLElement {
		const btn = document.createElement("button");
		btn.className = "llm-inline-play-btn";
		btn.setAttribute("aria-label", "Run LLM template");
		btn.textContent = "\u25B6";
		return btn;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

/**
 * Creates a CM6 ViewPlugin that detects `{{llm: prompt}}` patterns in the
 * editor and renders a small play-button widget beside each one. Clicking
 * the button queries the LLM and replaces the template with the response.
 */
export function createInlineTemplateExtension(
	wsClient: CodexWebSocketClient,
): ViewPlugin<any> {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view);
			}

			update(update: ViewUpdate): void {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildDecorations(update.view);
				}
			}
		},
		{
			decorations: (v) => v.decorations,

			eventHandlers: {
				mousedown(event: MouseEvent, view: EditorView) {
					const target = event.target as HTMLElement;
					if (!target.classList.contains("llm-inline-play-btn")) {
						return false;
					}

					event.preventDefault();
					event.stopPropagation();

					// Re-scan the current document text at click time to
					// avoid acting on stale positions.
					const docText = view.state.doc.toString();
					TEMPLATE_RE.lastIndex = 0;

					let clickedMatch: { from: number; to: number; prompt: string } | null = null;

					// The widget is placed at side:1 after the match end.
					// Resolve the position the widget is rendered at.
					const widgetPos = view.posAtDOM(target);

					let m: RegExpExecArray | null;
					while ((m = TEMPLATE_RE.exec(docText)) !== null) {
						const mFrom = m.index;
						const mTo = mFrom + m[0].length;
						// The widget sits right after the match, so its
						// position equals the match end.
						if (mTo === widgetPos) {
							clickedMatch = { from: mFrom, to: mTo, prompt: m[1] };
							break;
						}
					}

					if (!clickedMatch) {
						return false;
					}

					const { from, to, prompt } = clickedMatch;

					// Disable the button while the query is in-flight.
					target.setAttribute("disabled", "true");
					target.classList.add("llm-inline-play-btn--loading");

					wsClient.query(prompt).then(
						(result) => {
							view.dispatch({
								changes: { from, to, insert: result.text },
							});
						},
						(err) => {
							console.error("LLM inline template query failed:", err);
							target.removeAttribute("disabled");
							target.classList.remove("llm-inline-play-btn--loading");
						},
					);

					return true;
				},
			},
		},
	);
}

/**
 * Returns an Obsidian editor command callback that finds every
 * `{{llm: prompt}}` template in the document, queries each one
 * sequentially, and replaces them all with the LLM responses.
 */
export function createFillAllTemplatesCommand(
	wsClient: CodexWebSocketClient,
): (editor: Editor) => void {
	return async (editor: Editor) => {
		const text = editor.getValue();
		TEMPLATE_RE.lastIndex = 0;

		const matches: { from: number; to: number; prompt: string }[] = [];
		let m: RegExpExecArray | null;
		while ((m = TEMPLATE_RE.exec(text)) !== null) {
			matches.push({
				from: m.index,
				to: m.index + m[0].length,
				prompt: m[1],
			});
		}

		if (matches.length === 0) {
			return;
		}

		// Query sequentially to avoid overwhelming the API.
		const results: { from: number; to: number; text: string }[] = [];
		for (const match of matches) {
			try {
				const result = await wsClient.query(match.prompt);
				results.push({ from: match.from, to: match.to, text: result.text });
			} catch (err) {
				console.error(
					`LLM fill-all: failed to query prompt "${match.prompt.slice(0, 60)}...":`,
					err,
				);
				// Skip this match; leave the template in place.
			}
		}

		// Apply replacements from last to first so earlier positions
		// remain valid as we modify the document.
		results.reverse();
		for (const { from, to, text: replacement } of results) {
			editor.replaceRange(
				replacement,
				editor.offsetToPos(from),
				editor.offsetToPos(to),
			);
		}
	};
}
