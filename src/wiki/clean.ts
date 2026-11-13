/**
 * Turns Wikipedia's rendered article HTML into clean HTML ready for Markdown conversion.
 *
 * Kept free of Obsidian imports so it can be tested against real articles outside
 * Obsidian. The pipeline, run by the importer:
 *
 *   1. prepareArticle   – strip page furniture, drop excluded sections, fix images and
 *                         math, and collect every article link
 *   2. (API)            – resolve those links to canonical titles, following redirects
 *   3. rewriteLinks     – article links → [[wikilinks]] into the Atlas folder; the rest → text
 *   4. convertInfoboxes – infoboxes → simple two-column Markdown tables
 *   5. (markdown.ts)    – HTML → Markdown, then restore placeholders
 */
import { MathMLToLaTeX } from "mathml-to-latex";
import { titleToFilename } from "../util/filename";
import type { ResolvedTitle } from "./api";
import { Placeholders } from "./placeholders";

export interface PreparedArticle {
	root: HTMLElement;
	/** Titles of every /wiki/ link left in the article, in document order (may repeat). */
	linkedTitles: string[];
	placeholders: Placeholders;
	host: string;
}

export interface PrepareOptions {
	/** e.g. "https://en.wikipedia.org", used to make relative URLs absolute. */
	host: string;
	/** Section headings to drop, compared case-insensitively. */
	excludedSections: string[];
}

/** Page furniture that has no place in a note. */
const JUNK_SELECTORS = [
	"style",
	"link",
	"script",
	"meta",
	".mw-editsection",
	".mw-jump-link",
	".reference", // footnote markers like [1]
	".mw-ref",
	".reflist",
	"ol.references",
	".mw-references-wrap",
	".mw-cite-backlink",
	".navbox",
	".navbox-styles",
	".vertical-navbox",
	".sidebar",
	".metadata",
	".ambox",
	".ombox",
	".tmbox",
	".hatnote", // "For other uses, see…"
	".shortdescription",
	".sistersitebox",
	".side-box",
	".portalbox",
	".noprint", // includes [citation needed] and similar
	".mw-empty-elt",
	".toc",
	"#toc",
	".printfooter",
	".catlinks",
	".authority-control",
	".navbar",
	// Text Wikipedia hides with its own stylesheet, which we don't load: sort keys,
	// microformat dates ("(1879-03-14)"), hidden infobox rows, citation maintenance notes.
	'[style*="display:none"]',
	'[style*="display: none"]',
	".infobox-hiddenrow",
	".citation-comment", // CS1 errors and maintenance messages, meant for editors
	".cs1-maint",
	".cs1-hidden-error",
	// "See list" headers of an infobox's collapsed lists ({{collapsible list}}, {{hidden begin}});
	// the lists themselves are kept, expanded.
	".infobox .collapsible-list > div:first-child:not(.mw-collapsible-content)",
	".infobox .hidden-title",
].join(", ");

export function prepareArticle(html: string, options: PrepareOptions): PreparedArticle {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const root = doc.querySelector<HTMLElement>(".mw-parser-output") ?? doc.body;
	const placeholders = new Placeholders();

	root.querySelectorAll(JUNK_SELECTORS).forEach((el) => el.remove());
	removeSections(root, new Set(options.excludedSections.map((s) => s.toLowerCase())));
	convertCodeBlocks(root, placeholders);
	convertMath(root, placeholders);
	flattenNestedTables(root);
	keepSuperAndSubscripts(root, placeholders);
	fixImages(root, options.host);

	const linkedTitles: string[] = [];
	root.querySelectorAll("a[href]").forEach((a) => {
		const link = parseWikiHref(a.getAttribute("href") ?? "");
		if (link) linkedTitles.push(link.title);
	});

	return { root, linkedTitles, placeholders, host: options.host };
}

