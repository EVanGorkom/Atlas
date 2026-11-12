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
