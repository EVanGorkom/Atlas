import { htmlToMarkdown } from "obsidian";
import type { PreparedArticle } from "./clean";

/** Final step of the pipeline: HTML → Markdown, then put wikilinks, math and tables back. */
export function toMarkdown(article: PreparedArticle): string {
	const markdown = htmlToMarkdown(article.root);
	return article.placeholders
		.restore(markdown)
		// Word joiners and zero-width spaces Wikipedia uses for line-breaking control.
		.replace(/[⁠​]/g, "")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
