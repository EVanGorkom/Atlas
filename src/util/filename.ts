/**
 * Turns a Wikipedia title into a safe note filename (without extension).
 *
 * Wikipedia titles can contain characters that are illegal in filenames on some
 * platforms (`/ \ : * ? " < > |`) or that break Obsidian links (`# ^ [ ] |`).
 * When the result differs from the title, the importer records the mapping so the
 * real title can be recovered later.
 *
 *   "AC/DC"                       → "AC-DC"
 *   "Star Wars: A New Hope"       → "Star Wars - A New Hope"
 *   "Who Framed Roger Rabbit?"    → "Who Framed Roger Rabbit"
 *   ".hack"                       → "hack"   (dotfiles are hidden from the vault)
 */
export function titleToFilename(title: string): string {
	const name = title
		.replace(/[\\/]/g, "-")
		.replace(/:/g, " -")
		.replace(/[*?"<>|#^[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "");
	return name || "Untitled article";
}

/** Image formats Obsidian can embed. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp"]);

/**
 * Turns a Wikimedia image URL into a filename for the downloaded copy, or null if it isn't
 * an image Obsidian can show. Thumbnails are named after the original file, keeping the
 * thumbnail's own extension (an SVG's thumbnail is a PNG):
 *
 *   …/thumb/2/28/Albert_Einstein_Head.jpg/250px-Albert_Einstein_Head.jpg → "Albert_Einstein_Head.jpg"
 *   …/thumb/d/d7/Signature.svg/250px-Signature.svg.png                   → "Signature.svg.png"
 *   …/commons/6/65/Pythag_anim.gif                                       → "Pythag_anim.gif"
 */
export function imageFilename(url: string): string | null {
	let last: string;
	try {
		last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
	} catch {
		return null;
	}
	const name = last
		// Thumbnail size prefixes: "250px-", "lossless-page1-250px-", "page2-120px-".
		.replace(/^(?:[a-z]+-)*(?:page\d+-)?\d+px-/, "")
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
	return name && extension && IMAGE_EXTENSIONS.has(extension) ? name : null;
}
