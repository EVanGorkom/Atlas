/**
 * Bulk imports: many articles in one run, from a source that produces a list of titles.
 *
 * Sources: the articles a note links to, a Wikipedia category (optionally with its
 * subcategories), and the articles listed on a Wikipedia page (an outline, a "List of …"
 * article, or one of Wikipedia's Vital articles lists).
 *
 * Runs go one article at a time with a short pause between them: each import is already
 * 4–6 API requests, and Wikimedia limits clients that don't identify themselves with
 * contact info (see PROJECT_URL in main.ts). If Wikipedia keeps answering "too many
 * requests", the run waits and retries, and stops after a few rounds. The queue is saved
 * in data.json as it goes, so a run interrupted by closing Obsidian can be resumed.
 */
import { Notice, TFile } from "obsidian";
import type AtlasPlugin from "../main";
import { isLanguageCode } from "../settings";
import { confirm } from "../ui/ConfirmModal";
import { prepareArticle } from "../wiki/clean";

/** Pause between articles. */
const PAUSE_MS = 1000;
/** Rough time per article including the pause, for estimates. */
const SECONDS_PER_ARTICLE = 5;
/** When Wikipedia keeps refusing requests, wait this long before trying again… */
const RATE_LIMIT_WAIT_MS = 2 * 60_000;
/** …and give up (keeping the queue to resume later) after this many waits in a row. */
const MAX_RATE_LIMIT_WAITS = 3;
/** Save progress to data.json after this many articles. */
const SAVE_EVERY = 10;
/** Most articles one run may queue. */
export const MAX_BULK_ARTICLES = 10_000;

/** A bulk import in progress, as saved in data.json. */
export interface BulkQueue {
	/** What's being imported, for messages: "Category:Physics", "the articles “X” links to". */
	label: string;
	lang: string;
	titles: string[];
	/** Index of the next title to import. */
	next: number;
	imported: number;
	failed: string[];
}

// ---------------------------------------------------------------------------
// Sources

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

/** Imports every article `file` links to that isn't in the vault yet, after asking. */
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
	await confirmAndStart(plugin, { label: `the articles “${file.basename}” links to`, lang, titles });
}

/**
 * The articles linked from the body of a Wikipedia page, in page order: the entries of
 * an outline, a "List of …" article, or a Vital articles list. Navboxes, references and
 * the other sections Atlas leaves out of notes are skipped, as are links to non-articles.
 */
export async function articlesListedOn(plugin: AtlasPlugin, pageTitle: string, lang: string): Promise<string[]> {
	const client = plugin.client(lang);
	const page = await client.fetchArticle(pageTitle);
	const prepared = prepareArticle(page.html, {
		host: client.host,
		excludedSections: plugin.settings.excludedSections,
	});
	const resolved = await client.resolveTitles(prepared.linkedTitles);
	const titles = new Set<string>();
	for (const linked of prepared.linkedTitles) {
		const target = resolved.get(linked);
		if (target?.isArticle && target.title !== page.title) titles.add(target.title);
	}
	return [...titles];
}

/** Reads a list page's links, then asks before importing them. */
export async function importListPage(plugin: AtlasPlugin, pageTitle: string, lang: string): Promise<void> {
	const notice = new Notice(`Reading the articles listed on “${pageTitle}”…`, 0);
	let titles: string[];
	try {
		titles = await articlesListedOn(plugin, pageTitle, lang);
	} catch (error) {
		new Notice(`Couldn't read “${pageTitle}”. ${error instanceof Error ? error.message : ""}`.trim());
		return;
	} finally {
		notice.hide();
	}
	if (!titles.length) {
		new Notice(`“${pageTitle}” doesn't link to any articles.`);
		return;
	}
	await confirmAndStart(plugin, { label: `the articles listed on “${pageTitle}”`, lang, titles });
}

// ---------------------------------------------------------------------------
// Running

