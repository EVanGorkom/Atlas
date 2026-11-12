import { Notice, PaneType, TFile, normalizePath, stringifyYaml } from "obsidian";
import type AtlasPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import { titleToFilename } from "../util/filename";
import type { RawArticle, WikipediaClient } from "../wiki/api";
import { convertInfoboxes, prepareArticle, rewriteLinks } from "../wiki/clean";
import { toMarkdown } from "../wiki/markdown";

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

	notePath(title: string): string {
		return normalizePath(`${this.linkPrefix}${titleToFilename(title)}.md`);
	}

	existingNote(title: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(this.notePath(title));
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

	async importAndOpen(title: string, lang: string, newLeaf: PaneType | boolean = false): Promise<void> {
		const file = await this.tryImport(title, lang);
		if (file && this.plugin.settings.openAfterImport) {
			await this.app.workspace.getLeaf(newLeaf).openFile(file);
		}
	}

	private async runImport(title: string, lang: string): Promise<TFile> {
		const existing = this.existingNote(title);
		if (existing) return existing;

		const notice = new Notice(`Importing “${title}”…`, 0);
		try {
			const client = this.plugin.client(lang);
			const article = await client.fetchArticle(title);

			// The request may have been a redirect ("Einstein" → "Albert Einstein").
			const canonical = this.existingNote(article.title);
			if (canonical) return canonical;

			const prepared = prepareArticle(article.html, {
				host: client.host,
				excludedSections: this.plugin.settings.excludedSections,
			});

			notice.setMessage(`Linking “${article.title}”…`);
			const resolved = await client.resolveLinks(article.title, prepared.linkedTitles);
			const renamed = rewriteLinks(prepared, resolved, this.folder);
			convertInfoboxes(prepared);

			const file = await this.writeNote(article, client, toMarkdown(prepared));
			await this.rememberTitles({ ...renamed, [file.basename]: article.title });
			new Notice(`Imported “${article.title}”.`);
			return file;
		} finally {
			notice.hide();
		}
	}

	private async writeNote(article: RawArticle, client: WikipediaClient, body: string): Promise<TFile> {
		const source = client.articleUrl(article.title);
		const frontmatter: Record<string, unknown> = {
			wikipedia_title: article.title,
			lang: client.lang,
			source,
			revid: article.revId,
			retrieved: new Date().toISOString().slice(0, 10),
		};
		if (article.description) frontmatter.description = article.description;
		if (article.categories.length) frontmatter.categories = article.categories;
		frontmatter.license = LICENSE;

		const attribution =
			`*From [${article.title}](${source}) on Wikipedia, ` +
			`available under [${LICENSE}](${LICENSE_URL}).*`;
		const content = `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}\n\n---\n\n${attribution}\n`;

		await this.ensureFolder(this.folder);
		return this.app.vault.create(this.notePath(article.title), content);
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
