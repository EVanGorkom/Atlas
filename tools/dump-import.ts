/**
 * Converts a Wikimedia Enterprise HTML dump into Atlas notes, written straight into a
 * vault, without the API and its rate limits.
 *
 *   npm run dump-import -- --dump <file.json.tar.gz | https://…> --vault <vault folder> [options]
 *
 * Options:
 *   --folder <name>       Article folder inside the vault (default: Wikipedia)
 *   --limit <n>           Stop after writing n notes (default: no limit)
 *   --skip <n>            Skip the first n records of the dump first
 *   --overwrite           Replace notes that already exist (default: leave them alone)
 *   --categories <mode>   property | none (default: property)
 *   --redirects <file>    TSV of "redirect<TAB>target" lines (see --build-redirects), so
 *                         links through redirects point at the real article
 *   --build-redirects <file>  Instead of converting, read the whole dump and write that TSV
 *
 * Uses the plugin's own pipeline (src/wiki/clean.ts, src/note/*), with a Turndown setup
 * that behaves like Obsidian's converter (tools/markdown-shim.ts). Notes look like the ones
 * the plugin imports, but stay hotlinked for images. Filenames that had to change are
 * written to <vault>/.obsidian/plugins/atlas/dump-title-index.json, which the plugin merges
 * into its title index the next time it loads.
 *
 * Dumps are .tar.gz archives of NDJSON files: one JSON object per article, in no
 * particular order, with the article's HTML rendered by Parsoid, its revision, its
 * categories (hidden ones included, unmarked) and its redirects.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { get } from "node:https";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { JSDOM } from "jsdom";
import { noteProperties, noteText, toYaml } from "../src/note/format";
import { NoteNames } from "../src/note/names";
import { DEFAULT_SETTINGS } from "../src/settings";
import type { ResolvedTitle } from "../src/wiki/api";
import { convertInfoboxes, parseWikiHref, prepareArticle, rewriteLinks } from "../src/wiki/clean";
import { toMarkdown } from "../src/wiki/markdown";
import { tarLines } from "./tar";

Object.assign(globalThis, { DOMParser: new JSDOM("").window.DOMParser });

const USER_AGENT = "Atlas-dump-import/0.1 (Obsidian plugin, offline conversion)";

/** Namespaces whose pages aren't articles (English names; other languages differ). */
const NON_ARTICLE = /^(talk|(category|file|image|media|help|template|wikipedia|wp|portal|special|user|module|draft|mediawiki|book|timedtext|gadget|topic|event)( talk)?):/i;

/** Categories that are about the page, not its subject. The dump doesn't mark hidden ones. */
const MAINTENANCE_CATEGORY =
	/\b(articles?|pages?|wikidata|CS1|webarchive|short description|use (dmy|mdy) dates|use (british|american|australian|indian|canadian) english|engvarb|coordinates|stub|harv and sfn|good articles?|featured (articles?|lists?)|redirects?)\b/i;

interface Options {
	dump: string;
	vault: string;
	folder: string;
	limit: number;
	skip: number;
	overwrite: boolean;
	categories: "property" | "none";
	redirects?: string;
	buildRedirects?: string;
}

function parseArgs(argv: string[]): Options {
	const value = (name: string) => {
		const i = argv.indexOf(`--${name}`);
		return i === -1 ? undefined : argv[i + 1];
	};
	const dump = value("dump");
	const vault = value("vault");
	const buildRedirects = value("build-redirects");
	if (!dump || (!vault && !buildRedirects)) {
		console.error("Usage: npm run dump-import -- --dump <file|url> --vault <vault folder> [--limit n] [--folder Wikipedia] …");
		process.exit(2);
	}
	return {
		dump,
		vault: vault ?? "",
		folder: value("folder") ?? DEFAULT_SETTINGS.folder,
		limit: Number(value("limit") ?? Infinity),
		skip: Number(value("skip") ?? 0),
		overwrite: argv.includes("--overwrite"),
		categories: value("categories") === "none" ? "none" : "property",
		redirects: value("redirects"),
		buildRedirects,
	};
}

/** The dump as a stream of decompressed bytes, from a local file or a URL. */
async function openDump(source: string): Promise<Readable> {
	const raw: Readable = /^https?:/.test(source)
		? await new Promise((resolve, reject) =>
				get(source, { headers: { "User-Agent": USER_AGENT } }, (res) =>
					res.statusCode === 200 ? resolve(res) : reject(new Error(`HTTP ${res.statusCode} for ${source}`)),
				).on("error", reject),
			)
		: createReadStream(source);
	return raw.pipe(createGunzip());
}

