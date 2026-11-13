/**
 * What an Atlas note looks like: its properties, and the attribution at the end. Shared by
 * the plugin's importer and the dump converter (tools/), so both write the same notes.
 *
 * Kept free of Obsidian imports.
 */

export const LICENSE = "CC BY-SA 4.0";
export const LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

/** Properties Atlas writes. Anything else in a note's frontmatter is the user's. */
export const ATLAS_PROPERTIES = [
	"wikipedia_title",
	"lang",
	"source",
	"revid",
	"retrieved",
	"description",
	"categories",
	"license",
];

export interface ArticleFacts {
	title: string;
	revId: number;
	description: string | null;
	categories: string[];
}

/** The note's properties: Atlas's own, then any the user added (kept on update). */
export function noteProperties(
	article: ArticleFacts,
	lang: string,
	source: string,
	settings: { categories: "property" | "none" },
	extra: Record<string, unknown> = {},
	retrieved: Date | string = new Date(),
): Record<string, unknown> {
	const properties: Record<string, unknown> = {
		wikipedia_title: article.title,
		lang,
		source,
		revid: article.revId,
		retrieved: typeof retrieved === "string" ? retrieved : localDate(retrieved),
	};
	if (article.description) properties.description = article.description;
	if (settings.categories === "property" && article.categories.length) properties.categories = article.categories;
	properties.license = LICENSE;
	for (const [key, value] of Object.entries(extra)) {
		if (!ATLAS_PROPERTIES.includes(key)) properties[key] = value;
	}
	return properties;
}

/** Frontmatter entries the user added to an Atlas note. */
export function userProperties(frontmatter: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !ATLAS_PROPERTIES.includes(key)));
}

/** The full note: frontmatter, body, and the attribution line. */
export function noteText(frontmatterYaml: string, body: string, title: string, source: string): string {
	const attribution = `*From [${title}](${source}) on Wikipedia, available under [${LICENSE}](${LICENSE_URL}).*`;
	return `---\n${frontmatterYaml.trimEnd()}\n---\n\n${body}\n\n---\n\n${attribution}\n`;
}

/**
 * YAML for Atlas's properties (strings, numbers, string lists). Outside Obsidian there's
 * no stringifyYaml; strings are written plain when that's unambiguous, else JSON-quoted
 * (which is valid YAML).
 */
export function toYaml(properties: Record<string, unknown>): string {
	const scalar = (value: unknown): string => {
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		const text = String(value);
		// Dates stay plain so Obsidian shows them as dates, like notes the plugin writes.
		if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
		const plain =
			/^[^\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) &&
			!/: |\s#|\s$|:$/.test(text) &&
			!/^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_.e+-]*|\.inf|\.nan))$/i.test(text);
		return plain ? text : JSON.stringify(text);
	};
	return Object.entries(properties)
		.map(([key, value]) =>
			Array.isArray(value) ? `${key}:\n${value.map((item) => `  - ${scalar(item)}`).join("\n")}` : `${key}: ${scalar(value)}`,
		)
		.join("\n");
}

/** "YYYY-MM-DD" in local time. (toISOString is UTC, which dates evening imports tomorrow.) */
export function localDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
