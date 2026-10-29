# Selected-page local OCR (#27)

On an imported PDF row, expand **OCR selected scanned PDF pages**, explicitly
enter original page numbers (comma-separated), choose English/Russian/both, review
the limits and start. Nothing is selected or processed automatically. The existing
dataset/course/digest association-checked Blob read is required. Selected pages
are validated as nonempty, unique positive integers within the PDF and configured
page limit, then processed in ascending original-page order. Original imports are
never changed or deleted by OCR cancellation/failure.

## Limits and completion

Defaults are 20 selected pages/job, 120 DPI, 60 seconds per page, 8 million canvas
pixels/page, at most 8192 pixels per side, a 32 MiB rendered PNG and 100,000 output
characters/page. The UI exposes page/DPI/time/pixel controls; validation permits
1–50 pages, 72–180 DPI, 1–120 seconds and at most 8 million pixels. No huge canvas
is allocated before checking dimensions/pixels. These bound accepted input/output
and canvas allocation, not a universal hard cap on PDF.js/Tesseract WASM memory.

A sequential worker is reused while healthy; no parallel page OCR is launched.
The page timeout includes rendering, first-page engine/language initialization,
and recognition. PDF opening has the same bounded timeout. Timeout cancels the
native render, destroys/reopens the PDF task if needed, and terminates the OCR
worker; a later page can use a fresh worker. Native Worker ownership exists from
creation, so initialization can also be terminated immediately. Abort races ensure
late/unresponsive promises cannot publish a page. Resources, worker, PDF task and
canvas are released on terminal paths.

Progress reports selected total, successful processed pages, failures, remaining,
current original page and current operation progress. `complete` means all selected
pages were processed successfully, not that all PDF pages were covered. Any failed
page makes the job incomplete; cancellation retains only earlier finished pages
under an explicit cancelled/incomplete marker. Per-page failures are sanitized
fixed messages, never engine exception text, document bytes or OCR excerpts in logs.
Context/unmount/replacement generations and final context verification prevent
late publication after detected changes. The inherited #24 best-effort context
polling is not instantaneous authentication or privacy against other local clients.

## Evidence and quality

Results retain document/course/dataset/digest association, original PDF page,
render DPI, Tesseract.js 7.0.0 provenance, raw recognized text/confidence and line
pixel bounds where available (otherwise an explicit whole-page region). Inspect
original page reuses the bounded local Blob preview. Text renders inertly.

Empty output, fewer than four letters/digits or confidence below 70 is marked
low-quality/review-needed. This is a conservative heuristic, not proof of accuracy:
high-confidence gibberish and missed/incorrect dates are still possible. All OCR
text remains unconfirmed, and OCR confidence is never date confidence. The local
extraction union's OCR adapter supplies original-page regions to #28 with real
`synthetic:false` provenance and a mandatory OCR-review reason; it does not
automatically interpret, accept, persist or create assessments.

## Approved assets and setup

Human-approved pins in existing `frontend/package.json`/`bun.lock`:
`tesseract.js` 7.0.0, matching `tesseract.js-core` 7.0.0, and English/Russian
`@tesseract.js-data/*` 1.0.0. No backend dependency was added. The data packages are
build assets; only `4.0.0_best_int/{eng,rus}.traineddata.gz` is copied.

`scripts/prepare-ocr-assets.mjs` runs before dev, tests and production build,
checks exact installed versions and copies local versioned assets under
`frontend/public/ocr/7.0.0/`. It includes the LSTM-only fallback, SIMD and
relaxed-SIMD `.wasm.js` plus matching `.wasm` variants required by the pinned
worker's LSTM mode. Legacy/other languages/models are not bundled. Generated
assets are ignored in Git and reproducible from the frozen approved lock.

The checked [asset inventory](ocr-asset-inventory.json) pins each emitted source,
version, byte size and SHA-256. Current total is **26,046,697 bytes** across listed
runtime/data/bootstrap/notices; `inventory.json` adds 5,139 bytes, for
**26,051,836 bytes in 18 files** before any hosting transport compression. A test
compares generated inventory against this committed baseline and each file hash.
Production build must preserve these bytes at the same-origin `/ocr/7.0.0/` path.

Engine/core supplied Apache-2.0 license texts are retained. Language package
metadata declares MIT and is copied with its README; the
[upstream traineddata license](https://raw.githubusercontent.com/naptha/tessdata/gh-pages/LICENSE)
declares Apache-2.0. The emitted data notice retains this distinction and upstream
attribution, referencing the included Apache license text rather than pretending
the metadata gives a single uniform license.

## Local network boundary and verification

The pinned v7 adapter uses its worker protocol directly so the native worker is
terminable during initialization; package version upgrades must explicitly review
that protocol. Every load command supplies an explicit same-origin core/lang path,
LSTM-only initialization and disabled persistent engine cache. A same-origin
bootstrap allows only GET asset fetches/importScripts inside `/ocr/7.0.0/`, omits
credentials, blocks network writes/external URLs/XHR and suppresses worker console
output. Recognition receives rendered PNG bytes through Worker messages, never an
arbitrary image URL. Missing local assets fail with setup/retry guidance; there is
no runtime CDN or paid OCR/AI fallback.

A loaded or locally running app can process pages with external internet disabled
while the local server/assets remain available. This is not a cold-start offline
service-worker installation claim. Local context GETs contain no file content;
same-origin static worker/WASM/traineddata requests contain no document bytes.

`tools/create_ocr_fixtures.py` creates synthetic readable English/Russian scanned
images/PDF and deterministic unreadable noise with bundled authoring tools. The
Russian scanned PDF page was rendered and visually inspected. Actual Tesseract
recognition tests use both language models with all worker HTTP/HTTPS/fetch
transports denied, recovering bilingual text and marking unreadable output for
review. They also exercise actual OCR → original-page detector provenance, never
auto-confirmation. These use the installed Node engine and local traineddata, not
the browser worker; Node core selection uses installed matching core modules.

Additional tests verify selection-only sequencing, invalid/over-limit/out-of-range
pages, low-quality/output limits, per-page timeout/partial results, mid-render and
mid-recognition cancellation, native worker termination during initialization,
canvas refusal before allocation, explicit local paths, sanitized worker failures,
asset hashes, UI defaults/cancellation/provenance and dataset-change fencing.
Actual Chrome PDF-render → browser-WASM OCR with external network disabled and a
browser-wide origins/payload capture remain separate independent QA evidence;
source/Node/mock tests are not mislabeled as those browser observations.