/** "…-20250320-ENTERPRISE-HTML…" → "2025-03-20": notes are dated by the dump, not today. */
function dumpDate(source: string): string | null {
	const m = /(\d{4})(\d{2})(\d{2})/.exec(source.split("/").pop() ?? "");
	return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

interface DumpRecord {
	name: string;
	namespace?: { identifier: number };
	url: string;
	version?: { identifier: number };
	in_language?: { identifier: string };
	is_part_of?: { url: string };
	categories?: Array<{ name: string }>;
	redirects?: Array<{ name: string }>;
	article_body?: { html?: string };
}

async function buildRedirects(options: Options): Promise<void> {
	const out = createWriteStream(options.buildRedirects!);
	let records = 0;
	let redirects = 0;
	const started = Date.now();
	for await (const { line } of tarLines(await openDump(options.dump))) {
		// Only the name and the redirects are needed; skip parsing the HTML-heavy record twice.
		const record = JSON.parse(line) as DumpRecord;
		records++;
		for (const r of record.redirects ?? []) {
			out.write(`${r.name}\t${record.name}\n`);
			redirects++;
		}
		if (records % 10_000 === 0) console.log(`${records.toLocaleString()} records, ${redirects.toLocaleString()} redirects, ${rate(records, started)}`);
	}
	out.end();
	console.log(`Done: ${redirects.toLocaleString()} redirects from ${records.toLocaleString()} articles.`);
}

async function convert(options: Options): Promise<void> {
	const folderPath = join(options.vault, options.folder);
	mkdirSync(folderPath, { recursive: true });
	const pluginDir = join(options.vault, ".obsidian", "plugins", "atlas");
	const indexFile = join(pluginDir, "dump-title-index.json");

	// Filenames already in use: notes in the folder, plus the plugin's title index.
	const titleIndex: Record<string, string> = {
		...readJson(join(pluginDir, "data.json"))?.titleIndex,
		...readJson(indexFile),
	};
	const existing = readdirSync(folderPath).filter((f) => f.endsWith(".md") && !f.startsWith("._"));
	const names = new NoteNames({
		notes: existing.map((f) => ({ filename: f.slice(0, -3) })),
		links: [],
		titleIndex,
	});

	const redirects = new Map<string, string>();
	if (options.redirects) {
		for (const row of readFileSync(options.redirects, "utf8").split("\n")) {
			const tab = row.indexOf("\t");
			if (tab > 0) redirects.set(row.slice(0, tab), row.slice(tab + 1));
		}
		console.log(`Loaded ${redirects.size.toLocaleString()} redirects.`);
	}

	const retrieved = dumpDate(options.dump) ?? undefined;
	const counts = { records: 0, written: 0, existing: 0, skipped: 0, failed: 0 };
	const started = Date.now();

	for await (const { line } of tarLines(await openDump(options.dump))) {
		if (counts.written >= options.limit) break;
		counts.records++;
		if (counts.records <= options.skip) continue;

		let record: DumpRecord;
		try {
			record = JSON.parse(line);
		} catch {
			counts.failed++;
			continue;
		}
		const html = record.article_body?.html;
		if ((record.namespace?.identifier ?? 0) !== 0 || !html) {
			counts.skipped++;
			continue;
		}

		const title = record.name;
		const filename = names.filenameFor(title);
		const path = join(folderPath, `${filename}.md`);
		if (!options.overwrite && existsSync(path)) {
			counts.existing++;
			continue;
		}

		try {
			const host = record.is_part_of?.url ?? "https://en.wikipedia.org";
			const prepared = prepareArticle(html, { host, excludedSections: DEFAULT_SETTINGS.excludedSections });

			// Red links (pages that don't exist) are marked class="new" by Parsoid.
			const missing = new Set<string>();
			prepared.root.querySelectorAll("a.new").forEach((a) => {
				const link = parseWikiHref(a.getAttribute("href") ?? "");
				if (link) missing.add(link.title);
			});
			const resolved = new Map<string, ResolvedTitle>();
			for (const linked of prepared.linkedTitles) {
				const isArticle = !missing.has(linked) && !NON_ARTICLE.test(linked);
				resolved.set(linked, { title: redirects.get(linked) ?? linked, isArticle, fragment: null });
			}

			rewriteLinks(prepared, resolved, options.folder, (linked) => names.filenameFor(linked));
			convertInfoboxes(prepared);
			const body = toMarkdown(prepared);

			const lang = record.in_language?.identifier ?? "en";
			const properties = noteProperties(
				{
					title,
					revId: record.version?.identifier ?? 0,
					description: null,
					categories: (record.categories ?? [])
						.map((c) => c.name.replace(/^[^:]+:/, ""))
						.filter((c) => !MAINTENANCE_CATEGORY.test(c)),
				},
				lang,
				record.url,
				{ categories: options.categories },
				{},
				retrieved,
			);
			writeFileSync(path, noteText(toYaml(properties), body, title, record.url));
			counts.written++;
		} catch (error) {
			counts.failed++;
			console.error(`Failed: ${title}: ${error instanceof Error ? error.message : error}`);
		}

		if (counts.written && counts.written % 100 === 0) {
			console.log(`${counts.written.toLocaleString()} written · ${rate(counts.written, started)} · ${JSON.stringify(counts)}`);
		}
	}

	// Filenames that differ from their titles, for the plugin's title index.
	mkdirSync(pluginDir, { recursive: true });
	writeFileSync(indexFile, JSON.stringify({ ...readJson(indexFile), ...names.renamed }));
	const seconds = (Date.now() - started) / 1000;
	console.log(
		`Done in ${seconds.toFixed(0)} s: ${JSON.stringify(counts)}; ${Object.keys(names.renamed).length} renamed filenames → ${indexFile}`,
	);
}

function readJson(path: string): Record<string, any> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function rate(n: number, started: number): string {
	return `${(n / ((Date.now() - started) / 1000)).toFixed(1)}/s`;
}

const options = parseArgs(process.argv.slice(2));
await (options.buildRedirects ? buildRedirects(options) : convert(options));
// The HTTP stream may still be open after an early stop.
process.exit(0);
