import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NoteNames, type NameSources } from "../src/note/names";

const names = (sources: Partial<NameSources> = {}) =>
	new NoteNames({ notes: [], links: [], titleIndex: {}, ...sources });

describe("NoteNames", () => {
	it("uses the cleaned-up title when nothing is in the way", () => {
		const n = names();
		assert.equal(n.filenameFor("Albert Einstein"), "Albert Einstein");
		assert.equal(n.filenameFor("AC/DC"), "AC-DC");
		assert.deepEqual(n.renamed, { "AC-DC": "AC/DC" });
	});

	it("gives a title that differs only in case from an existing note its own filename", () => {
		const n = names({ notes: [{ filename: "Red dwarf", title: "Red dwarf" }] });
		assert.equal(n.filenameFor("Red Dwarf"), "Red Dwarf (2)");
		assert.equal(n.filenameFor("Red dwarf"), "Red dwarf");
		assert.deepEqual(n.renamed, { "Red Dwarf (2)": "Red Dwarf" });
	});

	it("treats an unresolved link as a claim by the title it spells", () => {
		const n = names({ links: ["Red dwarf"] });
		assert.equal(n.filenameFor("Red Dwarf"), "Red Dwarf (2)");
		assert.equal(n.filenameFor("Red dwarf"), "Red dwarf");
	});

	it("separates case variants that meet within one article", () => {
		const n = names();
		assert.equal(n.filenameFor("Red dwarf"), "Red dwarf");
		assert.equal(n.filenameFor("Red Dwarf"), "Red Dwarf (2)");
		assert.equal(n.filenameFor("RED DWARF"), "RED DWARF (3)");
	});

	it("keeps a filename the title index already gave a title", () => {
		const n = names({ titleIndex: { "Red Dwarf (2)": "Red Dwarf" }, notes: [{ filename: "Red dwarf" }] });
		assert.equal(n.filenameFor("Red Dwarf"), "Red Dwarf (2)");
		assert.deepEqual(n.renamed, {});
	});

	it("separates titles that clean up to the same filename", () => {
		const n = names({ notes: [{ filename: "AC-DC", title: "AC/DC" }] });
		assert.equal(n.filenameFor("AC/DC"), "AC-DC");
		assert.equal(n.filenameFor("AC-DC"), "AC-DC (2)");
	});

	it("separates a title from a filename another title was cleaned up to", () => {
		// "Red dwarf?" cleans up to "Red dwarf", which belongs to the article "Red dwarf".
		const n = names({ notes: [{ filename: "Red dwarf" }] });
		assert.equal(n.filenameFor("Red dwarf?"), "Red dwarf (2)");
	});

	it("still finds an existing note when links in other cases exist", () => {
		const n = names({ notes: [{ filename: "Red dwarf", title: "Red dwarf" }], links: ["Red Dwarf"] });
		assert.equal(n.filenameFor("Red dwarf"), "Red dwarf");
	});

	it("finds a note by its frontmatter title even if the index lost it", () => {
		const n = names({ notes: [{ filename: "Red Dwarf (2)", title: "Red Dwarf" }, { filename: "Red dwarf" }] });
		assert.equal(n.filenameFor("Red Dwarf"), "Red Dwarf (2)");
	});
});
