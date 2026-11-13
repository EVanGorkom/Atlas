// Conversion regressions. Fixtures are trimmed from real en.wikipedia.org parse output.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResolvedTitle } from "../src/wiki/api";
import { convertInfoboxes, embedLocalImages, prepareArticle, rewriteLinks, selectImages, useLocalImage } from "../src/wiki/clean";
import { toMarkdown } from "../src/wiki/markdown";

const HOST = "https://en.wikipedia.org";

/** Runs the whole pipeline; every /wiki/ link resolves to an article of the same title. */
function convert(html: string, filenameFor?: (title: string) => string): string {
	const article = prepareArticle(`<div class="mw-parser-output">${html}</div>`, {
		host: HOST,
		excludedSections: ["References"],
	});
	const resolved = new Map<string, ResolvedTitle>(
		article.linkedTitles.map((title) => [title, { title, isArticle: true, fragment: null }]),
	);
	rewriteLinks(article, resolved, "Wikipedia", filenameFor);
	convertInfoboxes(article);
	return toMarkdown(article);
}

const INFOBOX = `
<table class="infobox biography vcard"><tbody>
<tr><th colspan="2" class="infobox-above"><div class="fn">Albert Einstein</div></th></tr>
<tr><th scope="row" class="infobox-label">Born</th><td class="infobox-data"><span style="display:none">(<span class="bday">1879-03-14</span>)</span>14 March 1879<br /><div style="display:inline" class="birthplace"><a href="/wiki/Ulm" title="Ulm">Ulm</a>, German&#160;Empire</div></td></tr>
<tr><th scope="row" class="infobox-label">Awards</th><td class="infobox-data"><div class="hidden-begin mw-collapsible mw-collapsed" style=""><div class="hidden-title skin-nightmode-reset-color" style="">See list</div><div class="hidden-content mw-collapsible-content"><a href="/wiki/Copley_Medal" title="Copley Medal">Copley Medal</a> (1925)</div></div></td></tr>
<tr><th scope="row" class="infobox-label">Citizenship</th><td class="infobox-data category"><div class="collapsible-list mw-collapsible mw-collapsed" style="text-align: left;">
<div style="line-height: 1.6em; font-weight: bold;"><div><span class="nobold"><i>See list</i></span></div></div>
<ul class="mw-collapsible-content" style="list-style:none;"><li><a href="/wiki/Kingdom_of_W%C3%BCrttemberg">Kingdom of Württemberg</a></li><li>Switzerland (from 1901)</li></ul></div></td></tr>
<tr class="infobox-hiddenrow"><td>HIDDEN ROW</td></tr>
</tbody></table>`;

describe("hidden text", () => {
	const md = convert(INFOBOX);

	it("drops microformat dates hidden with display:none", () => {
		assert.doesNotMatch(md, /1879-03-14/);
		assert.match(md, /14 March 1879/);
	});

	it("drops the 'See list' headers of collapsed infobox lists but keeps the lists", () => {
		assert.doesNotMatch(md, /See list/);
		assert.match(md, /\[\[Wikipedia\/Copley Medal\\\|Copley Medal\]\] \(1925\)/);
		assert.match(md, /Kingdom of Württemberg\]\] · Switzerland \(from 1901\)/);
	});

	it("drops rows Wikipedia hides with its stylesheet", () => {
		assert.doesNotMatch(md, /HIDDEN ROW/);
	});

	it("drops citation error and maintenance messages but keeps the citation", () => {
		const citation = convert(`<ul><li><cite class="citation journal cs1">Einstein, Albert (1905). "On the Electrodynamics of Moving Bodies".</cite><span class="cs1-visible-error citation-comment"><code class="cs1-code">{{<a href="/wiki/Template:Cite_journal">cite journal</a>}}</code>: More than one of <code class="cs1-code">&#124;place=</code> specified (<a href="/wiki/Help:CS1_errors">help</a>)</span><span class="cs1-maint citation-comment">CS1 maint: date and year (<a href="/wiki/Category:CS1_maint">link</a>)</span></li></ul>`);
		assert.match(citation, /On the Electrodynamics of Moving Bodies/);
		assert.doesNotMatch(citation, /cite journal|More than one of|CS1 maint/);
	});
});

