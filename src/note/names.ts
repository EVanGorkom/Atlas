/**
 * Decides which note filename each Wikipedia title gets.
 *
 * Usually that's just `titleToFilename(title)`. But Obsidian resolves links without regard
 * to case, and macOS and Windows file systems ignore case too, so "Red dwarf" (the star)
 * and "Red Dwarf" (the TV series) can't both be "Red ….md": the second import fails with
 * "File already exists", and every link to one opens the other. Two titles can also clean
 * up to the same filename ("AC/DC" and "AC-DC").
 *
 * So a filename is only handed out if no *other* title already holds it, ignoring case.
 * Otherwise the title gets a numbered filename ("Red Dwarf (2)"), which the importer
 * records in the plugin's title index so the same title gets the same filename next time.
 *
 * Kept free of Obsidian imports so it can be tested on its own.
 */
import { titleToFilename } from "../util/filename";

export interface NameSources {
	/** Notes already in the Atlas folder: filename (no folder or ".md") and, if known, title. */
	notes: Iterable<{ filename: string; title?: string }>;
	/** Filenames that links in the vault point to but that have no note yet, exactly as written. */
	links: Iterable<string>;
	/** The plugin's title index: filename → title, for filenames that differ from their title. */
	titleIndex: Record<string, string>;
}

export class NoteNames {
	/** Lower-cased filename → every spelling of it in use. */
	private readonly spellings = new Map<string, Set<string>>();
	/** Exact filenames of existing notes. */
	private readonly notes = new Set<string>();
	/** Filename → title, where it isn't simply the filename. */
	private readonly owners = new Map<string, string>();
	/** Title → filename, for titles that already have a filename. */
	private readonly assigned = new Map<string, string>();
	/** Filename → title, for filenames handed out by this instance that differ from their title. */
	readonly renamed: Record<string, string> = {};

	constructor(sources: NameSources) {
		for (const [filename, title] of Object.entries(sources.titleIndex)) {
			this.take(filename);
			this.owners.set(filename, title);
			if (!this.assigned.has(title)) this.assigned.set(title, filename);
		}
		for (const { filename, title } of sources.notes) {
			this.take(filename);
			this.notes.add(filename);
			// A note's own frontmatter beats the index.
			if (title && title !== filename) this.owners.set(filename, title);
			if (title) this.assigned.set(title, filename);
		}
		for (const filename of sources.links) this.take(filename);
	}

	/** The filename for `title`, reserving it so no other title can get it from this instance. */
	filenameFor(title: string): string {
		const known = this.assigned.get(title);
		if (known) return known;

		const base = titleToFilename(title);
		let filename = base;
		for (let n = 2; !this.isFreeFor(filename, title); n++) filename = `${base} (${n})`;

		this.take(filename);
		this.owners.set(filename, title);
		this.assigned.set(title, filename);
		if (filename !== title) this.renamed[filename] = title;
		return filename;
	}

	/**
	 * Whether `title` may use `filename`. A filename missing from the title index belongs to
	 * the title it spells, since Atlas records every filename that differs from its title.
	 */
	private isFreeFor(filename: string, title: string): boolean {
		const ownedByTitle = (this.owners.get(filename) ?? filename) === title;
		// This title's existing note keeps its name, whatever links in other cases exist.
		if (this.notes.has(filename)) return ownedByTitle;

		const used = this.spellings.get(filename.toLowerCase());
		if (!used) return true;
		// Another spelling (a note, or a link to some other title) already claims it.
		if (used.size > 1 || !used.has(filename)) return false;
		return ownedByTitle;
	}

	private take(filename: string): void {
		const key = filename.toLowerCase();
		const set = this.spellings.get(key) ?? new Set<string>();
		set.add(filename);
		this.spellings.set(key, set);
	}
}
