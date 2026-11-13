import assert from "node:assert/strict";
import { it } from "node:test";
import { localDate } from "../src/note/importer";

it("dates an import by the local calendar day, not UTC", () => {
	// 11:30 pm local time: still the 12th here, whatever the UTC date is.
	assert.equal(localDate(new Date(2026, 10, 12, 23, 30)), "2026-11-12");
	assert.equal(localDate(new Date(2026, 0, 5, 0, 15)), "2026-01-05");
});
