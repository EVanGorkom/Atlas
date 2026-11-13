import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectCategory, type FetchMembers } from "../src/wiki/categories";

// Physics → Mechanics → Classical mechanics → Physics (a loop), with shared articles.
const GRAPH: Record<string, { pages: string[]; subcategories: string[] }> = {
	"Category:Physics": { pages: ["Physics", "Energy"], subcategories: ["Category:Mechanics", "Category:Optics"] },
	"Category:Mechanics": { pages: ["Mechanics", "Energy"], subcategories: ["Category:Classical mechanics"] },
	"Category:Optics": { pages: ["Optics", "Lens"], subcategories: [] },
	"Category:Classical mechanics": { pages: ["Newton's laws of motion"], subcategories: ["Category:Physics"] },
};

function fakeFetch(): { fetch: FetchMembers; calls: string[] } {
	const calls: string[] = [];
	const fetch: FetchMembers = async (category) => {
		calls.push(category);
		return GRAPH[category] ?? { pages: [], subcategories: [] };
	};
	return { fetch, calls };
}

describe("collectCategory", () => {
	it("reads only the category itself at depth 0", async () => {
		const { fetch, calls } = fakeFetch();
		const result = await collectCategory("Category:Physics", fetch, { depth: 0, limit: 100 });
		assert.deepEqual(result, { titles: ["Physics", "Energy"], categories: 1, truncated: false });
		assert.deepEqual(calls, ["Category:Physics"]);
	});

	it("walks breadth-first, skipping duplicate articles and categories already visited", async () => {
		const { fetch, calls } = fakeFetch();
		const result = await collectCategory("Category:Physics", fetch, { depth: 5, limit: 100 });
		assert.deepEqual(result.titles, ["Physics", "Energy", "Mechanics", "Optics", "Lens", "Newton's laws of motion"]);
		assert.deepEqual(calls, ["Category:Physics", "Category:Mechanics", "Category:Optics", "Category:Classical mechanics"]);
		assert.equal(result.truncated, false);
	});

	it("stops at the article limit and says so", async () => {
		const { fetch } = fakeFetch();
		const result = await collectCategory("Category:Physics", fetch, { depth: 5, limit: 4 });
		assert.deepEqual(result.titles, ["Physics", "Energy", "Mechanics", "Optics"]);
		assert.equal(result.truncated, true);
	});

	it("stops between requests when cancelled", async () => {
		const { fetch, calls } = fakeFetch();
		let cancelled = false;
		const result = await collectCategory("Category:Physics", fetch, {
			depth: 5,
			limit: 100,
			onProgress: () => (cancelled = true),
			isCancelled: () => cancelled,
		});
		assert.deepEqual(calls, ["Category:Physics"]);
		assert.equal(result.truncated, true);
	});
});
