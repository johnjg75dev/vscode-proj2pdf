# Project Source Exporter

Export the entire source code of your project to a **PDF** or the **clipboard**.

## Usage
- Command Palette → **Project Exporter: Export Project Source...** (`Ctrl+Alt+E` / `Cmd+Alt+E`)
- Or **Export Project Source to PDF** / **Copy Project Source to Clipboard**
- Or right-click a folder in the Explorer to export just that folder.

You'll be asked for:
1. The output (PDF or clipboard)
2. The options in a config panel (last choices are remembered):
   - Output: Include Markdown, Syntax highlighting (PDF only), Minify + level, Table of contents, Folder structure
   - Analysis Sections (optional appendices, placed before or after the source files)
   - Fonts and header/footer templates live in Settings (see below)
3. Where to save (PDF only)

## PDF features
- A title block with file and line counts
- A table of contents with page numbers and clickable links, plus PDF bookmarks (analysis sections included)
- A folder structure tree
- Optional analysis sections (Class List, Function List, Usages, String List, Dependencies)
- A header bar per file, optional line numbers and long lines wrapped at the page edge
- Configurable page header/footer templates (see below)

## File Filter
The export panel shows a **Files** section. Before it opens, the extension scans the
target folder(s) for project markers (`package.json`, `pyproject.toml`, `pom.xml`,
`*.csproj`, `go.mod`, `Cargo.toml`, ...) and tallies the extensions actually present,
then pre-selects what you most likely want (with per-extension file counts).

- **Extensions to include**: checkboxes for every detected extension, plus a free-form
  box for extras (`ts, .py, *.go`). Your last choice is remembered; **Reset to detected**
  restores the auto-detected set.
- **Extensions to ignore**: always wins over the include list (e.g. `map, lock`).
- **Files with other extensions**: `Include` (default to all files — also pulls in any other
  known code types from Settings) or `Exclude` (only the listed files, i.e. default to no files).

## Analysis Sections
Optional appendices enabled per section in the export panel or via `projectExporter.sections.*` settings.
Accurate parsing for TS/JS, Python, Java, C#, C++ and Go; best-effort heuristics for other languages.

- **Class List** (`sections.classList.*`): alphabetized (or by file/folder) class names, with or without
  ctor signatures, optionally grouped by file or folder, optionally showing method signatures and
  public/private fields, with default values on/off and base classes on/off.
- **Function List** (`sections.functionList.*`): same idea for functions (optionally including methods).
- **Usages** (`sections.usages.*`): under each class name, every `file:line` that instantiates it;
  same for functions (call sites). Capped by `maxHitsPerSymbol`; definition lines are excluded.
  `skipEmpty` (default on) omits symbols with zero hits; `summarizeEmpty` (default on)
  combines them into a single `N functions with no calls: ...` line instead.
- **String List** (`sections.strings.*`): string literals, alphabetized or by file, with min-length,
  dedupe and item-cap options.
- **Dependencies** (`sections.dependencies.*`): under each file, the files it relies on (`outgoing`),
  or the files that depend on it (`incoming`), or both. Unresolved imports can be shown or hidden.

## Fonts
Per-role PDF fonts under `projectExporter.pdf.fonts.{body,code,heading,headerFooter}.*`:
`family` (a built-in like `Courier`, `Helvetica`, `Helvetica-Bold`, `Times-Roman`, or `Custom`)
plus `path` (optional `.ttf`/`.otf`) and `size`. `pdf.fontPath` / `pdf.fontSize` remain as
deprecated aliases for the code font.

## Header & Footer
`projectExporter.pdf.headerTemplate` / `pdf.footerTemplate` (and `clipboard.headerTemplate` /
`clipboard.footerTemplate`) accept these `%%VARIABLES%%` (unknown ones are left as-is with a warning):

| Variable | Meaning |
|----------|---------|
| `%%PAGE%%` | Current page (PDF only) |
| `%%PAGES%%` | Total pages (PDF only) |
| `%%PROJECT%%` | Project/folder name |
| `%%DATE%%` / `%%TIME%%` | Export date / time |
| `%%FILE%%` | File shown on this page (PDF only) |
| `%%FILECOUNT%%` | Number of exported files |
| `%%SECTION%%` | Current section name (PDF only) |

Default footer: `%%PROJECT%% | Page %%PAGE%% of %%PAGES%%`. Empty template = no header/footer.

## Minify
- Every newline, indent and whitespace run is collapsed.
- Text flows continuously and fills each line to the last column before wrapping.
- `aggressive` mode (setting `projectExporter.minifyLevel`) also removes spaces next to punctuation such as `{ } ( ) ; , =`.
- Highlighting is computed *before* minifying, so colors stay correct.
- Minified output is for reading and printing only. Whitespace-sensitive languages such as Python won't run after minifying.

## Unicode
The built-in PDF font (Courier) only supports Latin-1. Other characters are transliterated or replaced with `?`. For full Unicode, point `projectExporter.pdf.fontPath` to a monospace TTF, e.g. DejaVu Sans Mono.

## Build
```bash
npm install
npm run compile
# Press F5 in VS Code to launch an Extension Development Host
npx vsce package   # creates a .vsix you can install
```

## Publishing (`publish.bat`)
Double-click `publish.bat` (or run it from a console) for an interactive menu:

- Versioning: bump patch/minor/major or set an explicit version
  (updates `package.json` + `package-lock.json`, no tag until you say so)
- Local: `npm ci`, compile, package a `.vsix` you can install directly
- GitHub: commit + push `main`, then tag `vX.Y.Z` + push the tag — this triggers
  `.github/workflows/release.yml`, which builds and publishes the GitHub Release
- `FULL publish` runs the whole chain; `W` watches the Actions run.
  Requires `node`, `git` (and `gh` for release watching) on PATH.