# Local DOCX body extraction (#26)

The existing explicit **Extract text** action now supports imported DOCX files.
It uses the same dataset/course/digest association-checked Blob read, context and
generation fences, abort controls, and session-local results as PDF extraction.
No bytes or excerpts enter backend/SQLite, extension messages, logs or external
services. There is no Mammoth or other added dependency.

`validateDocx(): Promise<void>` retains its import API. Its shared checked reader
returns only the validated `word/document.xml` DOM, not arbitrary archive parts.
It retains central/local bounds, overlaps, CRC, descriptors, namespace validation,
4096 entries and 40 MiB aggregate decoded limits, and enforces 20 MiB input size.
Raw-DEFLATE streams receive the AbortSignal; abort cancels their reader and checks
again after the read. CRC checks yield/check every 64 KiB. Native DOMParser is a
bounded synchronous phase; cancellation is observed immediately before/after it,
not midway through native parsing. XML DTD/entity declarations and parser errors
are rejected. Error messages distinguish corrupt ZIP/XML, known encrypted ZIP
flags or compound Office encryption markers, and unsupported container/features.
Malformed unrelated bytes are not assumed to be password-protected.

The shared `LocalExtraction` union preserves PDF `pages` and adds DOCX `blocks`.
DOCX output follows direct body-child order: paragraph or table, rows in XML order,
cells in XML order, then each cell's paragraphs in XML order. Every location uses
`word/document.xml`, one-based body-block index (paragraphs/tables only), direct
body-paragraph index or table/row/cell/paragraph indices. A table-cell paragraph's
stable location ID is, for example,
`word/document.xml/body4/table2/row1/cell2/p1`. No PDF pages or exact Word layout
are invented. Tabs and explicit line breaks are preserved; run text is joined in
document order, and hyperlink visible text is retained without resolving any
relationship or URL. Evidence expands in the UI to show the original body text,
filename, digest and exact paragraph or cell reference.

Only ordinary body paragraphs and non-nested tables are supported. Formatting
properties, bookmarks and proofing metadata do not become text. Headers/footers
and page layout are explicitly excluded in the UI. Nested tables, textboxes,
drawings/objects, tracked changes, fields, content controls, referenced footnotes
and other unknown body structures fail as unsupported rather than silently
flattening unrelated content. Empty supported body text fails explicitly.
No macros, embedded objects, relationships or linked resources are executed or
opened. Markup-looking excerpts render through React text, never HTML or anchors.

Extraction progress counts direct XML body children, including final section
properties, while evidence body-block indices exclude section properties. Limits
are 100,000 processed structural/text items and one million extracted characters;
work yields at body blocks and every 128 processing items. These are acceptance
budgets, not hard guarantees about native XML-parser memory. Cancellation discards
all partial output and cannot publish complete evidence after a late response.

`tools/create_docx_extraction_fixtures.py` uses only Python stdlib to reproduce
synthetic stored/deflated bilingual paragraph/table and inert-link examples plus
unsupported/empty/entity fixtures. These are ZIP/XML parser test containers, not
student documents or claims about Word pagination. Existing ZIP descriptor
fixtures retain validation coverage. Tests exercise actual native XML parsing,
real raw-DEFLATE, reference order, hostile markup/links, known encryption markers,
unsupported/corrupt containers, body cancellation and active-reader cancellation.
The rendered integration invokes the actual extractor and confirms no executable
HTML/anchors or network calls. Browser-wide network capture and actual Chrome
visual interaction remain separate independent QA evidence.
