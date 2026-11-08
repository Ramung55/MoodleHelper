# Local data erasure (#56)

`POST /api/local-data/erase` (process binding, 1 MiB bound, `{idempotencyKey, expectedDatasetId, expectedEpoch, expectedRevision}`)
commits ONE SQLite transaction (`backend/local_erase.py`):

- Snapshot replaced by empty arrays, optional feature states removed, first-run default settings
  (no tracked courses/calendar, reminders and AI/consent off). Opaque `datasetId` unchanged; nothing reseeded.
- Deleted for the namespace: `queue_*`, `scan_pages`, `scan_coverage` (#19/#20 jobs, claims, tokens, results),
  `reminder_requests`, `reminder_receipts` (#38), `material_transfers` (#41). Alerts/delivery history (#39) live in the Snapshot.
  In-process collection tokens are invalidated after commit.
- `data_lifecycle.epoch` (#55) incremented; `erase_receipts` row stores only ids, epoch, revision, fingerprint and
  per-component markers (`dashboard`, `extension`). No titles, dates or record ids.

Retained nonstudent records: schema/lifecycle tables, `local_datasets`, `restore_receipts` (ids/generation only),
the #43 AI admission ledger (ids, digests, cost; kept so erasing cannot reset the spend cap) and the global scan rate gate.

## No-resurrection fencing

First-party writers send `X-Moodle-Helper-Data-Epoch` (HttpAdapter reads `/api/data-context` before the Snapshot).
The epoch is checked inside every `SQLiteStore._transaction` / `InMemoryStore` write, so work accepted before the erase
cannot commit after it (409). Writes without the header stay accepted for legacy callers and are NOT fenced.
Legacy `DELETE /api/local-data` keeps its partial semantics and is not erasure.

## Browser and extension

After the backend commit, `frontend/src/services/local-erase.ts` deletes only this dataset's key ranges from
`blobs`, `associations`, `jobs`, `evidence` in one IndexedDB transaction and writes a `lifecycle` tombstone; every content
commit re-checks that tombstone in its own transaction. Other datasets, origins and profiles are untouched; no
`deleteDatabase`. A BroadcastChannel aborts work and reloads cooperative tabs. Interrupted cleanup resumes on reopen.

The extension reminder worker, on reconcile, sees the current-epoch erasure, clears only its own reminder wakeup alarm
and delivery metadata and acknowledges `extension`. Until then the UI reports the extension as pending (partial).
Moodle, downloaded files and exported backups are never touched.
