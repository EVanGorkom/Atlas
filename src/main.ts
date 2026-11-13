import { Plugin, TFile, normalizePath } from "obsidian";
import { installLinkInterceptor } from "./links/interceptor";
import {
	BulkQueue,
	discardBulkImport,
	importLinkedArticles,
	importListPage,
	remindAboutInterruptedRun,
	resumeBulkImport,
} from "./note/bulk";
import { ArticleImporter } from "./note/importer";
import { AtlasSettings, AtlasSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ArticleSearchModal } from "./ui/ArticleSearchModal";
import { CategoryImportModal } from "./ui/CategoryImportModal";
import { CategoryResult, WikipediaClient } from "./wiki/api";

/**
 * Public URL for the project (repo or homepage). Wikimedia asks API clients to include
 * contact info in their User-Agent, and clients without it are limited to 10 requests a
 * minute instead of 200: https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits
 * TODO: set this before release.
 */
const PROJECT_URL = "";

function userAgent(version: string): string {
	return PROJECT_URL ? `Atlas/${version} (${PROJECT_URL}) Obsidian-plugin` : `Atlas/${version} Obsidian-plugin`;
}

/** Shape of the plugin's data.json. */
interface AtlasData {
	settings: AtlasSettings;
	/**
	 * Note filename → real Wikipedia title, for titles whose filename had to change
	 * (e.g. "AC/DC" is saved as "AC-DC"). Lets an unresolved link find its article again.
	 */
	titleIndex: Record<string, string>;
	/** A bulk import that hasn't finished, so it can be resumed after a restart. */
	bulkQueue?: BulkQueue | null;
}

export default class AtlasPlugin extends Plugin {
	settings: AtlasSettings = { ...DEFAULT_SETTINGS };
	titleIndex: Record<string, string> = {};
	bulkQueue: BulkQueue | null = null;
	/** True while a bulk import runs; only one runs at a time. */
	bulkRunning = false;
	importer!: ArticleImporter;

	async onload(): Promise<void> {
		await this.loadPluginData();
		this.importer = new ArticleImporter(this);

		this.addSettingTab(new AtlasSettingTab(this.app, this));

		this.addCommand({
			id: "import-article",
			name: "Import Wikipedia article",
			callback: () => this.openSearch(),
		});
		this.addRibbonIcon("globe", "Import Wikipedia article", () => this.openSearch());

		this.addCommand({
			id: "update-article",
			name: "Update this article from Wikipedia",
			checkCallback: (checking) => {
				const file = this.activeArticle();
				if (!file) return false;
				if (!checking) void this.importer.updateNote(file);
				return true;
			},
		});

		this.addCommand({
			id: "import-category",
			name: "Import a Wikipedia category",
			callback: () => this.openCategorySearch(),
		});

		this.addCommand({
			id: "import-list-page",
			name: "Import the articles listed on a Wikipedia page",
			callback: () => this.openListPageSearch(),
		});

		this.addCommand({
			id: "resume-bulk-import",
			name: "Resume bulk import",
			checkCallback: (checking) => {
				if (!this.bulkQueue || this.bulkRunning) return false;
				if (!checking) void resumeBulkImport(this);
				return true;
			},
		});

		this.addCommand({
			id: "discard-bulk-import",
			name: "Discard bulk import",
			checkCallback: (checking) => {
				if (!this.bulkQueue || this.bulkRunning) return false;
				if (!checking) void discardBulkImport(this);
				return true;
			},
		});

		this.addCommand({
			id: "import-linked-articles",
			name: "Import the articles this note links to",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) void importLinkedArticles(this, file);
				return true;
			},
		});

		// Right-click menu on an imported article.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || !this.isArticle(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Update from Wikipedia")
						.setIcon("refresh-cw")
						.onClick(() => void this.importer.updateNote(file)),
				);
				menu.addItem((item) =>
					item
						.setTitle("Import linked articles")
						.setIcon("download")
						.onClick(() => void importLinkedArticles(this, file)),
				);
			}),
		);

		installLinkInterceptor(this);
		this.app.workspace.onLayoutReady(() => remindAboutInterruptedRun(this));
	}

	/** The active note, if it's an imported article. */
	private activeArticle(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file && this.isArticle(file) ? file : null;
	}

	private isArticle(file: TFile): boolean {
		return typeof this.app.metadataCache.getFileCache(file)?.frontmatter?.wikipedia_title === "string";
	}

	/** A client for one language's Wikipedia. Cheap to create; holds no state. */
	client(lang: string = this.settings.language): WikipediaClient {
		return new WikipediaClient(lang, userAgent(this.manifest.version));
	}

	openSearch(lang: string = this.settings.language): void {
		const client = this.client(lang);
		new ArticleSearchModal(this.app, {
			placeholder: `Search ${lang}.wikipedia.org`,
			search: (query) => client.searchTitles(query),
			onChoose: (result) => void this.importer.importAndOpen(result.title, lang),
			importedAmong: (titles) => this.importer.importedAmong(titles),
		}).open();
	}

	/** Pick a category, then choose depth and size in the category dialog. */
	openCategorySearch(lang: string = this.settings.language): void {
		const client = this.client(lang);
		const found = new Map<string, CategoryResult>();
		new ArticleSearchModal(this.app, {
			placeholder: `Search ${lang}.wikipedia.org categories`,
			search: async (query) => {
				const categories = await client.searchCategories(query);
				for (const c of categories) found.set(c.title, c);
				return categories.map((c) => ({
					title: c.title,
					description: `${c.pages.toLocaleString()} articles · ${c.subcategories.toLocaleString()} subcategories`,
				}));
			},
			onChoose: (result) => {
				const category = found.get(result.title);
				if (category) new CategoryImportModal(this, category, lang).open();
			},
		}).open();
	}

	/** Pick a page (an outline, a "List of …" article, a Vital articles list) to import from. */
	openListPageSearch(lang: string = this.settings.language): void {
		const client = this.client(lang);
		new ArticleSearchModal(this.app, {
			placeholder: "Outline of…, List of…, Wikipedia:Vital articles…",
			search: (query) => client.searchListPages(query),
			onChoose: (result) => void importListPage(this, result.title, lang),
		}).open();
	}

	async loadPluginData(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<AtlasData>;
		this.settings = { ...DEFAULT_SETTINGS, ...raw.settings };
		this.titleIndex = { ...raw.titleIndex };
		this.bulkQueue = raw.bulkQueue ?? null;
		await this.mergeDumpTitleIndex();
	}

	/**
	 * The dump converter (tools/dump-import.ts) can't edit data.json while Obsidian may be
	 * running, so it leaves its renamed filenames in dump-title-index.json for us to merge.
	 */
	private async mergeDumpTitleIndex(): Promise<void> {
		if (!this.manifest.dir) return;
		const path = normalizePath(`${this.manifest.dir}/dump-title-index.json`);
		const adapter = this.app.vault.adapter;
		try {
			if (!(await adapter.exists(path))) return;
			const entries = JSON.parse(await adapter.read(path)) as Record<string, string>;
			Object.assign(this.titleIndex, entries);
			await this.savePluginData();
			await adapter.remove(path);
		} catch (error) {
			console.error("Atlas: couldn't merge dump-title-index.json", error);
		}
	}

	async savePluginData(): Promise<void> {
		const data: AtlasData = { settings: this.settings, titleIndex: this.titleIndex, bulkQueue: this.bulkQueue };
		await this.saveData(data);
	}
}
