// The dump converter's stand-in for Obsidian's htmlToMarkdown must behave like the real one,
// as measured in Obsidian 1.15 (see the expectations below).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { htmlToMarkdown } from "../tools/markdown-shim";

describe("markdown-shim (Obsidian-like htmlToMarkdown)", () => {
	it("escapes nothing", () => {
		assert.equal(htmlToMarkdown("<p># not a heading [x] *y* a_b</p>"), "# not a heading [x] *y* a_b");
	});

	it("uses the first row as the header when it's all header cells", () => {
		assert.equal(
			htmlToMarkdown("<table><tr><th>Type</th><th>Example</th></tr><tr><td>str</td><td>'a'</td></tr></table>"),
			"|Type|Example|\n|---|---|\n|str|'a'|",
		);
	});

	it("writes a blank header for tables without one, like Obsidian", () => {
		assert.equal(htmlToMarkdown("<table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>"), "|   |   |\n|---|---|\n|a|b|");
	});

	it("keeps merged-cell tables as Markdown, padding short rows", () => {
		assert.equal(
			htmlToMarkdown('<table><tr><td rowspan="2">ATLASPH1X</td><td>x</td></tr><tr><td>y</td></tr></table>'),
			"|   |   |\n|---|---|\n|ATLASPH1X|x|\n|y|   |",
		);
	});

	it("joins block content in a cell with <br> and escapes stray pipes", () => {
		assert.equal(
			htmlToMarkdown("<table><tr><td><ul><li>one</li><li>two</li></ul></td><td><p>a|b</p><p>c</p></td></tr></table>"),
			"|   |   |\n|---|---|\n|-   one<br>-   two|a\\|b<br>c|",
		);
	});

	it("leaves already-escaped pipes alone", () => {
		assert.equal(htmlToMarkdown("<table><tr><td>[[Wikipedia/Ulm\\|Ulm]]</td></tr></table>"), "|   |\n|---|\n|[[Wikipedia/Ulm\\|Ulm]]|");
	});
});
