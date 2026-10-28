# Local PDF extraction (#25)

The Syllabus page offers **Extract text** only for an explicitly imported local
PDF. It reads the existing Blob through its dataset/course/SHA-256 association,
checking current backend context before and after that read and before publishing
the result. Missing association, missing Blob or unavailable/changed context fails
closed. The selected PDF never enters HTTP, extension messages or backend storage.
Only the existing opaque context GET is used; no remote file or font is fetched.

The installed PDF.js 6.4.299 and matching bundled worker receive fresh byte copies.
The existing structural validation runs first. Network fetching, external fonts,
WASM and eval are disabled. Extraction has limits of 20 MiB, 100 pages, 100,000 text
items and one million characters across the document. These bound accepted input
and output, not a universal hard memory/CPU guarantee for arbitrary PDF parsing.
Unsupported/corrupt/encrypted inputs fail with export/retry guidance. PDF.js is
recovery-oriented; this does not certify detection of every possible corruption.

Each one-based original page retains its dimensions and text items' transform,
width and height. Horizontal baselines within three PDF points form rows, ordered
top-to-bottom and left-to-right. Rotated items stay separate. This preserves the
two-column synthetic schedule's assessment/date rows; it is not a general table,
multicolumn-reading-order or assessment/date interpretation algorithm. No inferred
date, candidate or assessment is created. Excerpts render as inert React text.

The result identifies dataset, course, digest, original document and page. Opening
**Inspect original page** creates a PDF Blob URL with its original page fragment
in a bounded preview; closing/unmounting revokes it. The browser's PDF viewer must
support that page fragment. Evidence still lists the original page number,
excerpt and exact item geometry for inspection. A valid image-only page is labeled
OCR needed; OCR is not performed. A page with no text and only nonpainting setup
operators is blank. Other drawing-only pages fail as unsupported rather than
being mislabeled image-only. Results are session-local and disappear on row
unmount/reopen; document bytes remain in the original local import store.

Cancel destroys the loading task/worker and discards partial pages. Component
generation and abort guards prevent late publication after cancel, replacement,
unmount or detected context change. Existing #24 focus/visibility/resume checks
hide rows pending revalidation; polling is best effort and cannot promise instant
detection of an independently switched backend. This localhost context is not
authentication. These limits and #24's genuine live-session blocker are unchanged.

## Synthetic verification fixture

`frontend/src/test/fixtures/extraction-bilingual.pdf` is synthetic and contains
English (page 1), Russian (page 2), a generated image (page 3) and a blank page 4.
The two schedules have separate rows at y=290 and y=245, with text columns x=40
and x=260. `tools/create_pdf_extraction_fixture.py` recreates it using bundled
ReportLab/Pillow and a supplied Cyrillic-capable TTF; these are authoring tools,
not application dependencies. Its Russian page was rendered and visually checked.

`extract-pdf-real.test.ts` executes actual PDF.js and matching local Node worker
shim, checking bilingual row output, geometry, page classification, corruption,
encryption, cancellation and task destruction. UI tests cover explicit action,
inert evidence, original page URL/revocation, missing source, context failures and
late results. Repository tests check exact association/blob keys and fail-closed
reads. These Node/DOM tests do not claim actual Chrome browser-worker, PDF-viewer
page navigation or browser-wide network inspection; independent QA must distinguish
that evidence from unit/integration tests.
