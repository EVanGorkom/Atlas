/**
 * Streams the lines of the files inside a tar archive, without unpacking it to disk.
 * Enough of the format for Wikimedia's dumps: regular files (including sizes over 8 GB,
 * stored in base-256), with directories and pax/GNU extension headers skipped.
 */
import type { Readable } from "node:stream";

const BLOCK = 512;

export async function* tarLines(input: Readable): AsyncGenerator<{ file: string; line: string }> {
	let buffer: Buffer = Buffer.alloc(0);
	let file = "";
	let left = 0; // data bytes left in the current entry
	let padAfter = 0; // padding to skip once the current entry's data is read
	let skip = 0; // bytes to discard now
	let wanted = false; // whether the current entry's lines are yielded
	let partial: Buffer[] = [];

	for await (const chunk of input) {
		buffer = buffer.length ? Buffer.concat([buffer, chunk as Buffer]) : (chunk as Buffer);

		while (buffer.length) {
			if (left) {
				const n = Math.min(left, buffer.length);
				const data = buffer.subarray(0, n);
				buffer = buffer.subarray(n);
				left -= n;
				if (wanted) {
					let start = 0;
					for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
						partial.push(data.subarray(start, nl));
						const line = Buffer.concat(partial).toString("utf8");
						partial = [];
						start = nl + 1;
						if (line) yield { file, line };
					}
					// Copy: the chunk's memory may be reused by the stream.
					if (start < data.length) partial.push(Buffer.from(data.subarray(start)));
				}
				if (!left) {
					if (wanted && partial.length) {
						const line = Buffer.concat(partial).toString("utf8");
						partial = [];
						if (line) yield { file, line };
					}
					skip = padAfter;
				}
				continue;
			}
			if (skip) {
				const n = Math.min(skip, buffer.length);
				skip -= n;
				buffer = buffer.subarray(n);
				continue;
			}

			// A header block.
			if (buffer.length < BLOCK) break;
			const header = buffer.subarray(0, BLOCK);
			buffer = buffer.subarray(BLOCK);
			if (header.every((byte) => byte === 0)) continue; // end-of-archive blocks

			const name = cString(header.subarray(0, 100));
			const prefix = cString(header.subarray(345, 500));
			const size = entrySize(header.subarray(124, 136));
			const type = String.fromCharCode(header[156] || 48); // NUL counts as "0", a regular file
			const padding = (BLOCK - (size % BLOCK)) % BLOCK;

			wanted = type === "0" || type === "7";
			file = prefix ? `${prefix}/${name}` : name;
			if (size) {
				left = size;
				padAfter = padding;
			}
		}
	}
}

function cString(field: Buffer): string {
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Octal size, or base-256 (first byte has the high bit set) for entries over 8 GB. */
function entrySize(field: Buffer): number {
	if (field[0] & 0x80) {
		let size = 0;
		for (let i = 1; i < field.length; i++) size = size * 256 + field[i];
		return size;
	}
	return parseInt(cString(field).trim() || "0", 8);
}
