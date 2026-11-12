import { Plugin } from "obsidian";
import { installLinkInterceptor } from "./links/interceptor";
import { ArticleImporter } from "./note/importer";
import { AtlasSettings, AtlasSettingTab, DEFAULT_SETTINGS } from "./settings";
import { ArticleSearchModal } from "./ui/ArticleSearchModal";
import { WikipediaClient } from "./wiki/api";

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
}

export default class AtlasPlugin extends Plugin {
	settings: AtlasSettings = { ...DEFAULT_SETTINGS };
	titleIndex: Record<string, string> = {};
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

		installLinkInterceptor(this);
	}

	/** A client for one language's Wikipedia. Cheap to create; holds no state. */
	client(lang: string = this.settings.language): WikipediaClient {
		return new WikipediaClient(lang, userAgent(this.manifest.version));
	}

	openSearch(lang: string = this.settings.language): void {
		new ArticleSearchModal(this.app, this.client(lang), (result) => {
			void this.importer.importAndOpen(result.title, lang);
		}).open();
	}

	async loadPluginData(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<AtlasData>;
		this.settings = { ...DEFAULT_SETTINGS, ...raw.settings };
		this.titleIndex = { ...raw.titleIndex };
	}

	async savePluginData(): Promise<void> {
		const data: AtlasData = { settings: this.settings, titleIndex: this.titleIndex };
		await this.saveData(data);
	}
}
