declare module "@codemirror/language" {
	import { EditorState } from "@codemirror/state";
	interface SyntaxNode {
		type: { name: string };
		parent: SyntaxNode | null;
	}
	interface Tree {
		resolve(pos: number): SyntaxNode;
	}
	export function syntaxTree(state: EditorState): Tree;
}
