# Atlas

An Obsidian plugin that brings Wikipedia into your vault: articles become Markdown notes you can read offline, linked to each other like the rest of your notes.

## Goals

1. **Offline reading.** Imported articles are plain Markdown notes stored on the device, on desktop and mobile.
2. **A connected knowledge graph.** Links between articles are real Obsidian links, so backlinks, graph view and search just work.
3. **Grow the vault as you read.** Clicking a link to an article you haven't imported asks: **Import** or **Open in browser**.
4. **Clean, attributed notes.** Readable Markdown without Wikipedia's page clutter; source and license kept on every note.
5. **Built to scale.** Bulk and category import come later without a rewrite.

## MVP scope

- Command and ribbon button **Import Wikipedia article**: live search, pick a result, the full article is imported and opened.
- Cleanup: footnote markers, edit links, navboxes, maintenance banners, text Wikipedia hides with CSS (sort keys, microformat dates, citation maintenance messages) and excluded sections are removed. Headings, lists, tables, code (as fenced blocks), images and math (as LaTeX) are kept. Infoboxes become a lead image plus a two-column table; tables nested in table cells are flattened into the cell.
- Every link to another article becomes `[[Wikipedia/Title|text]]`. Redirects are resolved at import, so `Einstein` links to `Albert Einstein`.
- Clicking a link whose article isn't in the vault shows the Import / Open in browser dialog instead of creating an empty note.
- Frontmatter: `wikipedia_title`, `lang`, `source`, `revid`, `retrieved`, `description`, `categories`, `license`.
- Images: the lead image is downloaded into `Wikipedia/Images` and embedded as `![[…]]`, so it shows offline; the rest stay hotlinked. A setting switches to all images or none.
- Search marks articles that are already in the vault; choosing one opens it.
- **Update this article from Wikipedia** (command, or right-click the note): checks the note's `revid` against Wikipedia and, after asking, replaces the article text with the latest revision. Properties you added are kept.
- **Bulk import**, from three sources:
  - **Import a Wikipedia category**: search categories (with article and subcategory counts), choose how many levels of subcategories to include and a maximum, see what that finds, with a sample, then import.
  - **Import the articles listed on a Wikipedia page**: an outline ("Outline of physics"), a "List of …" article, or one of Wikipedia's *Vital articles* lists. Only links in the page body count, not navboxes or references.
  - **Import the articles this note links to** (also on right-click).

  Runs import one article at a time with progress and a Cancel button, skip articles already in the vault, and are capped at 10,000 articles. Progress is saved, so a run interrupted by closing Obsidian continues with **Resume bulk import** (or **Discard bulk import**).
- Settings: Wikipedia language, folder, open after import, image downloads and folder, categories (property or left out), sections to leave out.

**Later:** checking every article for updates at once, Wikidata fields, multiple languages per vault.

## Design decisions

