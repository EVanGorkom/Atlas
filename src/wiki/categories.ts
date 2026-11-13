/**
 * Collects the articles in a category and, optionally, its subcategories.
 *
 * Wikipedia's category graph isn't a tree: categories can sit in several parents and
 * loops exist, and a few levels down it drifts far off topic ("Physics" → … → individual
 * universities). So the walk is breadth-first, visits each category once, stops at a
 * depth and an article limit, and reports whether it was cut short.
 *
 * Kept free of Obsidian imports so it can be tested on its own.
 */

export interface CollectOptions {
	/** 0 = only the category itself, 1 = also its subcategories, and so on. */
	depth: number;
	/** Stop once this many articles are found. */
	limit: number;
	/** Called after each category is read. */
	onProgress?: (progress: { articles: number; categories: number }) => void;
	/** Checked between requests; returning true stops the walk early. */
	isCancelled?: () => boolean;
}

export interface CollectedCategory {
	/** Article titles, in the order found, without duplicates. */
	titles: string[];
	/** How many categories were read. */
	categories: number;
	/** True if the article limit was reached before the walk finished. */
	truncated: boolean;
}

export type FetchMembers = (category: string) => Promise<{ pages: string[]; subcategories: string[] }>;

export async function collectCategory(
	root: string,
	fetchMembers: FetchMembers,
	options: CollectOptions,
): Promise<CollectedCategory> {
	const titles = new Set<string>();
	const visited = new Set<string>([root]);
	let level = [root];
	let categories = 0;

	for (let depth = 0; level.length; depth++) {
		const nextLevel: string[] = [];
		for (const category of level) {
			if (options.isCancelled?.()) return { titles: [...titles], categories, truncated: true };

			const { pages, subcategories } = await fetchMembers(category);
			categories++;
			for (const page of pages) {
				titles.add(page);
				if (titles.size >= options.limit) {
					options.onProgress?.({ articles: titles.size, categories });
					return { titles: [...titles], categories, truncated: true };
				}
			}
			if (depth < options.depth) {
				for (const sub of subcategories) {
					if (!visited.has(sub)) {
						visited.add(sub);
						nextLevel.push(sub);
					}
				}
			}
			options.onProgress?.({ articles: titles.size, categories });
		}
		level = nextLevel;
	}
	return { titles: [...titles], categories, truncated: false };
}
