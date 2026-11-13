/**
 * Just enough of the `obsidian` module for the tests.
 *
 * htmlToMarkdown is approximated with Turndown, which Obsidian's converter is close to but
 * not identical with. Tests that go through it should assert on structure (fences, links,
 * headings) rather than exact output.
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
	headingStyle: "atx",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
	emDelimiter: "*",
	hr: "---",
});
turndown.use(gfm);
// Obsidian's converter escapes nothing ("# comment" in text stays a heading), so neither do we.
turndown.escape = (text: string) => text;

export function htmlToMarkdown(html: string | HTMLElement): string {
	return turndown.turndown(typeof html === "string" ? html : html.outerHTML);
}

export function normalizePath(p: string): string {
	const path = p.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
	return path === "" ? "/" : path;
}

export class TFile {}
export class Notice {}
export function stringifyYaml(value: unknown): string {
	return JSON.stringify(value);
}
export class PluginSettingTab {}
export class Setting {}