| Question | Choice | Why |
|---|---|---|
| Link format | Links include the folder: `[[Wikipedia/Python (programming language)\|Python]]` | They never resolve to your own note called "Python". Trade-off: if the folder setting changes, links to not-yet-imported articles keep the old folder. |
| Unresolved-link clicks | Wrap `workspace.openLinkText` (via `monkey-around`) | One place every link click goes through, in reading view, Live Preview and on mobile. Only links into the Atlas folder are affected. |
| Link resolution | `generator=links` for the article, falling back to `titles=` batches | About 2–3 requests per article instead of one per 50 links, which keeps clear of Wikimedia's rate limits. |
| Math | MathML → LaTeX with `mathml-to-latex` | Wikipedia now serves MathML without the TeX source; Obsidian renders LaTeX. Falls back to keeping the MathML. |
| Images | Lead image downloaded by default; "all" and "none" are settings. Named after the original file (`Albert_Einstein_Head.jpg`) and shared between articles | The lead image is what makes a note recognisable offline, at ~25–100 KB. All images for Mount Fuji is 17 files, 0.5 MB. Icons under 40 px and files over 2 MB (unscaled animated GIFs) stay hotlinked. |
| Updating articles | Replace the whole text after a confirmation; keep any frontmatter key Atlas doesn't write | Merging your edits into a new revision isn't reliable. Write your own notes in a separate note that links to the article, or add properties. |
| Bulk import | One article at a time, 1 s apart. On repeated 429s, wait 2 minutes and retry; after three waits, stop and keep the queue to resume | Each article is 4–6 requests. Wikimedia limits clients without contact info in the User-Agent (`PROJECT_URL`). About 5 s per article: 1,000 articles take ~1.4 hours. |
| Category depth | Breadth-first, each category once, with a depth (0–3) and article limit, and a sample shown before importing | Categories form a graph with loops, and a few levels down they drift off topic. |
| All of Wikipedia | Not offered | 7.2 million articles at 4–6 requests each would take months through the API, which Wikimedia asks bulk users not to do (dumps exist for that), and a vault of millions of notes is beyond what Obsidian indexes comfortably. For all of Wikipedia offline, use a Kiwix ZIM file; the largest realistic Atlas imports are the *Vital articles* lists (up to ~50,000). |
| Unsafe titles | `AC/DC` is saved as `AC-DC.md`; the plugin's `data.json` remembers the real title | Some characters are illegal in filenames or break links. |
| Titles differing only in case | The first title to claim a name keeps it; the other gets a numbered filename: `Red dwarf.md` (the star), `Red Dwarf (2).md` (the TV series), recorded in `data.json` | Obsidian resolves links case-insensitively, and so do the macOS and Windows file systems. Claims come from existing notes, not-yet-imported links in the vault, and `data.json`; see `src/note/names.ts`. |

## Development

Requires Node 20+.

```bash
npm install
npm run dev     # rebuilds main.js on every change
npm run build   # type-check + production build
npm run typecheck  # the plugin and tools/
npm test        # conversion, filename and converter tests (no network)
```

The tests run the conversion pipeline under Node with a stand-in for the `obsidian` module (`test/support/obsidian-stub.ts`). Its `htmlToMarkdown` is Turndown, which is close to Obsidian's converter but not identical: Obsidian always writes tables as Markdown, where Turndown keeps complex ones as HTML. So check conversion changes in Obsidian too.

To try it in Obsidian, make the repo appear as a plugin folder in a **test vault**:

```bash
# macOS / Linux
ln -s "/path/to/Atlas" "<vault>/.obsidian/plugins/atlas"

# Windows (Command Prompt), creates a directory junction
mklink /J "<vault>\.obsidian\plugins\atlas" "C:\Users\<you>\Coding\Atlas"
```

Then enable **Atlas** in Settings → Community plugins. With `npm run dev` running, use "Reload app without saving" (or the Hot-Reload plugin) to pick up changes.

## Importing from a Wikipedia dump (experimental)

