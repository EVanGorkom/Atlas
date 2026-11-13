import { Notice, PaneType, TFile, normalizePath, stringifyYaml } from "obsidian";
import type AtlasPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import type { RawArticle, WikipediaClient } from "../wiki/api";
import { convertInfoboxes, prepareArticle, rewriteLinks } from "../wiki/clean";
import { toMarkdown } from "../wiki/markdown";
import { NoteNames } from "./names";

const LICENSE = "CC BY-SA 4.0";
const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

/** Fetches articles, converts them and writes them into the vault. */
export class ArticleImporter {
	/** Imports in progress, so a double click doesn't import the same article twice. */
	private readonly inFlight = new Map<string, Promise<TFile>>();

	constructor(private readonly plugin: AtlasPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	/** Normalized vault folder for imported articles ("/" means the vault root). */
	get folder(): string {
		return normalizePath(this.plugin.settings.folder || DEFAULT_SETTINGS.folder);
	}

	/** What every Atlas link starts with, e.g. "Wikipedia/". Empty at the vault root. */
	get linkPrefix(): string {
		return this.folder === "/" ? "" : `${this.folder}/`;
	}

	private pathOf(filename: string): string {
		return normalizePath(`${this.linkPrefix}${filename}.md`);
	}

	/**
	 * A snapshot of which filenames are in use: notes in the Atlas folder, links into it that
	 * don't resolve yet (they keep the exact case of the title they were written for), and
	 * the title index. Build a fresh one for each import; it's cheap next to the network.
	 */
	names(): NoteNames {
		const { vault, metadataCache } = this.app;
		const folder = this.folder;
		const prefix = this.linkPrefix;

		const notes = vault
			.getMarkdownFiles()
			.filter((file) => (file.parent?.path ?? "/") === folder)
			.map((file) => {
				const title = metadataCache.getFileCache(file)?.frontmatter?.wikipedia_title;
				return { filename: file.basename, title: typeof title === "string" ? title : undefined };
			});

		const links: string[] = [];
		for (const targets of Object.values(metadataCache.unresolvedLinks)) {
			for (const linkpath of Object.keys(targets)) {
				if (!linkpath.startsWith(prefix)) continue;
				const filename = linkpath.slice(prefix.length).replace(/\.md$/, "");
				if (filename && !filename.includes("/")) links.push(filename);
			}
		}
		return new NoteNames({ notes, links, titleIndex: this.plugin.titleIndex });
	}

	/** Which of `titles` are already in the vault, from one names snapshot. */
	importedAmong(titles: string[]): Set<string> {
		const names = this.names();
		return new Set(titles.filter((title) => this.existingNote(title, names)));
	}

	/** The note for `title`, if it has been imported. */
	existingNote(title: string, names: NoteNames = this.names()): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(this.pathOf(names.filenameFor(title)));
		return file instanceof TFile ? file : null;
	}

	/** Imports an article, or returns the existing note if it's already in the vault. */
	importArticle(title: string, lang: string): Promise<TFile> {
		const key = `${lang}:${title}`;
		const pending = this.inFlight.get(key);
		if (pending) return pending;

		const job = this.runImport(title, lang).finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, job);
		return job;
	}

	/** Like importArticle, but reports failures as a notice and resolves to null. */
	async tryImport(title: string, lang: string): Promise<TFile | null> {
		try {
			return await this.importArticle(title, lang);
		} catch (error) {
			console.error("Atlas: import failed", error);
			new Notice(`Couldn't import “${title}”. ${error instanceof Error ? error.message : ""}`.trim());
			return null;
		}
	}

	/** Imports and opens an article. One that's already in the vault is always opened. */
	async importAndOpen(title: string, lang: string, newLeaf: PaneType | boolean = false): Promise<void> {
		const alreadyImported = !!this.existingNote(title);
		const file = await this.tryImport(title, lang);
		if (file && (alreadyImported || this.plugin.settings.openAfterImport)) {
			await this.app.workspace.getLeaf(newLeaf).openFile(file);
		}
	}

	private async runImport(title: string, lang: string): Promise<TFile> {
		const existing = this.existingNote(title);
		if (existing) return existing;

		let status = `Importing “${title}”…`;
		const notice = new Notice(status, 0);
		const setStatus = (message: string) => notice.setMessage((status = message));
		try {
			const client = this.plugin.client(lang);
			client.onWait = (ms) => {
				notice.setMessage(`Wikipedia is busy. Retrying in ${Math.ceil(ms / 1000)} s…`);
				window.setTimeout(() => notice.setMessage(status), ms);
			};
			const article = await client.fetchArticle(title);

			// Take a fresh snapshot now: the vault may have changed while we were fetching.
			// Name the article itself first so none of its links can take its filename.
			const names = this.names();
			const filename = names.filenameFor(article.title);

			// The request may have been a redirect ("Einstein" → "Albert Einstein").
			const canonical = this.app.vault.getAbstractFileByPath(this.pathOf(filename));
			if (canonical instanceof TFile) return canonical;

			const prepared = prepareArticle(article.html, {
				host: client.host,
				excludedSections: this.plugin.settings.excludedSections,
			});

			setStatus(`Linking “${article.title}”…`);
			const resolved = await client.resolveLinks(article.title, prepared.linkedTitles);
			rewriteLinks(prepared, resolved, this.folder, (linked) => names.filenameFor(linked));
			convertInfoboxes(prepared);

			const file = await this.writeNote(article, client, toMarkdown(prepared), this.pathOf(filename));
			await this.rememberTitles(names.renamed);
			new Notice(`Imported “${article.title}”.`);
			return file;
		} finally {
			notice.hide();
		}
	}

	private async writeNote(article: RawArticle, client: WikipediaClient, body: string, path: string): Promise<TFile> {
		const source = client.articleUrl(article.title);
		const frontmatter: Record<string, unknown> = {
			wikipedia_title: article.title,
			lang: client.lang,
			source,
			revid: article.revId,
			retrieved: localDate(new Date()),
		};
		if (article.description) frontmatter.description = article.description;
		if (article.categories.length) frontmatter.categories = article.categories;
		frontmatter.license = LICENSE;

		const attribution =
			`*From [${article.title}](${source}) on Wikipedia, ` +
			`available under [${LICENSE}](${LICENSE_URL}).*`;
		const content = `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}\n\n---\n\n${attribution}\n`;

		await this.ensureFolder(this.folder);
		return this.app.vault.create(path, content);
	}

	private async ensureFolder(folder: string): Promise<void> {
		if (folder === "/") return;
		let path = "";
		for (const part of folder.split("/")) {
			path = path ? `${path}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
		}
	}

	/** Records filename → title for titles whose filename had to change. */
	private async rememberTitles(entries: Record<string, string>): Promise<void> {
		let changed = false;
		for (const [filename, title] of Object.entries(entries)) {
			if (filename === title || this.plugin.titleIndex[filename] === title) continue;
			this.plugin.titleIndex[filename] = title;
			changed = true;
		}
		if (changed) await this.plugin.savePluginData();
	}
}

/** "YYYY-MM-DD" in local time. (toISOString is UTC, which dates evening imports tomorrow.) */
export function localDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
