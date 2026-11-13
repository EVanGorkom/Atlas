import { App, ButtonComponent, Modal } from "obsidian";

export interface ConfirmOptions {
	title: string;
	/** One paragraph per entry. */
	message: string[];
	confirmText: string;
}

/** Asks a yes/no question. Resolves true only if the confirm button was clicked. */
export function confirm(app: App, options: ConfirmOptions): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, options, resolve).open());
}

class ConfirmModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private readonly options: ConfirmOptions,
		private readonly resolve: (confirmed: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.options.title);
		for (const paragraph of this.options.message) this.contentEl.createEl("p", { text: paragraph });

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttons)
			.setButtonText(this.options.confirmText)
			.setCta()
			.onClick(() => {
				this.confirmed = true;
				this.close();
			});
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(this.confirmed);
	}
}
