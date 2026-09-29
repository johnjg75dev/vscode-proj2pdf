# TODO — Analysis Sections + Fonts + Header/Footer

## Analysis engine (`src/analysis/`)
- [x] `types.ts` — ClassInfo, MethodInfo, FieldInfo, FunctionInfo, StringRef, DepEdge, AnalysisResult, SectionOptions
- [x] `registry.ts` — ext → extractor dispatch (top-6 + generic fallback)
- [x] `tsjs.ts` — TS/JS/TSX/JSX/MTS/CTS/MJS/CJS extractor
- [x] `python.ts` — Python extractor (indent tracking, __init__ ctor, _private)
- [x] `java.ts` — Java extractor (modifiers, ctor = ClassName())
- [x] `csharp.ts` — C# extractor (record/struct/partial, properties)
- [x] `cpp.ts` — C/C++ extractor (public:/private: sections, X::X ctor, header/impl merge)
- [x] `go.ts` — Go extractor (type struct, NewX ctors, receivers, exported=Upper)
- [x] `generic.ts` — fallback heuristic for remaining ~64 extensions
- [x] `strings.ts` — quote-aware string literal scanner (all langs)
- [x] `dependencies.ts` — import/require/include/using → file resolution + reverse index
- [x] `usages.ts` — instantiation + call-site finder (2nd pass, strips defs/comments/strings)
- [x] `index.ts` — analyzeFiles(files, opts, token/report) orchestrator with caps + truncation flags

## Settings & config
- [x] `config.ts` — SectionOptions, FontRole, FontsSettings, header/footer getters + deprecated fontSize/fontPath aliases
- [x] `package.json` — sections.*, pdf.fonts.*, pdf.headerTemplate/footerTemplate, clipboard.header/footerTemplate, sectionsPlacement, sectionsOrder

## Header/Footer + fonts
- [x] `src/headerFooter.ts` — %%PAGE%% %%PAGES%% %%PROJECT%% %%DATE%% %%TIME%% %%FILE%% %%FILECOUNT%% %%SECTION%% engine
- [x] `pdfExporter.ts` — multi-font registration (built-in + custom TTF/OTF per role), per-section font/size, section rendering, TOC/outline/named-dest for sections, per-page header/footer with %%FILE%%/%%SECTION%% tracking
- [x] `textExporter.ts` — Markdown mirrors of all sections + header/footer templates

## Webview config panel
- [x] `src/webview/panel.ts` — openExportPanel() with getState/setState/export/cancel, validation, globalState persistence
- [x] Panel HTML/JS inline — Output | Sections | Fonts | Header/Footer tabs, nested sub-options
- [x] `extension.ts` — runExport wiring: webview → analyzeFiles → renderPdf/buildClipboardText (+QuickPick fallback)

## Verification
- [x] `npm run compile` clean
- [x] Extractor checks (TS/Python/Java/C#/C++/Go), strings comment-exclusion, dep resolution, usage def-exclusion, template vars
- [x] End-to-end PDF (9 pages, sections + header/footer) + clipboard markdown
- [x] README update (sections, fonts, header/footer vars, webview)

## File filter + publish script (v1.2.0 candidate)
- [x] `src/projectDetect.ts` — marker files → kinds, ext tally (top 30, ≤5000 files), suggestExtensions + parseExtList
- [x] `config.ts` — FileFilterOptions + resolveCollectorSettings (defaultAll merge, ignore-wins, ignore globs)
- [x] `panel.ts` — Files section: detected checkboxes w/ counts, extra include, ignore, all/listed policy, reset-to-detected
- [x] `extension.ts` — detect before panel, filter into collectFiles, log effective set, QuickPick fallback
- [x] `publish.bat` — menu: status, bump patch/minor/major/explicit, ci, compile, local vsix, commit+push, tag+push (Release), full flow, watch
- [x] `npm run compile` clean; filter logic verified (parse/suggest/all/listed/empty)
- [x] README (File Filter + publish.bat), .vscodeignore (publish.bat, TODO.md)