/**
 * Replaces article links with wikilinks into `folder`, and unwraps every other internal
 * link to plain text. External links are kept, made absolute.
 *
 * Returns filename → title for linked titles whose filename differs from the title, so
 * the plugin can map an unresolved link back to its article.
 */
export function rewriteLinks(
	article: PreparedArticle,
	resolved: Map<string, ResolvedTitle>,
	folder: string,
	/** Note filename for a title; the importer passes one that avoids case collisions. */
	filenameFor: (title: string) => string = titleToFilename,
): Record<string, string> {
	const renamed: Record<string, string> = {};
	const prefix = folder && folder !== "/" ? `${folder}/` : "";
	const doc = article.root.ownerDocument;

	article.root.querySelectorAll("a").forEach((a) => {
		const href = a.getAttribute("href") ?? "";
		const wiki = parseWikiHref(href);

		if (wiki) {
			const target = resolved.get(wiki.title);
			if (!target?.isArticle) {
				unwrap(a);
				return;
			}
			const filename = filenameFor(target.title);
			if (filename !== target.title) renamed[filename] = target.title;

			const heading = cleanHeading(wiki.fragment ?? target.fragment);
			const linkpath = `${prefix}${filename}${heading ? `#${heading}` : ""}`;
			const alias = cleanAlias(a.textContent ?? "") || target.title;
			// Inside a Markdown table a bare | would end the cell.
			const separator = a.closest("table") ? "\\|" : "|";
			a.replaceWith(doc.createTextNode(article.placeholders.add(`[[${linkpath}${separator}${alias}]]`)));
			return;
		}

		if (/^(https?:)?\/\//.test(href)) {
			a.setAttribute("href", absoluteUrl(href, article.host));
			return;
		}
		// Red links (no article yet), in-page anchors, and anything else.
		unwrap(a);
	});

	return renamed;
}

/**
 * Converts each infobox into a lead image plus a two-column Markdown table.
 * Works from table structure (one or two cells per row) rather than template-specific
 * class names, so it holds up across languages and infobox templates.
 */
export function convertInfoboxes(article: PreparedArticle): void {
	const doc = article.root.ownerDocument;

	article.root.querySelectorAll("table.infobox").forEach((table) => {
		// Nested infoboxes are flattened into their parent's rows.
		if (table.parentElement?.closest("table.infobox")) return;

		const titleEl = table.querySelector(":scope > caption, .infobox-above, .infobox-title");
		const title = flatten(titleEl);
		let image: string | null = null;
		const rows: string[] = [];

		const trs = table.querySelectorAll(":scope > tbody > tr, :scope > thead > tr, :scope > tr");
		trs.forEach((tr) => {
			if (titleEl && tr.contains(titleEl)) return;
			const cells = Array.from(tr.children).filter((c) => c.tagName === "TH" || c.tagName === "TD");

			if (cells.length >= 2) {
				const label = tableCell(cells[0]);
				const value = tableCell(cells[1]);
				if (label || value) rows.push(`| **${label}** | ${value} |`);
				return;
			}
			const cell = cells[0];
			if (!cell) return;

			const img = cell.querySelector("img");
			if (img) {
				if (!image) image = imageMarkdown(img, flatten(cell.querySelector(".infobox-caption")));
				return;
			}
			const text = tableCell(cell);
			if (!text) return;
			const isHeader = cell.tagName === "TH" || /header/.test(cell.className);
			rows.push(isHeader ? `| **${text}** | |` : `| ${text} | |`);
		});

		const parts: string[] = [];
		if (image) parts.push(image);
		if (rows.length) parts.push([`| ${escapePipes(title)} | |`, "| --- | --- |", ...rows].join("\n"));

		const replacement = doc.createElement("p");
		if (parts.length) replacement.textContent = article.placeholders.add(parts.join("\n\n"));
		table.replaceWith(replacement);
	});
}

// ---------------------------------------------------------------------------

