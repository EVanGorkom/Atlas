/**
 * Catches clicks on Atlas links whose article isn't in the vault yet.
 *
 * By default, clicking an unresolved [[link]] makes Obsidian create an empty note.
 * Every link click (reading view, Live Preview, mobile) goes through
 * `workspace.openLinkText`, so Atlas wraps that one method: if the link points into
 * the Atlas folder and no note exists there, it shows the Import / Open in browser
 * dialog instead. Every other link behaves exactly as before.
 *
 * This is the riskiest part of the plugin: `openLinkText` is public API, but relying on
 * every click path going through it needs confirming in a real vault, on desktop and mobile.
 */
import { around } from "monkey-around";
import { OpenViewState, PaneType, TFile, Workspace, getLinkpath } from "obsidian";
import type AtlasPlugin from "../main";
import { isLanguageCode } from "../settings";
import { MissingArticleModal } from "../ui/MissingArticleModal";

export function installLinkInterceptor(plugin: AtlasPlugin): void {
	plugin.register(
		around(plugin.app.workspace, {
			openLinkText(original) {
				return function (
					this: Workspace,
					linktext: string,
					sourcePath: string,
					newLeaf?: PaneType | boolean,
					openViewState?: OpenViewState,
				): Promise<void> {
					if (handleMissingArticle(plugin, linktext, sourcePath, newLeaf)) return Promise.resolve();
					return original.call(this, linktext, sourcePath, newLeaf, openViewState);
				};
			},
		}),
	);
}

/** Returns true if the click was handled (the dialog was shown). */
function handleMissingArticle(
	plugin: AtlasPlugin,
	linktext: string,
	sourcePath: string,
	newLeaf?: PaneType | boolean,
): boolean {
	try {
		const { app, importer } = plugin;
		const linkpath = getLinkpath(linktext);
		if (!linkpath || app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)) return false;

		// Only links into the Atlas folder. Your own unresolved links keep working as usual.
		const prefix = importer.linkPrefix;
		if (!prefix || !linkpath.startsWith(prefix)) return false;

		const filename = linkpath.slice(prefix.length).replace(/\.md$/, "");
		const title = plugin.titleIndex[filename] ?? filename;
		const lang = sourceLanguage(plugin, sourcePath) ?? plugin.settings.language;

		// Already imported under another filename (e.g. "Red Dwarf (2)" because "Red dwarf"
		// was taken): open that note, keeping any #heading from the link.
		const existing = importer.existingNote(title);
		if (existing) {
			const subpath = linktext.slice(linktext.indexOf(linkpath) + linkpath.length);
			void app.workspace.openLinkText(existing.path.replace(/\.md$/, "") + subpath, sourcePath, newLeaf);
			return true;
		}

		new MissingArticleModal(app, {
			title,
			lang,
			onOpenInBrowser: () => window.open(plugin.client(lang).articleUrl(title)),
			onImport: () => {
				void importer.tryImport(title, lang).then(async (file) => {
					if (!file) return;
					// A #heading can only be found once Obsidian has indexed the new note.
					await whenIndexed(plugin, file);
					// Follow the original link (keeps any #heading) if it now resolves; if the
					// article landed under a different name, open the note directly so this
					// never loops back into the dialog.
					if (app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)) {
						await app.workspace.openLinkText(linktext, sourcePath, newLeaf);
					} else {
						await app.workspace.getLeaf(newLeaf ?? false).openFile(file);
					}
				});
			},
		}).open();
		return true;
	} catch (error) {
		console.error("Atlas: link handling failed, falling back to Obsidian's default", error);
		return false;
	}
}

/** Resolves once the metadata cache has parsed `file` (or after a timeout, to never hang). */
function whenIndexed(plugin: AtlasPlugin, file: TFile, timeoutMs = 5000): Promise<void> {
	const cache = plugin.app.metadataCache;
	if (cache.getFileCache(file)) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			cache.offref(ref);
			window.clearTimeout(timer);
			resolve();
		};
		const ref = cache.on("changed", (changed) => {
			if (changed.path === file.path) done();
		});
		const timer = window.setTimeout(done, timeoutMs);
	});
}

/** Links import from the same language's Wikipedia as the note they're in. */
function sourceLanguage(plugin: AtlasPlugin, sourcePath: string): string | null {
	const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
	const lang = file instanceof TFile ? plugin.app.metadataCache.getFileCache(file)?.frontmatter?.lang : null;
	return isLanguageCode(lang) ? lang : null;
}
