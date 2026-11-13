import { App, Notice, SuggestModal } from "obsidian";
import type { SearchResult } from "../wiki/api";

const DEBOUNCE_MS = 250;

export interface SearchModalOptions {
	placeholder: string;
	search: (query: string) => Promise<SearchResult[]>;
	onChoose: (result: SearchResult) => void;
	/** Which of the given titles are already imported; those are marked "In vault". */
	importedAmong?: (titles: string[]) => Set<string>;
}

/** Search box with live Wikipedia suggestions: articles, categories or list pages. */
export class ArticleSearchModal extends SuggestModal<SearchResult> {
	private latestRequest = 0;
	private lastResults: SearchResult[] = [];
	/** Titles among the current results that are already in the vault. */
	private imported = new Set<string>();

	constructor(
		app: App,
		private readonly options: SearchModalOptions,
	) {
		super(app);
		this.setPlaceholder(options.placeholder);
		this.emptyStateText = "Nothing found.";
	}

	async getSuggestions(query: string): Promise<SearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) return [];

		// Wait for typing to pause; if another keystroke came in meanwhile, drop this one.
		const request = ++this.latestRequest;
		await new Promise((resolve) => window.setTimeout(resolve, DEBOUNCE_MS));
		if (request !== this.latestRequest) return this.lastResults;

		try {
			const results = await this.options.search(trimmed);
			if (request === this.latestRequest) {
				this.lastResults = results;
				this.imported = this.options.importedAmong?.(results.map((r) => r.title)) ?? new Set();
			}
			return results;
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Wikipedia search failed.");
			return [];
		}
	}

	renderSuggestion(result: SearchResult, el: HTMLElement): void {
		el.addClass("mod-complex");
		const content = el.createDiv({ cls: "suggestion-content" });
		content.createDiv({ cls: "suggestion-title", text: result.title });
		if (result.description) content.createDiv({ cls: "suggestion-note", text: result.description });
		if (this.imported.has(result.title)) {
			el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair", text: "In vault" });
		}
	}

	onChooseSuggestion(result: SearchResult): void {
		this.options.onChoose(result);
	}
}
