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
- Cleanup: footnote markers, edit links, navboxes, maintenance banners and excluded sections are removed. Headings, lists, tables, images (hotlinked) and math (as LaTeX) are kept. Infoboxes become a lead image plus a two-column table.
- Every link to another article becomes `[[Wikipedia/Title|text]]`. Redirects are resolved at import, so `Einstein` links to `Albert Einstein`.
- Clicking a link whose article isn't in the vault shows the Import / Open in browser dialog instead of creating an empty note.
- Frontmatter: `wikipedia_title`, `lang`, `source`, `revid`, `retrieved`, `description`, `categories`, `license`.
- Settings: Wikipedia language, folder, open after import, sections to leave out.

**Later:** category and bulk import, updating changed articles, image download, Wikidata fields, multiple languages per vault.

## Design decisions

| Question | Choice | Why |
|---|---|---|
| Link format | Links include the folder: `[[Wikipedia/Python (programming language)\|Python]]` | They never resolve to your own note called "Python". Trade-off: if the folder setting changes, links to not-yet-imported articles keep the old folder. |
| Unresolved-link clicks | Wrap `workspace.openLinkText` (via `monkey-around`) | One place every link click goes through, in reading view, Live Preview and on mobile. Only links into the Atlas folder are affected. |
| Link resolution | `generator=links` for the article, falling back to `titles=` batches | About 2–3 requests per article instead of one per 50 links, which keeps clear of Wikimedia's rate limits. |
| Math | MathML → LaTeX with `mathml-to-latex` | Wikipedia now serves MathML without the TeX source; Obsidian renders LaTeX. Falls back to keeping the MathML. |
| Images | Hotlinked for now | Downloading the lead image for offline use is the next step. |
| Unsafe titles | `AC/DC` is saved as `AC-DC.md`; the plugin's `data.json` remembers the real title | Some characters are illegal in filenames or break links. |

## Development

Requires Node 20+.

```bash
npm install
npm run dev     # rebuilds main.js on every change
npm run build   # type-check + production build
```

To try it in Obsidian, make the repo appear as a plugin folder in a **test vault**:

```bash
# Windows (Command Prompt), creates a directory junction
mklink /J "<vault>\.obsidian\plugins\atlas" "C:\Users\<you>\Coding\Atlas"
```

Then enable **Atlas** in Settings → Community plugins. With `npm run dev` running, use "Reload app without saving" (or the Hot-Reload plugin) to pick up changes.

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
  links/interceptor.ts       Import / Open in browser for links to missing articles
  ui/ArticleSearchModal.ts   live search box
  ui/MissingArticleModal.ts  the Import / Open in browser dialog
  util/filename.ts           Wikipedia title → safe filename
```

## Before release

- Set `PROJECT_URL` in `src/main.ts`. Wikimedia gives clients with contact info in their User-Agent 200 requests/minute instead of 10.
- Fill in `author` in `manifest.json` and pick a license for the code.
- Check that the plugin ID `atlas` isn't already taken in the community directory.

## Known limitations

- **Not yet tested inside Obsidian.** The conversion pipeline has been run against real articles outside Obsidian; the link interceptor and note writing have not.
- Titles that differ only by capitalization ("Red Dwarf" / "Red dwarf") collide on case-insensitive file systems (Windows, macOS).
- Complex tables that can't become Markdown tables stay as HTML, and links inside them show as raw `[[…]]` text.
- Category and bulk imports will need a request queue with pacing; the client already limits concurrency and backs off on HTTP 429.

## Attribution

Wikipedia text is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Atlas records the source and license in every imported note.
