import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { it } from "node:test";
import { tarLines } from "../tools/tar";

/** A 512-byte tar header. Checksums aren't verified by the reader, so they're left blank. */
function header(name: string, size: number, type = "0", base256 = false): Buffer {
	const block = Buffer.alloc(512);
	block.write(name, 0, "utf8");
	if (base256) {
		block[124] = 0x80;
		block.writeUIntBE(size, 136 - 6, 6);
	} else {
		block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	}
	block.write(type, 156, "ascii");
	block.write("ustar\0", 257, "ascii");
	return block;
}

function entry(name: string, content: string, type = "0", base256 = false): Buffer {
	const data = Buffer.from(content, "utf8");
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return Buffer.concat([header(name, data.length, type, base256), data, padding]);
}

/** Feeds the archive in small chunks, so lines and headers straddle chunk boundaries. */
function chunked(buffer: Buffer, size: number): Readable {
	const chunks: Buffer[] = [];
	for (let i = 0; i < buffer.length; i += size) chunks.push(buffer.subarray(i, i + size));
	return Readable.from(chunks);
}

it("reads every line of every file, skipping directories and pax headers", async () => {
	const archive = Buffer.concat([
		entry("dump/", "", "5"),
		entry("PaxHeader/a.ndjson", "30 path=enwiki_namespace_0_0.ndjson\n", "x"),
		entry("a.ndjson", '{"name":"Ulm"}\n{"name":"Zürich ✓"}\n'),
		// No trailing newline on the last line, and a size written in base-256.
		entry("b.ndjson", '{"name":"Bern"}\n{"name":"Basel"}', "0", true),
		Buffer.alloc(1024), // end-of-archive blocks
	]);
	for (const size of [7, 512, 100_000]) {
		const lines: string[] = [];
		for await (const { file, line } of tarLines(chunked(archive, size))) lines.push(`${file}: ${line}`);
		assert.deepEqual(
			lines,
			['a.ndjson: {"name":"Ulm"}', 'a.ndjson: {"name":"Zürich ✓"}', 'b.ndjson: {"name":"Bern"}', 'b.ndjson: {"name":"Basel"}'],
			`chunk size ${size}`,
		);
	}
});
