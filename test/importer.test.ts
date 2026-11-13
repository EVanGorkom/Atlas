import assert from "node:assert/strict";
import { it } from "node:test";
import { localDate } from "../src/note/importer";

it("dates an import by the local calendar day, not UTC", () => {
	// 11:30 pm local time: still the 12th here, whatever the UTC date is.
	assert.equal(localDate(new Date(2026, 10, 12, 23, 30)), "2026-11-12");
	assert.equal(localDate(new Date(2026, 0, 5, 0, 15)), "2026-01-05");
});

import { noteProperties, userProperties } from "../src/note/importer";

const ARTICLE = { title: "Albert Einstein", revId: 42, description: "Physicist", categories: ["1879 births", "Swiss physicists"] };
const SOURCE = "https://en.wikipedia.org/wiki/Albert_Einstein";

it("writes Atlas's properties, with categories only when the setting asks for them", () => {
	const day = new Date(2026, 10, 12, 21, 0);
	assert.deepEqual(noteProperties(ARTICLE, "en", SOURCE, { categories: "property" }, {}, day), {
		wikipedia_title: "Albert Einstein",
		lang: "en",
		source: SOURCE,
		revid: 42,
		retrieved: "2026-11-12",
		description: "Physicist",
		categories: ["1879 births", "Swiss physicists"],
		license: "CC BY-SA 4.0",
	});
	assert.equal("categories" in noteProperties(ARTICLE, "en", SOURCE, { categories: "none" }, {}, day), false);
});

it("keeps properties the user added when updating, but not stale Atlas ones", () => {
	const old = { wikipedia_title: "Albert Einstein", revid: 1, categories: ["Old"], tags: ["physics"], rating: 5 };
	const extra = userProperties(old);
	assert.deepEqual(extra, { tags: ["physics"], rating: 5 });
	const updated = noteProperties(ARTICLE, "en", SOURCE, { categories: "none" }, extra);
	assert.equal(updated.revid, 42);
	assert.equal("categories" in updated, false);
	assert.deepEqual(updated.tags, ["physics"]);
	assert.deepEqual(Object.keys(updated).slice(-2), ["tags", "rating"]);
});
