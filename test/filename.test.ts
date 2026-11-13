import assert from "node:assert/strict";
import { it } from "node:test";
import { imageFilename } from "../src/util/filename";

const THUMB = "https://thumb.wikimedia.org/wikipedia/commons/thumb";

it("names a downloaded thumbnail after the original file, with the thumbnail's extension", () => {
	assert.equal(
		imageFilename(`${THUMB}/2/28/Albert_Einstein_Head_cleaned.jpg/250px-Albert_Einstein_Head_cleaned.jpg?utm_source=en.wikipedia.org`),
		"Albert_Einstein_Head_cleaned.jpg",
	);
	assert.equal(imageFilename(`${THUMB}/d/d7/Signature_1934.svg/250px-Signature_1934.svg.png`), "Signature_1934.svg.png");
	assert.equal(imageFilename(`${THUMB}/a/a1/Scan.tif/lossless-page1-250px-Scan.tif.png`), "Scan.tif.png");
	assert.equal(imageFilename(`${THUMB}/b/b2/Book.pdf/page2-120px-Book.pdf.jpg`), "Book.pdf.jpg");
});

it("decodes and cleans the name", () => {
	assert.equal(
		imageFilename(`${THUMB}/3/33/Einstein_1921_%283x4%29.jpg/120px-Einstein_1921_%283x4%29.jpg`),
		"Einstein_1921_(3x4).jpg",
	);
	assert.equal(imageFilename("https://upload.wikimedia.org/wikipedia/commons/6/65/A%3AB%23C.gif"), "A-B-C.gif");
});

it("refuses things Obsidian can't show as an image", () => {
	assert.equal(imageFilename("https://upload.wikimedia.org/wikipedia/commons/1/11/Talk.ogg"), null);
	assert.equal(imageFilename("https://upload.wikimedia.org/wikipedia/commons/1/11/noextension"), null);
	assert.equal(imageFilename("not a url"), null);
});