For imports too big for the API, `tools/dump-import.ts` converts a [Wikimedia Enterprise HTML dump](https://dumps.wikimedia.org/other/enterprise_html/) straight into a vault. It runs in Node, outside Obsidian, uses the plugin's own conversion code, and makes no API calls.

```bash
# English Wikipedia, March 2025 (the newest HTML dump; 140 GB, streamed, never stored)
DUMP=https://dumps.wikimedia.org/other/enterprise_html/runs/20250320/enwiki-NS0-20250320-ENTERPRISE-HTML.json.tar.gz

npm run dump-import -- --dump "$DUMP" --vault "/path/to/vault" --limit 2000
```

| Option | |
|---|---|
| `--dump <file or URL>` | A downloaded `.json.tar.gz` dump, or its URL |
| `--vault <folder>` | The vault to write into |
| `--folder <name>` | Article folder in the vault (default `Wikipedia`) |
| `--limit <n>` / `--skip <n>` | Write at most n notes / skip the first n records |
| `--overwrite` | Replace existing notes (default: leave them alone) |
| `--categories property\|none` | Keep categories as a property (maintenance categories are filtered out) |
| `--build-redirects <file>` | Instead of converting, read the whole dump and write a redirect → article map |
| `--redirects <file>` | Use that map, so links through redirects point at the real article |

- Notes look like plugin imports, dated to the dump (`retrieved: 2025-03-20`); run **Update this article from Wikipedia** on any note to bring it up to date. Images stay hotlinked.
- Filenames that had to change are written to `.obsidian/plugins/atlas/dump-title-index.json`; the plugin merges them into its title index the next time it loads.
- Dump articles come in no particular order, so with `--limit` you get a random sample, and most links point at articles not in the vault (clicking one offers to import it).
- Measured: ~47 articles/s from a local file and ~32/s streamed to an exFAT drive, on one core, under 500 MB of memory. 2,000 notes in a vault Obsidian already had open were indexed live without trouble.

**A full copy isn't supported yet.** English Wikipedia is 7.26 million articles: about 2–3 days of conversion on one core and roughly 50 GB of notes. One folder on an exFAT drive can't hold that many files, so a full run needs either subfolders (which changes the link format) or a different file system, and how Obsidian copes with millions of notes is unmeasured. The newest wikitext dump is current, but it's unrendered wikitext, which this converter can't use.

## Project structure

```
src/
  main.ts                    plugin entry: commands, ribbon, settings, data.json
  settings.ts                settings model and settings tab
  wiki/api.ts                Wikipedia client: search, parse, link resolution, rate limiting
  wiki/clean.ts              HTML cleanup, link rewriting, infoboxes, math (no Obsidian imports)
  wiki/placeholders.ts       shields wikilinks/LaTeX from the HTML→Markdown converter
  wiki/markdown.ts           HTML → Markdown
  note/importer.ts           fetch → convert → write note, frontmatter, attribution
  note/names.ts              title → note filename, avoiding case and cleanup collisions
  links/interceptor.ts       Import / Open in browser for links to missing articles
  ui/ArticleSearchModal.ts   live search box
  ui/MissingArticleModal.ts  the Import / Open in browser dialog
  util/filename.ts           Wikipedia title → safe filename
test/                        Node tests; fixtures are trimmed real Wikipedia markup
scripts/test.mjs             bundles and runs the tests
tools/dump-import.ts         dump → notes converter (Node; see above)
tools/tar.ts                 streams lines out of a .tar archive
tools/markdown-shim.ts       Obsidian-like htmlToMarkdown for running outside Obsidian
scripts/dump-import.mjs      bundles and runs the converter
```

## Before release

- Set `PROJECT_URL` in `src/main.ts`. Wikimedia gives clients with contact info in their User-Agent 200 requests/minute instead of 10.
- Fill in `author` in `manifest.json` and pick a license for the code.
- Check that the plugin ID `atlas` isn't already taken in the community directory.

## Known limitations

- **Tested in Obsidian 1.15 on macOS desktop** (reading view and Live Preview): import from search, the Import / Open in browser dialog, imports from it, and that your own links are unaffected. Not yet tested on mobile.
- Links written before titles differing only in case got separate filenames may still open the wrong one of the pair; deleting and re-importing the note that contains them fixes it.
- Tables with merged cells (rowspan/colspan) become plain Markdown tables, so the merged layout is lost. Tables nested in cells are flattened to text.
- Code inside table cells becomes one inline `<code>` per line, without highlighting.
- Updating an article replaces anything you wrote in its text (the confirmation says so). Properties you added are kept.
- Images in infobox data cells (flags, location maps) are dropped, as before; only the infobox's lead image is kept.
- Bulk-import progress is saved every 10 articles, so after a restart the count can be slightly behind; resuming skips the articles already done.
- Large vaults: every import scans the vault's notes and unresolved links to choose filenames. Fine at thousands of articles; not yet measured at tens of thousands.
- Category and bulk imports will need a request queue with pacing; the client already limits concurrency and backs off on HTTP 429.

## Attribution

Wikipedia text is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Atlas records the source and license in every imported note.
