import { App, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type AtlasPlugin from "./main";

export interface AtlasSettings {
	/** Wikipedia language code, e.g. "en" for en.wikipedia.org. */
	language: string;
	/** Vault folder imported articles are written to. Links between articles point into it. */
	folder: string;
	/** Open the note after importing it from the search box. */
	openAfterImport: boolean;
	/** Section headings (case-insensitive) dropped on import, with everything under them. */
	excludedSections: string[];
}

export const DEFAULT_SETTINGS: AtlasSettings = {
	language: "en",
	folder: "Wikipedia",
	openAfterImport: true,
	excludedSections: [
		"References",
		"Notes",
		"Citations",
		"Sources",
		"Bibliography",
		"Works cited",
		"Further reading",
		"External links",
	],
};

const LANGUAGE_CODE = /^[a-z][a-z-]*$/;

export function isLanguageCode(value: unknown): value is string {
	return typeof value === "string" && LANGUAGE_CODE.test(value);
}

export class AtlasSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: AtlasPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Wikipedia language")
			.setDesc("Language code of the Wikipedia to import from, such as en, de or fr.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.language)
					.setValue(settings.language)
					.onChange(async (value) => {
						const code = value.trim().toLowerCase();
						if (!isLanguageCode(code)) return;
						settings.language = code;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Folder")
			.setDesc(
				"Where imported articles are saved. Links point into this folder, so links to " +
					"articles you haven't imported yet keep the old folder if you change it later.",
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.folder)
					.setValue(settings.folder)
					.onChange(async (value) => {
						settings.folder = normalizePath(value.trim() || DEFAULT_SETTINGS.folder);
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Open after import")
			.setDesc("Open an article as soon as it's imported from the search box.")
			.addToggle((toggle) =>
				toggle.setValue(settings.openAfterImport).onChange(async (value) => {
					settings.openAfterImport = value;
					await this.plugin.savePluginData();
				}),
			);

		new Setting(containerEl)
			.setName("Sections to leave out")
			.setDesc("One heading per line. Matching sections, and everything under them, are dropped on import.")
			.addTextArea((area) => {
				area.setValue(settings.excludedSections.join("\n")).onChange(async (value) => {
					settings.excludedSections = value
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean);
					await this.plugin.savePluginData();
				});
				area.inputEl.rows = 8;
			});
	}
}
