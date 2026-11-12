import { App, Notice, SuggestModal } from "obsidian";
import type { SearchResult, WikipediaClient } from "../wiki/api";

const DEBOUNCE_MS = 250;

/** Search box with live Wikipedia title suggestions. */
export class ArticleSearchModal extends SuggestModal<SearchResult> {
	private latestRequest = 0;
	private lastResults: SearchResult[] = [];

	constructor(
		app: App,
		private readonly client: WikipediaClient,
		private readonly onChoose: (result: SearchResult) => void,
	) {
		super(app);
		this.setPlaceholder(`Search ${client.lang}.wikipedia.org`);
		this.emptyStateText = "No matching articles.";
	}

	async getSuggestions(query: string): Promise<SearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) return [];

		// Wait for typing to pause; if another keystroke came in meanwhile, drop this one.
		const request = ++this.latestRequest;
		await new Promise((resolve) => window.setTimeout(resolve, DEBOUNCE_MS));
		if (request !== this.latestRequest) return this.lastResults;

		try {
			const results = await this.client.searchTitles(trimmed);
			if (request === this.latestRequest) this.lastResults = results;
			return results;
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Wikipedia search failed.");
			return [];
		}
	}

	renderSuggestion(result: SearchResult, el: HTMLElement): void {
		const content = el.createDiv({ cls: "suggestion-content" });
		content.createDiv({ cls: "suggestion-title", text: result.title });
		if (result.description) content.createDiv({ cls: "suggestion-note", text: result.description });
	}

	onChooseSuggestion(result: SearchResult): void {
		this.onChoose(result);
	}
}
