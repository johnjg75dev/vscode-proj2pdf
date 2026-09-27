# Project Source Exporter

Export the entire source code of your project to a **PDF** or the **clipboard**.

## Usage
- Command Palette → **Project Exporter: Export Project Source...** (`Ctrl+Alt+E` / `Cmd+Alt+E`)
- Or **Export Project Source to PDF** / **Copy Project Source to Clipboard**
- Or right-click a folder in the Explorer to export just that folder.

You'll be asked for:
1. The output (PDF or clipboard)
2. The options (last choices are remembered):
   - Include Markdown
   - Syntax highlighting (PDF only)
   - Minify
   - Table of contents
   - Folder structure
3. Where to save (PDF only)

## PDF features
- A title block with file and line counts
- A table of contents with page numbers and clickable links, plus PDF bookmarks
- A folder structure tree
- A header bar per file, optional line numbers and long lines wrapped at the page edge
- "Page X of Y" in the bottom-right corner of every page

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