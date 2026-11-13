import { ButtonComponent, Modal, Setting } from "obsidian";
import type AtlasPlugin from "../main";
import { MAX_BULK_ARTICLES, describeBulk, plural, startBulkImport } from "../note/bulk";
import type { CategoryResult } from "../wiki/api";
import { CollectedCategory, collectCategory } from "../wiki/categories";

const DEPTHS: Record<string, string> = {
	"0": "No, only this category",
	"1": "One level down",
	"2": "Two levels down",
	"3": "Three levels down",
};
const LIMITS = [100, 500, 1000, 5000, MAX_BULK_ARTICLES];

/**
 * Import a category: choose how far into subcategories to go and how many articles at
 * most, look at what that finds (counts and a sample, since subcategories drift off
 * topic), then start the bulk import.
 */
export class CategoryImportModal extends Modal {
	private depth = 0;
	private limit = 500;
	private collected: (CollectedCategory & { toImport: string[]; alreadyImported: number; estimate: string }) | null = null;
	private collecting = false;
	private closed = false;
	private error: string | null = null;

	constructor(
		private readonly plugin: AtlasPlugin,
		private readonly category: CategoryResult,
		private readonly lang: string,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.titleEl.setText(`Import ${this.category.title}`);
		this.render();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl, category } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			text:
				`${plural(category.pages, "article")} directly in this category` +
				(category.subcategories ? `, and ${plural(category.subcategories, "subcategory", "subcategories")}.` : "."),
		});

		new Setting(contentEl)
			.setName("Include subcategories")
			.setDesc("Subcategories drift off topic quickly. Check the sample before importing.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(DEPTHS)
					.setValue(String(this.depth))
					.setDisabled(this.collecting || !category.subcategories)
					.onChange((value) => {
						this.depth = Number(value);
						this.collected = null;
						this.render();
					}),
			);

		new Setting(contentEl).setName("At most").addDropdown((dropdown) =>
			dropdown
				.addOptions(Object.fromEntries(LIMITS.map((n) => [String(n), plural(n, "article")])))
				.setValue(String(this.limit))
				.setDisabled(this.collecting)
				.onChange((value) => {
					this.limit = Number(value);
					this.collected = null;
					this.render();
				}),
		);

		const status = contentEl.createDiv({ cls: "setting-item-description" });
		if (this.error) status.setText(this.error);
		const buttons = contentEl.createDiv({ cls: "modal-button-container" });

		const found = this.collected;
		if (!found) {
			new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
			new ButtonComponent(buttons)
				.setButtonText(this.collecting ? "Finding articles…" : "Find articles")
				.setCta()
				.setDisabled(this.collecting)
				.onClick(() => void this.find(status));
			return;
		}

		status.setText(
			`Found ${plural(found.titles.length, "article")} in ${plural(found.categories, "category", "categories")}` +
				(found.truncated ? ", stopping at the limit" : "") +
				"." +
				(found.alreadyImported ? ` ${found.alreadyImported.toLocaleString()} ${found.alreadyImported === 1 ? "is" : "are"} already in your vault.` : ""),
		);
		if (found.toImport.length) {
			contentEl.insertBefore(
				createEl("p", {
					text: `Starts with: ${found.toImport.slice(0, 10).join(", ")}${found.toImport.length > 10 ? ", …" : ""}`,
				}),
				buttons,
			);
			contentEl.insertBefore(
				createEl("p", { text: `Importing them one at a time takes about ${found.estimate}. You can cancel or resume later.` }),
				buttons,
			);
		}
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons)
			.setButtonText(found.toImport.length ? `Import ${plural(found.toImport.length, "article")}` : "Nothing new to import")
			.setCta()
			.setDisabled(!found.toImport.length)
			.onClick(() => {
				this.close();
				void startBulkImport(this.plugin, { label: this.category.title, lang: this.lang, titles: found.toImport });
			});
	}

	private async find(status: HTMLElement): Promise<void> {
		this.collecting = true;
		this.error = null;
		this.render();
		const client = this.plugin.client(this.lang);
		try {
			const result = await collectCategory(this.category.title, (c) => client.categoryMembers(c), {
				depth: this.depth,
				limit: this.limit,
				isCancelled: () => this.closed,
				onProgress: ({ articles, categories }) =>
					status.setText(`Found ${plural(articles, "article")} in ${plural(categories, "category", "categories")}…`),
			});
			if (this.closed) return;
			this.collected = { ...result, ...describeBulk(this.plugin, result.titles) };
		} catch (error) {
			this.error = `Couldn't read the category. ${error instanceof Error ? error.message : ""}`.trim();
		} finally {
			this.collecting = false;
		}
		if (!this.closed) this.render();
	}
}
