import { Notice, PaneType, TFile, normalizePath, stringifyYaml } from "obsidian";
import type AtlasPlugin from "../main";
import { AtlasSettings, DEFAULT_SETTINGS, imageFolderOf, isLanguageCode } from "../settings";
import { confirm } from "../ui/ConfirmModal";
import { imageFilename } from "../util/filename";
import type { RawArticle, WikipediaClient } from "../wiki/api";
import {
	PreparedArticle,
	convertInfoboxes,
	embedLocalImages,
	prepareArticle,
	rewriteLinks,
	selectImages,
	useLocalImage,
} from "../wiki/clean";
import { toMarkdown } from "../wiki/markdown";
import { NoteNames } from "./names";

const LICENSE = "CC BY-SA 4.0";
const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

/** Properties Atlas writes. Anything else in a note's frontmatter is the user's. */
const ATLAS_PROPERTIES = ["wikipedia_title", "lang", "source", "revid", "retrieved", "description", "categories", "license"];

/** Images bigger than this (mostly animated GIFs, which Wikipedia doesn't scale) stay hotlinked. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface ImportOptions {
	/** No progress or success notices (bulk imports show their own). Errors still throw. */
	quiet?: boolean;
}

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
	importArticle(title: string, lang: string, options: ImportOptions = {}): Promise<TFile> {
		const key = `${lang}:${title}`;
		const pending = this.inFlight.get(key);
		if (pending) return pending;

		const job = this.runImport(title, lang, options).finally(() => this.inFlight.delete(key));
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

	private async runImport(title: string, lang: string, { quiet = false }: ImportOptions): Promise<TFile> {
		const existing = this.existingNote(title);
		if (existing) return existing;

		const client = this.plugin.client(lang);
		const progress = new Progress(`Importing “${title}”…`, client, quiet);
		try {
			const article = await client.fetchArticle(title);

			// Take a fresh snapshot now: the vault may have changed while we were fetching.
			// Name the article itself first so none of its links can take its filename.
			const names = this.names();
			const filename = names.filenameFor(article.title);

			// The request may have been a redirect ("Einstein" → "Albert Einstein").
			const canonical = this.app.vault.getAbstractFileByPath(this.pathOf(filename));
			if (canonical instanceof TFile) return canonical;

			const content = await this.buildNote(article, client, names, progress);
			await this.ensureFolder(this.folder);
			const file = await this.app.vault.create(this.pathOf(filename), content);
			await this.rememberTitles(names.renamed);
			if (!quiet) new Notice(`Imported “${article.title}”.`);
			return file;
		} finally {
			progress.hide();
		}
	}

	/**
	 * Checks whether Wikipedia has a newer revision of an imported article and, if the user
	 * agrees, replaces the note's text with it. Properties the user added are kept.
	 */
	async updateNote(file: TFile): Promise<void> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const title = frontmatter.wikipedia_title;
		if (typeof title !== "string") {
			new Notice("This note wasn't imported from Wikipedia.");
			return;
		}
		const lang = isLanguageCode(frontmatter.lang) ? frontmatter.lang : this.plugin.settings.language;
		const client = this.plugin.client(lang);

		try {
			const latest = await client.latestRevision(title);
			if (!latest) {
				new Notice(`“${title}” is no longer on ${lang}.wikipedia.org.`);
				return;
			}
			if (latest.revId === Number(frontmatter.revid)) {
				new Notice(`“${title}” is up to date.`);
				return;
			}
			const renamed = latest.title !== title ? ` It's now called “${latest.title}”.` : "";
			const ok = await confirm(this.app, {
				title: `Update “${title}”?`,
				message: [
					`Wikipedia has a newer version of this article.${renamed}`,
					"Updating replaces the note's text, including anything you wrote in it. Properties you added are kept.",
				],
				confirmText: "Update",
			});
			if (!ok) return;

			const progress = new Progress(`Updating “${title}”…`, client, false);
			try {
				const article = await client.fetchArticle(latest.title);
				const names = this.names();
				const content = await this.buildNote(article, client, names, progress, userProperties(frontmatter));
				await this.app.vault.modify(file, content);
				await this.rememberTitles(names.renamed);
				new Notice(`Updated “${article.title}”.`);
			} finally {
				progress.hide();
			}
		} catch (error) {
			console.error("Atlas: update failed", error);
			new Notice(`Couldn't update “${title}”. ${error instanceof Error ? error.message : ""}`.trim());
		}
	}

	/** Fetched article → the note's full text: frontmatter, converted body, attribution. */
	private async buildNote(
		article: RawArticle,
		client: WikipediaClient,
		names: NoteNames,
		progress: Progress,
		extraProperties: Record<string, unknown> = {},
	): Promise<string> {
		const prepared = prepareArticle(article.html, {
			host: client.host,
			excludedSections: this.plugin.settings.excludedSections,
		});

		progress.set(`Linking “${article.title}”…`);
		const resolved = await client.resolveLinks(article.title, prepared.linkedTitles);
		rewriteLinks(prepared, resolved, this.folder, (linked) => names.filenameFor(linked));

		await this.downloadImages(prepared, client, progress);
		convertInfoboxes(prepared);
		embedLocalImages(prepared);

		const source = client.articleUrl(article.title);
		const frontmatter = noteProperties(article, client.lang, source, this.plugin.settings, extraProperties);
		const attribution =
			`*From [${article.title}](${source}) on Wikipedia, ` +
			`available under [${LICENSE}](${LICENSE_URL}).*`;
		return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${toMarkdown(prepared)}\n\n---\n\n${attribution}\n`;
	}

	/**
	 * Downloads the images the settings ask for and points them at their vault copies.
	 * An image that fails to download stays hotlinked; it never fails the import.
	 */
	private async downloadImages(article: PreparedArticle, client: WikipediaClient, progress: Progress): Promise<void> {
		const bySource = new Map<string, Element[]>();
		for (const img of selectImages(article, this.plugin.settings.images)) {
			const src = img.getAttribute("src");
			if (src) bySource.set(src, [...(bySource.get(src) ?? []), img]);
		}
		if (!bySource.size) return;

		const folder = imageFolderOf(this.plugin.settings);
		let done = 0;
		const total = bySource.size;
		if (total > 1) progress.set(`Downloading images (0/${total})…`);
		await Promise.all(
			Array.from(bySource, async ([src, imgs]) => {
				try {
					const path = await this.saveImage(src, folder, client);
					if (path) imgs.forEach((img) => useLocalImage(img, path));
				} catch (error) {
					console.warn(`Atlas: couldn't download ${src}`, error);
				}
				if (total > 1) progress.set(`Downloading images (${++done}/${total})…`);
			}),
		);
	}

	/** Saves one image into `folder`, reusing a copy already there. Returns its vault path. */
	private async saveImage(src: string, folder: string, client: WikipediaClient): Promise<string | null> {
		const name = imageFilename(src);
		if (!name) return null;
		const path = normalizePath(`${folder}/${name}`);
		if (this.app.vault.getAbstractFileByPath(path)) return path;

		const { data } = await client.fetchImage(src);
		if (data.byteLength > MAX_IMAGE_BYTES) return null;
		await this.ensureFolder(folder);
		try {
			await this.app.vault.createBinary(path, data);
		} catch (error) {
			// Another import saved the same image meanwhile.
			if (!this.app.vault.getAbstractFileByPath(path)) throw error;
		}
		return path;
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

/** The note's properties: Atlas's own, then any the user added (kept on update). */
export function noteProperties(
	article: Pick<RawArticle, "title" | "revId" | "description" | "categories">,
	lang: string,
	source: string,
	settings: Pick<AtlasSettings, "categories">,
	extra: Record<string, unknown> = {},
	today: Date = new Date(),
): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		wikipedia_title: article.title,
		lang,
		source,
		revid: article.revId,
		retrieved: localDate(today),
	};
	if (article.description) properties.description = article.description;
	if (settings.categories === "property" && article.categories.length) properties.categories = article.categories;
	properties.license = LICENSE;
	for (const [key, value] of Object.entries(extra)) {
		if (!ATLAS_PROPERTIES.includes(key)) properties[key] = value;
	}
	return properties;
}

/** Frontmatter entries the user added to an Atlas note. */
export function userProperties(frontmatter: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !ATLAS_PROPERTIES.includes(key)));
}

/** A notice showing what an import is doing, including waits for Wikipedia's rate limit. */
class Progress {
	private readonly notice: Notice | null;

	constructor(
		private status: string,
		client: WikipediaClient,
		quiet: boolean,
	) {
		this.notice = quiet ? null : new Notice(status, 0);
		client.onWait = (ms) => {
			this.notice?.setMessage(`Wikipedia is busy. Retrying in ${Math.ceil(ms / 1000)} s…`);
			window.setTimeout(() => this.notice?.setMessage(this.status), ms);
		};
	}

	set(message: string): void {
		this.status = message;
		this.notice?.setMessage(message);
	}

	hide(): void {
		this.notice?.hide();
	}
}