describe("code blocks", () => {
	const PYTHON = `<p>Here is a function:</p>
<div class="mw-highlight mw-highlight-lang-python3 mw-content-ltr" dir="ltr"><pre><span></span><span class="k">def</span><span class="w"> </span><span class="nf">printer</span><span class="p">(</span><span class="n">input1</span><span class="p">,</span> <span class="n">input2</span><span class="o">=</span><span class="s2">"already there"</span><span class="p">):</span>
    <span class="nb">print</span><span class="p">(</span><span class="n">input1</span><span class="p">)</span>

<span class="c1"># Example output:</span>
<span class="c1"># hello</span>
</pre></div>
<p>After.</p>`;

	it("become fenced blocks with the language, keeping indentation and # comments", () => {
		const md = convert(PYTHON);
		assert.ok(
			md.includes(
				'```python\ndef printer(input1, input2="already there"):\n    print(input1)\n\n# Example output:\n# hello\n```',
			),
			md,
		);
	});

	it("never turn code comments into headings", () => {
		const outside = convert(PYTHON).replace(/```[\s\S]*?```/g, "");
		assert.doesNotMatch(outside, /^#/m);
	});

	it("handle plain preformatted text without a language", () => {
		assert.match(convert("<pre>a  =  1\n  b</pre>"), /```\na  =  1\n  b\n```/);
	});

	it("use a longer fence when the code contains backticks", () => {
		assert.match(convert("<pre>echo ```hi```</pre>"), /````\necho ```hi```\n````/);
	});

	it("inside a table cell become one <code> per line, with pipes and indentation kept", () => {
		const md = convert(
			'<table><tr><th>Type</th><th>Example</th></tr><tr><td>str</td><td><div class="mw-highlight mw-highlight-lang-python"><pre>"""Spanning\n  a|b &lt;c&gt;"""</pre></div></td></tr></table>',
		);
		assert.ok(md.includes('<code>"""Spanning</code><br><code>&nbsp;&nbsp;a&#124;b &lt;c&gt;"""</code>'), md);
		assert.doesNotMatch(md, /```/);
	});

	it("leave inline code alone", () => {
		assert.match(convert('<p>Use <code class="mw-highlight mw-highlight-lang-python">a[1:]</code> here.</p>'), /`a\[1:\]`/);
	});
});

describe("links", () => {
	it("use the filename the importer chooses", () => {
		const md = convert('<p>The <a href="/wiki/Red_Dwarf">show</a>.</p>', (title) =>
			title === "Red Dwarf" ? "Red Dwarf (2)" : title,
		);
		assert.match(md, /\[\[Wikipedia\/Red Dwarf \(2\)\|show\]\]/);
	});
});

describe("nested tables", () => {
	it("are flattened into their cell, keeping links", () => {
		const article = prepareArticle(
			'<div class="mw-parser-output"><table><tr><th>Legend</th></tr><tr><td><table><tbody><tr><td><a href="/wiki/Block_(periodic_table)#s-block">s-block</a></td><td>f-block</td></tr><tr><td>d-block</td><td></td></tr></tbody></table></td></tr></table></div>',
			{ host: HOST, excludedSections: [] },
		);
		assert.equal(article.root.querySelectorAll("table").length, 1);
		assert.match(article.root.innerHTML, /<span><a href="\/wiki\/Block_\(periodic_table\)#s-block">s-block<\/a> · f-block<br>d-block<\/span>/);
		assert.deepEqual(article.linkedTitles, ["Block (periodic table)"]);
	});

	it("keep cells that only hold an image", () => {
		const article = prepareArticle(
			'<div class="mw-parser-output"><table><tr><th>Gallery</th></tr><tr><td><table><tr><td><img src="//upload.wikimedia.org/a.png"></td><td>caption</td></tr></table></td></tr></table></div>',
			{ host: HOST, excludedSections: [] },
		);
		assert.match(article.root.innerHTML, /<span><img src="https:\/\/upload.wikimedia.org\/a.png"> · caption<\/span>/);
	});

	it("leave infoboxes inside tables for the infobox converter", () => {
		const md = convert(`<table><tr><th>Layout</th></tr><tr><td>${INFOBOX}</td></tr></table>`);
		assert.match(md, /\*\*Born\*\*/);
	});
});

describe("images", () => {
	const ARTICLE = `
<table class="infobox"><tbody>
<tr><th class="infobox-above">Albert Einstein</th></tr>
<tr><td class="infobox-image"><span typeof="mw:File"><a href="/wiki/File:Head.jpg"><img src="//thumb.wikimedia.org/a/Head.jpg/250px-Head.jpg" width="250" height="309"></a></span><div class="infobox-caption">Einstein in 1947</div></td></tr>
<tr><th class="infobox-label">Born</th><td class="infobox-data"><img src="//thumb.wikimedia.org/flag.svg/20px-flag.svg.png" width="20" height="13"> Ulm</td></tr>
<tr><td class="infobox-full-data"><img src="//thumb.wikimedia.org/m/Map.png/250px-Map.png" width="250" height="250"><div>Location of Ulm</div></td></tr>
</tbody></table>
<p><img src="//thumb.wikimedia.org/c/Icon.svg/16px-Icon.svg.png" width="16" height="16"> Lead text.</p>
<figure><img src="//thumb.wikimedia.org/b/Solvay.jpg/300px-Solvay.jpg" width="300" height="200"><figcaption>Solvay conference</figcaption></figure>`;

	const prepare = () => prepareArticle(`<div class="mw-parser-output">${ARTICLE}</div>`, { host: HOST, excludedSections: [] });
	const sources = (imgs: Element[]) => imgs.map((img) => img.getAttribute("src"));

	it("lead mode picks the infobox image", () => {
		assert.deepEqual(sources(selectImages(prepare(), "lead")), ["https://thumb.wikimedia.org/a/Head.jpg/250px-Head.jpg"]);
	});

	it("lead mode falls back to the first real image without an infobox", () => {
		const article = prepareArticle(
			'<div class="mw-parser-output"><img src="//x/icon.png" width="16" height="16"><figure><img src="//x/Photo.jpg" width="220" height="150"></figure></div>',
			{ host: HOST, excludedSections: [] },
		);
		assert.deepEqual(sources(selectImages(article, "lead")), ["https://x/Photo.jpg"]);
	});

	it("all mode skips icons and infobox images the infobox drops; none mode picks nothing", () => {
		const article = prepare();
		assert.equal(selectImages(article, "all").length, 2);
		assert.deepEqual(selectImages(article, "none"), []);
	});

	it("embeds downloaded images from the vault and keeps the rest hotlinked", () => {
		const article = prepare();
		const [lead, solvay] = selectImages(article, "all");
		useLocalImage(lead, "Wikipedia/Images/Head.jpg");
		useLocalImage(solvay, "Wikipedia/Images/Solvay.jpg");
		convertInfoboxes(article);
		embedLocalImages(article);
		const md = toMarkdown(article);
		assert.match(md, /^!\[\[Wikipedia\/Images\/Head\.jpg\]\]\n\*Einstein in 1947\*/m);
		assert.match(md, /!\[\[Wikipedia\/Images\/Solvay\.jpg\]\]/);
		assert.match(md, /!\[\]\(https:\/\/thumb\.wikimedia\.org\/c\/Icon\.svg/); // icons stay web images
		assert.doesNotMatch(md, /Head\.jpg\/250px/);
	});
});