/** What a bulk import would do, for confirmations. */
export function describeBulk(
	plugin: AtlasPlugin,
	titles: string[],
): { toImport: string[]; alreadyImported: number; estimate: string } {
	const imported = plugin.importer.importedAmong(titles);
	const toImport = titles.filter((title) => !imported.has(title));
	return { toImport, alreadyImported: imported.size, estimate: duration(toImport.length * SECONDS_PER_ARTICLE) };
}

/** Asks with a summary and a sample of titles, then starts the run. */
async function confirmAndStart(plugin: AtlasPlugin, job: { label: string; lang: string; titles: string[] }): Promise<void> {
	const capped = job.titles.slice(0, MAX_BULK_ARTICLES);
	const { toImport, alreadyImported, estimate } = describeBulk(plugin, capped);
	if (!toImport.length) {
		new Notice(`All ${plural(capped.length, "article")} are already in your vault.`);
		return;
	}
	const message = [
		`${plural(toImport.length, "article")} from ${job.lang}.wikipedia.org` +
			(alreadyImported ? ` (${alreadyImported.toLocaleString()} more ${alreadyImported === 1 ? "is" : "are"} already in your vault)` : "") +
			`. Importing them one at a time takes about ${estimate}.`,
		`Starts with: ${toImport.slice(0, 8).join(", ")}${toImport.length > 8 ? ", …" : ""}`,
	];
	if (job.titles.length > MAX_BULK_ARTICLES) message.push(`Only the first ${MAX_BULK_ARTICLES.toLocaleString()} are queued.`);
	message.push("You can keep working meanwhile, cancel from the progress notice, and resume if Obsidian closes.");

	const ok = await confirm(plugin.app, {
		title: `Import ${plural(toImport.length, "article")}?`,
		message,
		confirmText: "Import",
	});
	if (ok) await startBulkImport(plugin, { ...job, titles: toImport });
}

/** Starts a new run, unless one is already going or waiting to be resumed. */
export async function startBulkImport(
	plugin: AtlasPlugin,
	job: { label: string; lang: string; titles: string[] },
): Promise<void> {
	if (plugin.bulkRunning) {
		new Notice("A bulk import is already running. Cancel it first, or wait for it to finish.");
		return;
	}
	if (plugin.bulkQueue) {
		new Notice("An interrupted bulk import is waiting. Resume or discard it first, from the command palette.");
		return;
	}
	plugin.bulkQueue = { ...job, titles: job.titles.slice(0, MAX_BULK_ARTICLES), next: 0, imported: 0, failed: [] };
	await plugin.savePluginData();
	await new BulkRun(plugin, plugin.bulkQueue).run();
}

export async function resumeBulkImport(plugin: AtlasPlugin): Promise<void> {
	const queue = plugin.bulkQueue;
	if (!queue || plugin.bulkRunning) return;
	await new BulkRun(plugin, queue).run();
}

export async function discardBulkImport(plugin: AtlasPlugin): Promise<void> {
	const queue = plugin.bulkQueue;
	if (!queue || plugin.bulkRunning) return;
	plugin.bulkQueue = null;
	await plugin.savePluginData();
	new Notice(`Discarded the import of ${queue.label} (${plural(queue.titles.length - queue.next, "article")} left).`);
}

/** Shown once at startup if a run was interrupted. */
export function remindAboutInterruptedRun(plugin: AtlasPlugin): void {
	const queue = plugin.bulkQueue;
	if (!queue) return;
	new Notice(
		`Atlas: the import of ${queue.label} was interrupted with ${plural(queue.titles.length - queue.next, "article")} left. ` +
			"Run “Resume bulk import” from the command palette to continue, or “Discard bulk import”.",
		15_000,
	);
}

class BulkRun {
	private cancelled = false;
	private readonly notice = new Notice("", 0);

	constructor(
		private readonly plugin: AtlasPlugin,
		private readonly queue: BulkQueue,
	) {}

