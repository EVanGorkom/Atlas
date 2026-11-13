import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

export interface SearchResult {
	title: string;
	description: string | null;
}

export interface CategoryResult {
	/** Full title, e.g. "Category:Physics". */
	title: string;
	/** Articles directly in the category. */
	pages: number;
	subcategories: number;
}

export interface RawArticle {
	/** Canonical title, after following redirects. */
	title: string;
	pageId: number;
	revId: number;
	/** Rendered article HTML from the parser. */
	html: string;
	/** Wikipedia's short description, e.g. "German-born physicist (1879–1955)". */
	description: string | null;
	/** Visible (non-maintenance) categories, without the "Category:" prefix. */
	categories: string[];
}

export interface ResolvedTitle {
	/** Canonical title the link ends up at. */
	title: string;
	/** True only for an existing page in the article namespace. */
	isArticle: boolean;
	/** Section a redirect points to, e.g. "Einstein's brain" → "Albert Einstein#Brain". */
	fragment: string | null;
}

export class WikipediaError extends Error {}

type Json = Record<string, any>;

/** The Action API's limit on titles per query for regular (non-bot) clients. */
const RESOLVE_BATCH_SIZE = 50;

/*
 * Wikimedia rate limits (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits):
 * unidentified clients get 10 requests/minute; a User-Agent with contact info gets 200.
 * Keep concurrency low, and on 429/503 honour Retry-After or back off from 5 seconds.
 */
const MAX_CONCURRENT_REQUESTS = 2;
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Thin client for one language's Wikipedia. Uses Obsidian's requestUrl so it works on
 * mobile and isn't subject to CORS. All clients share one request limiter.
 */
export class WikipediaClient {
	readonly host: string;
	/** Called before waiting out a rate limit (HTTP 429/503), with the wait in milliseconds. */
	onWait?: (ms: number) => void;

	constructor(
		readonly lang: string,
		private readonly userAgent: string,
	) {
		this.host = `https://${lang}.wikipedia.org`;
	}

	articleUrl(title: string): string {
		return `${this.host}/wiki/${encodeTitle(title)}`;
	}

	async searchTitles(query: string, limit = 10): Promise<SearchResult[]> {
		const params = new URLSearchParams({ q: query, limit: String(limit) });
		const data = await this.request({ url: `${this.host}/w/rest.php/v1/search/title?${params}` });
		const pages = (data.pages ?? []) as Array<{ title: string; description?: string | null }>;
		return pages.map((page) => ({ title: page.title, description: page.description ?? null }));
	}

	async fetchArticle(title: string): Promise<RawArticle> {
		const data = await this.action({
			action: "parse",
			page: title,
			prop: "text|revid|categories|properties",
			redirects: "1",
			disableeditsection: "1",
			disablelimitreport: "1",
		});
		const parse = data.parse as Json | undefined;
		if (!parse) throw new WikipediaError(`No article found for “${title}”.`);

		const categories = ((parse.categories ?? []) as Array<{ category: string; hidden?: boolean }>)
			.filter((c) => !c.hidden)
			.map((c) => c.category.replace(/_/g, " "));

		return {
			title: parse.title,
			pageId: parse.pageid,
			revId: parse.revid,
			html: parse.text,
			description: shortDescription(parse.properties),
			categories,
		};
	}

	/**
	 * Categories whose name starts with `query`, with how many articles and subcategories
	 * each holds. Titles keep their namespace prefix ("Category:Physics"), which differs by
	 * language ("Kategorie:" on de.wikipedia.org).
	 */
	async searchCategories(query: string, limit = 10): Promise<CategoryResult[]> {
		const data = await this.action({
			action: "query",
			generator: "prefixsearch",
			gpssearch: query,
			gpsnamespace: "14",
			gpslimit: String(limit),
			prop: "categoryinfo",
		});
		const pages = (data.query?.pages ?? []) as Json[];
		return pages
			.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
			.map((page) => ({
				title: page.title,
				pages: page.categoryinfo?.pages ?? 0,
				subcategories: page.categoryinfo?.subcats ?? 0,
			}));
	}

	/** Every article and subcategory directly in a category (full titles, with prefixes). */
	async categoryMembers(category: string): Promise<{ pages: string[]; subcategories: string[] }> {
		const pages: string[] = [];
		const subcategories: string[] = [];
		let next: Json | undefined = {};
		while (next) {
			const data = await this.action({
				action: "query",
				list: "categorymembers",
				cmtitle: category,
				cmtype: "page|subcat",
				cmnamespace: "0|14",
				cmlimit: "max",
				...(next as Record<string, string>),
			});
			for (const member of (data.query?.categorymembers ?? []) as Json[]) {
				if (member.ns === 0) pages.push(member.title);
				else if (member.ns === 14) subcategories.push(member.title);
			}
			next = data.continue as Json | undefined;
		}
		return { pages, subcategories };
	}

