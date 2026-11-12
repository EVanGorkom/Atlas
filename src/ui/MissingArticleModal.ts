import { App, ButtonComponent, Modal } from "obsidian";

export interface MissingArticleOptions {
	title: string;
	lang: string;
	onImport: () => void;
	onOpenInBrowser: () => void;
}

/** Shown when a link points at an article that isn't in the vault yet. */
export class MissingArticleModal extends Modal {
	constructor(
		app: App,
		private readonly options: MissingArticleOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { title, lang, onImport, onOpenInBrowser } = this.options;
		this.titleEl.setText(`“${title}” isn't in your vault yet`);
		this.contentEl.createEl("p", {
			text: `Import it from ${lang}.wikipedia.org, or read it in your browser.`,
		});

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons).setButtonText("Open in browser").onClick(() => {
			this.close();
			onOpenInBrowser();
		});
		new ButtonComponent(buttons)
			.setButtonText("Import")
			.setCta()
			.onClick(() => {
				this.close();
				onImport();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