/** "/wiki/Albert_Einstein#Early_life" → { title: "Albert Einstein", fragment: "Early life" } */
export function parseWikiHref(href: string): { title: string; fragment: string | null } | null {
	if (!href.startsWith("/wiki/")) return null;
	const [pathAndQuery, hash] = splitOnce(href.slice("/wiki/".length), "#");
	const [path] = splitOnce(pathAndQuery, "?");
	const title = safeDecode(path)?.replace(/_/g, " ").trim();
	if (!title) return null;
	const fragment = hash ? (safeDecode(hash)?.replace(/_/g, " ") ?? null) : null;
	return { title, fragment };
}

/** Removes excluded sections. Handles flat output and Parsoid-style <section> wrappers. */
function removeSections(container: Element, excluded: Set<string>): void {
	if (!excluded.size) return;
	let child = container.firstElementChild;

	while (child) {
		if (child.tagName === "SECTION") {
			const first = child.firstElementChild;
			const heading = first ? headingOf(first) : null;
			const next = child.nextElementSibling;
			if (heading && excluded.has(heading.text.toLowerCase())) child.remove();
			else removeSections(child, excluded);
			child = next;
			continue;
		}

		const heading = headingOf(child);
		if (heading && excluded.has(heading.text.toLowerCase())) {
			// Drop the heading and everything up to the next heading of the same or higher level.
			let next = child.nextElementSibling;
			child.remove();
			while (next) {
				const h = headingOf(next);
				if (h && h.level <= heading.level) break;
				const after = next.nextElementSibling;
				next.remove();
				next = after;
			}
			child = next;
		} else {
			child = child.nextElementSibling;
		}
	}
}

/** Recognises both `<h2>` and the newer `<div class="mw-heading"><h2>…</h2></div>`. */
function headingOf(el: Element): { level: number; text: string } | null {
	const h = /^H[1-6]$/.test(el.tagName)
		? el
		: el.classList.contains("mw-heading")
			? el.querySelector("h1, h2, h3, h4, h5, h6")
			: null;
	if (!h) return null;
	return { level: Number(h.tagName[1]), text: (h.textContent ?? "").trim() };
}

/**
 * Wikipedia math → $inline$ / $$block$$ LaTeX, which Obsidian renders with MathJax.
 *
 * Wikipedia now serves bare MathML (`<math class="mwe-math-element">`) with no TeX source,
 * so that's converted back to LaTeX. Older markup (a wrapper span holding MathML with a TeX
 * annotation, plus a fallback image whose alt text is the TeX) is still handled.
 */
function convertMath(root: Element, placeholders: Placeholders): void {
	// Numbered equations sit in a layout table; keep the math (as display math), drop the table.
	root.querySelectorAll("table.numblk").forEach((table) => {
		const maths = Array.from(table.querySelectorAll(".mwe-math-element"));
		maths.forEach((math) => math.setAttribute("data-atlas-block", ""));
		table.replaceWith(...maths);
	});

	root.querySelectorAll(".mwe-math-element").forEach((el) => {
		if (el.parentElement?.closest(".mwe-math-element")) return; // handled with its wrapper

		const block =
			el.classList.contains("mwe-math-element-block") ||
			el.getAttribute("display") === "block" ||
			el.hasAttribute("data-atlas-block") ||
			!!el.querySelector(".mwe-math-fallback-image-display");
		const tex = texSource(el);

		const markdown = tex
			? block
				? `\n$$\n${tex}\n$$\n`
				: `$${tex}$`
			: // Couldn't get LaTeX: keep the MathML itself, which modern browsers render.
				(el.tagName.toLowerCase() === "math" ? el : el.querySelector("math"))?.outerHTML;

		if (markdown) el.replaceWith(el.ownerDocument.createTextNode(placeholders.add(markdown)));
		else el.remove();
	});
}

/** Wikipedia language names that Obsidian's highlighter knows under another name. */
const CODE_LANGUAGE_ALIASES: Record<string, string> = {
	python3: "python",
	py3: "python",
	"c++": "cpp",
	text: "",
	output: "",
	"shell-session": "shell",
	console: "shell",
};