	/**
	 * Pages to import a list of articles from: articles ("Outline of physics", "List of …"),
	 * project pages ("Wikipedia:Vital articles/Level/4/Physical sciences") and portals.
	 */
	async searchListPages(query: string, limit = 10): Promise<SearchResult[]> {
		const data = await this.action({
			action: "query",
			list: "prefixsearch",
			pssearch: query,
			psnamespace: "0|4|100",
			pslimit: String(limit),
		});
		return ((data.query?.prefixsearch ?? []) as Json[]).map((page) => ({ title: page.title, description: null }));
	}

	/**
	 * The current revision of an article, following redirects (the article may have been
	 * renamed since it was imported). One small request; null if the article is gone.
	 */
	async latestRevision(title: string): Promise<{ title: string; revId: number } | null> {
		const data = await this.action({ action: "query", titles: title, redirects: "1", prop: "revisions", rvprop: "ids" });
		const page = (data.query?.pages as Json[] | undefined)?.[0];
		const revId = page?.revisions?.[0]?.revid;
		if (!page || page.missing || page.invalid || typeof revId !== "number") return null;
		return { title: page.title, revId };
	}

	/**
	 * Resolves the links found in an article to canonical article titles, following
	 * redirects and flagging links that aren't articles. The map is keyed by the titles
	 * passed in.
	 *
	 * Asks for every page `pageTitle` links to (up to 500 per request), so a typical article
	 * takes 1–3 requests. Any title that list misses (it can lag slightly behind the
	 * rendered page) is looked up directly.
	 */
	async resolveLinks(pageTitle: string, titles: string[]): Promise<Map<string, ResolvedTitle>> {
		const wanted = new Set(titles);
		const fromPage = await this.linksOf(pageTitle);
		const resolved = new Map<string, ResolvedTitle>();
		const missing: string[] = [];

		for (const title of wanted) {
			const hit = fromPage.get(title);
			if (hit) resolved.set(title, hit);
			else missing.push(title);
		}
		if (missing.length) {
			for (const [title, hit] of await this.resolveTitles(missing)) resolved.set(title, hit);
		}
		return resolved;
	}

	/** Resolves arbitrary titles, 50 per request. */
	async resolveTitles(titles: string[]): Promise<Map<string, ResolvedTitle>> {
		const resolved = new Map<string, ResolvedTitle>();
		const unique = [...new Set(titles)];

		for (let i = 0; i < unique.length; i += RESOLVE_BATCH_SIZE) {
			const batch = unique.slice(i, i + RESOLVE_BATCH_SIZE);
			const data = await this.action({ action: "query", titles: batch.join("|"), redirects: "1" }, "POST");
			const lookup = new TitleLookup();
			lookup.add(data.query);
			for (const title of batch) resolved.set(title, lookup.resolve(title));
		}
		return resolved;
	}

	/** Every article-namespace page `pageTitle` links to, keyed by link title. */
	private async linksOf(pageTitle: string): Promise<Map<string, ResolvedTitle>> {
		const lookup = new TitleLookup();
		const linkTitles = new Set<string>();
		let next: Json | undefined = {};

		while (next) {
			const data = await this.action(
				{
					action: "query",
					generator: "links",
					titles: pageTitle,
					gplnamespace: "0",
					gpllimit: "max",
					redirects: "1",
					...(next as Record<string, string>),
				},
				"POST",
			);
			lookup.add(data.query);
			for (const page of (data.query?.pages ?? []) as Json[]) linkTitles.add(page.title);
			for (const redirect of (data.query?.redirects ?? []) as Json[]) linkTitles.add(redirect.from);
			next = data.continue as Json | undefined;
		}

		const result = new Map<string, ResolvedTitle>();
		for (const title of linkTitles) result.set(title, lookup.resolve(title));
		return result;
	}

	private async action(params: Record<string, string>, method: "GET" | "POST" = "GET"): Promise<Json> {
		const query = new URLSearchParams({
			...params,
			format: "json",
			formatversion: "2",
			errorformat: "plaintext",
		}).toString();
		const endpoint = `${this.host}/w/api.php`;

		const data =
			method === "GET"
				? await this.request({ url: `${endpoint}?${query}` })
				: await this.request({
						url: endpoint,
						method: "POST",
						contentType: "application/x-www-form-urlencoded",
						body: query,
					});

		const error = (data.errors as Json[] | undefined)?.[0] ?? (data.error as Json | undefined);
		if (error) throw new WikipediaError(error.text ?? error.info ?? error.code ?? "Unknown API error.");
		return data;
	}

