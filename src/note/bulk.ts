/**
 * Imports every article a note links to that isn't in the vault yet.
 *
 * One article at a time, with a short pause between them: each import is already 4–6 API
 * requests, and Wikimedia limits clients that don't identify themselves with contact info
 * (see PROJECT_URL in main.ts). If Wikipedia keeps answering "too many requests" after the
 * client's own retries, the run stops rather than hammering it.
 */
import { Notice, TFile } from "obsidian";
import type AtlasPlugin from "../main";
import { isLanguageCode } from "../settings";
import { confirm } from "../ui/ConfirmModal";

/** Pause between articles. */
const PAUSE_MS = 1000;
/** Rough time per article, for the estimate in the confirmation. */
const SECONDS_PER_ARTICLE = 4;

/** Titles of the Atlas articles `file` links to that aren't imported yet. */
export function missingLinkedTitles(plugin: AtlasPlugin, file: TFile): string[] {
	const prefix = plugin.importer.linkPrefix;
	// At the vault root every unresolved link would look like an article link.
	if (!prefix) return [];
	const targets = Object.keys(plugin.app.metadataCache.unresolvedLinks[file.path] ?? {});
	const titles = targets
		.filter((linkpath) => linkpath.startsWith(prefix))
		.map((linkpath) => linkpath.slice(prefix.length).replace(/\.md$/, ""))
		.filter((filename) => filename && !filename.includes("/"))
		.map((filename) => plugin.titleIndex[filename] ?? filename);
	return [...new Set(titles)];
}

export async function importLinkedArticles(plugin: AtlasPlugin, file: TFile): Promise<void> {
	if (!plugin.importer.linkPrefix) {
		new Notice("Set a folder for imported articles first (Settings → Atlas → Folder).");
		return;
	}
	const titles = missingLinkedTitles(plugin, file);
	if (!titles.length) {
		new Notice("Every article this note links to is already in your vault.");
		return;
	}

	const lang = noteLanguage(plugin, file);
	const minutes = Math.max(1, Math.round((titles.length * SECONDS_PER_ARTICLE) / 60));
	const ok = await confirm(plugin.app, {
		title: `Import ${titles.length} linked ${titles.length === 1 ? "article" : "articles"}?`,
		message: [
			`“${file.basename}” links to ${titles.length} ${titles.length === 1 ? "article" : "articles"} that ${titles.length === 1 ? "isn't" : "aren't"} in your vault yet. ` +
				`They'll be imported from ${lang}.wikipedia.org one at a time, which takes about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
			"You can keep working meanwhile, and cancel from the progress notice.",
		],
		confirmText: "Import",
	});
	if (!ok) return;

	await new BulkRun(plugin, titles, lang).run();
}

class BulkRun {
	private cancelled = false;
	private readonly notice = new Notice("", 0);

	constructor(
		private readonly plugin: AtlasPlugin,
		private readonly titles: string[],
		private readonly lang: string,
	) {}

	async run(): Promise<void> {
		let imported = 0;
		const failed: string[] = [];
		let stopReason: string | null = null;

		for (const [i, title] of this.titles.entries()) {
			if (this.cancelled) break;
			this.show(`Importing linked articles: ${i + 1} of ${this.titles.length}`, title);
			try {
				await this.plugin.importer.importArticle(title, this.lang, { quiet: true });
				imported++;
			} catch (error) {
				console.error(`Atlas: bulk import of “${title}” failed`, error);
				failed.push(title);
				if (error instanceof Error && /limiting requests/.test(error.message)) {
					stopReason = "Wikipedia is limiting requests, so the rest were skipped. Try again in a few minutes.";
					break;
				}
			}
			if (i < this.titles.length - 1) await sleep(PAUSE_MS);
		}
		this.notice.hide();

		const skipped = this.titles.length - imported - failed.length;
		const parts = [`Imported ${imported} of ${this.titles.length} linked articles.`];
		if (failed.length) parts.push(`${failed.length} failed (details in the developer console).`);
		if (stopReason) parts.push(stopReason);
		else if (this.cancelled && skipped) parts.push(`Cancelled; ${skipped} not imported.`);
		new Notice(parts.join(" "), 10_000);
	}

	private show(progress: string, title: string): void {
		const fragment = createFragment((f) => {
			f.createDiv({ text: progress });
			f.createDiv({ text: title });
			const button = f.createDiv().createEl("button", { text: "Cancel", cls: "mod-warning" });
			button.addEventListener("click", (event) => {
				// A click on a notice dismisses it; keep it up while the current import finishes.
				event.stopPropagation();
				this.cancelled = true;
				button.disabled = true;
				button.setText("Cancelling…");
			});
		});
		this.notice.setMessage(fragment);
	}
}

/** Linked articles come from the same Wikipedia as the note. */
function noteLanguage(plugin: AtlasPlugin, file: TFile): string {
	const lang = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.lang;
	return isLanguageCode(lang) ? lang : plugin.settings.language;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
