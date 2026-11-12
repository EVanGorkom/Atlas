/**
 * Stores finished Markdown (wikilinks, math, infobox tables) behind plain-letter tokens.
 *
 * The HTML → Markdown converter escapes characters like `[`, `]`, `_` and `\`, which
 * would mangle `[[links]]` and LaTeX. So those pieces are swapped out for tokens made
 * only of letters and digits before conversion, and swapped back in afterwards.
 */
export class Placeholders {
	private readonly items: string[] = [];

	add(markdown: string): string {
		const index = this.items.push(markdown) - 1;
		return `ATLASPH${index}X`;
	}

	/** Replaces every token in `text`, including tokens nested inside other placeholders. */
	restore(text: string): string {
		let result = text;
		for (let depth = 0; depth < 5; depth++) {
			const next = result.replace(/ATLASPH(\d+)X/g, (_, i: string) => this.items[Number(i)] ?? "");
			if (next === result) break;
			result = next;
		}
		return result;
	}
}