/**
 * Code samples → fenced code blocks.
 *
 * Wikipedia's highlighted code (`<div class="mw-highlight mw-highlight-lang-python"><pre>`)
 * and plain preformatted text have no `<code>` inside the `<pre>`, so the Markdown converter
 * treats them as ordinary text: indentation collapses, and a `# comment` line turns into a
 * heading. The code is taken as plain text, so the highlighting spans go too.
 */
function convertCodeBlocks(root: Element, placeholders: Placeholders): void {
	root.querySelectorAll("pre").forEach((pre) => {
		const wrapper = pre.parentElement?.closest(".mw-highlight") ?? null;
		const langClass = /(?:^|\s)mw-highlight-lang-(\S+)/.exec(wrapper?.className ?? "")?.[1]?.toLowerCase() ?? "";
		const lang = CODE_LANGUAGE_ALIASES[langClass] ?? langClass;

		const code = (pre.textContent ?? "").replace(/\u00a0/g, " ").replace(/\s+$/, "");
		const target = wrapper && wrapper.contains(pre) ? wrapper : pre;
		if (!code.trim()) {
			target.remove();
			return;
		}
		// A table cell is a single Markdown line: a fence there would break the table.
		// A block element keeps it on its own line within the cell.
		if (target.closest("td, th")) {
			const block = root.ownerDocument.createElement("div");
			block.textContent = placeholders.add(
				code.split("\n").filter((line) => line.trim()).map(cellCode).join("<br>"),
			);
			target.replaceWith(block);
			return;
		}
		// A fence must be longer than any run of backticks inside the code.
		const longestRun = Math.max(2, ...(code.match(/`+/g) ?? []).map((run) => run.length));
		const fence = "`".repeat(longestRun + 1);

		const block = root.ownerDocument.createElement("p");
		block.textContent = placeholders.add(`${fence}${lang}\n${code}\n${fence}`);
		target.replaceWith(block);
	});
}

/**
 * One line of code for a Markdown table cell. HTML, because a `|` would end the cell and
 * Obsidian shows the escaped form `\|` literally inside backtick code.
 */
function cellCode(line: string): string {
	const escaped = line
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\|/g, "&#124;")
		.replace(/^ +/, (indent) => "&nbsp;".repeat(indent.length));
	return `<code>${escaped}</code>`;
}

/**
 * Tables inside table cells (legends, layout grids) → their cells' contents, with " · "
 * between cells and line breaks between rows. A Markdown table can't contain another
 * table, and Obsidian's converter would write the inner one as escaped pipes. Links and
 * other content are moved, not copied, so they're still rewritten later. Infoboxes are
 * left alone; they're converted separately.
 */
function flattenNestedTables(root: Element): void {
	const doc = root.ownerDocument;
	// Innermost first, so an inner table is flattened before the one around it.
	const nested = Array.from(root.querySelectorAll("td table, th table")).reverse();
	for (const table of nested) {
		if (table.matches(".infobox")) continue;

		const flat = doc.createElement("span");
		const rows = table.querySelectorAll(":scope > tbody > tr, :scope > thead > tr, :scope > tr");
		rows.forEach((tr) => {
			const cells = Array.from(tr.children).filter(
				(c) => (c.tagName === "TD" || c.tagName === "TH") && (c.textContent?.trim() || c.querySelector("img")),
			);
			if (!cells.length) return;
			if (flat.childNodes.length) flat.append(doc.createElement("br"));
			cells.forEach((cell, i) => {
				if (i) flat.append(" · ");
				flat.append(...Array.from(cell.childNodes));
			});
		});
		table.replaceWith(flat);
	}
}

function texSource(el: Element): string {
	const annotated =
		el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
		el.querySelector("img")?.getAttribute("alt");
	if (annotated) return stripDisplayStyle(annotated.trim());

	const math = el.tagName.toLowerCase() === "math" ? el : el.querySelector("math");
	if (!math) return "";
	try {
		// outerHTML writes &nbsp;, which the converter's XML parser doesn't know.
		return MathMLToLaTeX.convert(math.outerHTML.replace(/&nbsp;/g, "&#160;")).trim();
	} catch {
		return "";
	}
}

function stripDisplayStyle(tex: string): string {
	const match = /^\{\\(?:display|text)style\s*([\s\S]*)\}$/.exec(tex);
	return (match ? match[1] : tex).trim();
}

/**
 * The Markdown converter drops <sup>/<sub>, which turns "mc²" into "mc2". Obsidian renders
 * these tags inline, so keep them as HTML. Skipped when they wrap links or math, which
 * need converting themselves (footnote markers are already gone by now).
 */
function keepSuperAndSubscripts(root: Element, placeholders: Placeholders): void {
	root.querySelectorAll("sup, sub").forEach((el) => {
		if (el.querySelector("a, img") || /ATLASPH\d+X/.test(el.textContent ?? "")) return;
		const text = (el.textContent ?? "").trim();
		if (!text) {
			el.remove();
			return;
		}
		const tag = el.tagName.toLowerCase();
		const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
		el.replaceWith(el.ownerDocument.createTextNode(placeholders.add(`<${tag}>${escaped}</${tag}>`)));
	});
}

/**
 * Makes image URLs absolute and unwraps the links around them (they point at File: pages).
 * Images stay hotlinked for now; downloading the lead image is still a TODO.
 */
function fixImages(root: Element, host: string): void {
	root.querySelectorAll("img").forEach((img) => {
		const src = img.getAttribute("src");
		if (!src) {
			img.remove();
			return;
		}
		img.setAttribute("src", absoluteUrl(src, host));
		img.removeAttribute("srcset");
	});
	root.querySelectorAll("a").forEach((a) => {
		if (a.querySelector("img")) unwrap(a);
	});
}

function imageMarkdown(img: Element, caption: string): string {
	const alt = (img.getAttribute("alt") ?? "").replace(/[[\]]/g, "");
	const src = img.getAttribute("src") ?? "";
	return caption ? `![${alt}](${src})\n*${caption}*` : `![${alt}](${src})`;
}

/** Text content of an element, with line breaks and list items turned into " · ". */
function flatten(el: Element | null): string {
	if (!el) return "";
	const clone = el.cloneNode(true) as Element;
	clone.querySelectorAll("br").forEach((br) => br.replaceWith(" · "));
	clone.querySelectorAll("li").forEach((li) => li.append(" · "));
	clone.querySelectorAll("p, div, tr").forEach((block) => block.append(" "));
	return (clone.textContent ?? "")
		.replace(/\s+/g, " ")
		.replace(/(\s*·\s*)+/g, " · ")
		.replace(/^\s*·\s*|\s*·\s*$/g, "")
		.trim();
}

function tableCell(el: Element): string {
	return escapePipes(flatten(el));
}

function escapePipes(text: string): string {
	return text.replace(/\|/g, "\\|");
}

function cleanAlias(text: string): string {
	return text.replace(/\s+/g, " ").replace(/[|[\]]/g, "").trim();
}

/** Characters that can't appear in an Obsidian heading link. */
function cleanHeading(fragment: string | null): string {
	return (fragment ?? "").replace(/[#|^[\]]/g, "").trim();
}

function absoluteUrl(url: string, host: string): string {
	try {
		return new URL(url, `${host}/`).toString();
	} catch {
		return url;
	}
}

function unwrap(el: Element): void {
	el.replaceWith(...Array.from(el.childNodes));
}

function splitOnce(text: string, separator: string): [string, string | undefined] {
	const i = text.indexOf(separator);
	return i === -1 ? [text, undefined] : [text.slice(0, i), text.slice(i + 1)];
}

function safeDecode(text: string): string | null {
	try {
		return decodeURIComponent(text);
	} catch {
		return null;
	}
}