	/**
	 * Downloads an image (a thumbnail from Wikimedia's servers), sharing the request limiter
	 * and rate-limit handling with the API calls.
	 */
	async fetchImage(url: string): Promise<{ data: ArrayBuffer; contentType: string }> {
		const host = new URL(url).host;
		const response = await this.send({ url }, host);
		const contentType = header(response, "content-type") ?? "";
		if (!contentType.startsWith("image/")) {
			throw new WikipediaError(`${host} sent ${contentType || "something"} instead of an image.`);
		}
		return { data: response.arrayBuffer, contentType };
	}

	private async request(param: RequestUrlParam): Promise<Json> {
		const response = await this.send(param, `${this.lang}.wikipedia.org`);
		try {
			return response.json as Json;
		} catch {
			throw new WikipediaError(`${this.lang}.wikipedia.org sent an unexpected response.`);
		}
	}

	/** One request with the shared limiter, the User-Agent, and retries on 429/503. */
	private async send(param: RequestUrlParam, site: string): Promise<RequestUrlResponse> {
		const request: RequestUrlParam = {
			...param,
			headers: {
				"User-Agent": this.userAgent,
				// Read by Wikimedia when a client can't set User-Agent itself.
				"Api-User-Agent": this.userAgent,
				...param.headers,
			},
			throw: false,
		};

		for (let attempt = 0; ; attempt++) {
			let response: RequestUrlResponse;
			try {
				response = await limiter.run(() => requestUrl(request));
			} catch {
				throw new WikipediaError(`Couldn't reach ${site}. Check your connection.`);
			}

			if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
				const wait = backoffMs(response, attempt);
				this.onWait?.(wait);
				await delay(wait);
				continue;
			}
			if (response.status === 429) {
				throw new WikipediaError("Wikipedia is limiting requests right now. Try again in a minute.");
			}
			if (response.status >= 400) {
				throw new WikipediaError(`${site} returned an error (HTTP ${response.status}).`);
			}
			return response;
		}
	}
}

/** A response header, whatever its capitalization. */
function header(response: RequestUrlResponse, name: string): string | undefined {
	const key = Object.keys(response.headers).find((k) => k.toLowerCase() === name);
	return key ? response.headers[key] : undefined;
}

/** Follows normalization and redirects across one or more query responses. */
class TitleLookup {
	private readonly normalized = new Map<string, string>();
	private readonly redirects = new Map<string, Json>();
	private readonly pages = new Map<string, Json>();

	add(query: Json | undefined): void {
		for (const n of (query?.normalized ?? []) as Json[]) this.normalized.set(n.from, n.to);
		for (const r of (query?.redirects ?? []) as Json[]) this.redirects.set(r.from, r);
		for (const p of (query?.pages ?? []) as Json[]) this.pages.set(p.title, p);
	}

	resolve(original: string): ResolvedTitle {
		let title = this.normalized.get(original) ?? original;
		let fragment: string | null = null;
		const redirect = this.redirects.get(title);
		if (redirect) {
			title = redirect.to;
			fragment = redirect.tofragment ?? null;
		}
		const page = this.pages.get(title);
		const isArticle = !!page && page.ns === 0 && !page.missing && !page.invalid;
		return { title, isArticle, fragment };
	}
}

/** Caps how many requests are in flight at once, across every client. */
class RequestLimiter {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly max: number) {}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

const limiter = new RequestLimiter(MAX_CONCURRENT_REQUESTS);

function backoffMs(response: RequestUrlResponse, attempt: number): number {
	const retryAfter = Number(header(response, "retry-after"));
	const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_BACKOFF_MS * 2 ** attempt;
	return Math.min(ms, MAX_BACKOFF_MS);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** "AC/DC (band)" → "AC/DC_(band)", keeping slashes and colons readable. */
export function encodeTitle(title: string): string {
	return encodeURIComponent(title.replace(/ /g, "_"))
		.replace(/%2F/g, "/")
		.replace(/%3A/g, ":");
}

/** The parse API's page properties come back as an object or, in some setups, an array. */
function shortDescription(properties: unknown): string | null {
	if (Array.isArray(properties)) {
		const entry = properties.find((p: Json) => p.name === "wikibase-shortdesc");
		return entry?.["*"] ?? entry?.value ?? null;
	}
	if (properties && typeof properties === "object") {
		return (properties as Json)["wikibase-shortdesc"] ?? null;
	}
	return null;
}
