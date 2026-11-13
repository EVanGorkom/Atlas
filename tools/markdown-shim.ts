/**
 * Stands in for the `obsidian` module when the conversion pipeline runs outside Obsidian
 * (the dump converter). Its htmlToMarkdown is Turndown set up to behave like Obsidian's
 * own converter, as measured in Obsidian 1.15:
 *   - nothing is escaped ("# comment" in text stays as written);
 *   - every table becomes a Markdown table, whatever its shape: the first row is the
 *     header, block content inside a cell is joined with <br>, and pipes are escaped.
 */
import TurndownService from "turndown";

const turndown = new TurndownService({
	headingStyle: "atx",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
	emDelimiter: "*",
	strongDelimiter: "**",
	hr: "---",
});
turndown.escape = (text: string) => text;

turndown.addRule("strikethrough", {
	filter: ["del", "s"],
	replacement: (content) => `~~${content}~~`,
});

turndown.addRule("table", {
	filter: "table",
	replacement: (_content, node) => `\n\n${markdownTable(node as HTMLTableElement)}\n\n`,
});

function markdownTable(table: HTMLTableElement): string {
	const rows = Array.from(table.rows).map((row) =>
		Array.from(row.cells).map((cell) =>
			turndown
				.turndown(cell.innerHTML)
				.trim()
				.replace(/\n+/g, "<br>")
				.replace(/(?<!\\)\|/g, "\\|"),
		),
	);
	if (!rows.length) return "";
	const width = Math.max(...rows.map((cells) => cells.length));
	const line = (cells: string[]) => `|${Array.from({ length: width }, (_, i) => cells[i] || "   ").join("|")}|`;
	const firstIsHeader = Array.from(table.rows[0].cells).every((cell) => cell.tagName === "TH");
	const header = firstIsHeader ? rows.shift()! : [];
	return [line(header), `|${Array(width).fill("---").join("|")}|`, ...rows.map(line)].join("\n");
}

export function htmlToMarkdown(html: string | HTMLElement): string {
	return turndown.turndown(typeof html === "string" ? html : html.outerHTML);
}

export function normalizePath(path: string): string {
	const p = path.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
	return p === "" ? "/" : p;
}

// src/settings.ts imports these for its settings tab; the converter only needs DEFAULT_SETTINGS.
export class PluginSettingTab {}
export class Setting {}