	async run(): Promise<void> {
		const { plugin, queue } = this;
		plugin.bulkRunning = true;
		let rateLimitWaits = 0;
		let stopReason: string | null = null;
		// Disabling or reloading the plugin stops the run but keeps the queue, so it can be
		// resumed. (Quitting Obsidian ends it without this; progress saved so far is kept.)
		let interrupted = false;
		plugin.register(() => {
			interrupted = true;
			this.cancelled = true;
		});

		try {
			while (queue.next < queue.titles.length && !this.cancelled) {
				const title = queue.titles[queue.next];
				this.show(`Importing ${queue.label}: ${queue.next + 1} of ${queue.titles.length}`, title);
				try {
					await plugin.importer.importArticle(title, queue.lang, { quiet: true });
					queue.imported++;
					rateLimitWaits = 0;
				} catch (error) {
					if (error instanceof Error && /limiting requests/.test(error.message)) {
						if (++rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
							stopReason = "Wikipedia kept limiting requests, so the run stopped. Resume it later from the command palette.";
							break;
						}
						await this.wait(RATE_LIMIT_WAIT_MS, `Wikipedia is limiting requests. Waiting ${duration(RATE_LIMIT_WAIT_MS / 1000)}…`);
						continue; // Retry the same article.
					}
					console.error(`Atlas: bulk import of “${title}” failed`, error);
					queue.failed.push(title);
				}
				queue.next++;
				if (queue.next % SAVE_EVERY === 0) await plugin.savePluginData();
				if (queue.next < queue.titles.length) await this.wait(PAUSE_MS);
			}
		} finally {
			plugin.bulkRunning = false;
			this.notice.hide();
			// Finished or cancelled: forget the queue. Stopped by rate limits: keep it to resume.
			// Interrupted by unload: leave data.json alone; the plugin's next load resumes from it.
			if (!interrupted) {
				if (!stopReason) plugin.bulkQueue = null;
				await plugin.savePluginData();
			}
		}
		if (interrupted) return;

		const left = queue.titles.length - queue.next;
		const parts = [`Imported ${queue.imported.toLocaleString()} of ${plural(queue.titles.length, "article")} (${queue.label}).`];
		if (queue.failed.length) parts.push(`${queue.failed.length} failed (details in the developer console).`);
		if (stopReason) parts.push(stopReason);
		else if (this.cancelled && left) parts.push(`Cancelled; ${left.toLocaleString()} not imported.`);
		new Notice(parts.join(" "), 15_000);
	}

	/** Waits, a second at a time so Cancel takes effect, optionally showing a message. */
	private async wait(ms: number, message?: string): Promise<void> {
		if (message) this.show(message, this.queue.titles[this.queue.next] ?? "");
		for (let waited = 0; waited < ms && !this.cancelled; waited += 1000) {
			await sleep(Math.min(1000, ms - waited));
		}
	}

	private show(progress: string, title: string): void {
		const fragment = createFragment((f) => {
			f.createDiv({ text: progress });
			f.createDiv({ text: title });
			const button = f.createDiv().createEl("button", { text: "Cancel", cls: "mod-warning" });
			if (this.cancelled) {
				button.disabled = true;
				button.setText("Cancelling…");
			}
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

// ---------------------------------------------------------------------------

/** Linked articles come from the same Wikipedia as the note. */
function noteLanguage(plugin: AtlasPlugin, file: TFile): string {
	const lang = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.lang;
	return isLanguageCode(lang) ? lang : plugin.settings.language;
}

/** "1 article", "1,234 articles"; pass `many` for irregular plurals ("categories"). */
export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "45 seconds", "12 minutes", "3.5 hours". */
export function duration(seconds: number): string {
	if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
	const minutes = seconds / 60;
	if (minutes < 90) return `${Math.round(minutes)} minutes`;
	const hours = minutes / 60;
	return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} hours`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
