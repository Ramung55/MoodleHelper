# Backup restore (#55)

- Consumes #45 v1 only. `GET /api/backups/restore-context` gives `{datasetId, epoch, revision}`;
  `POST /api/backups/restore` (binding required, 20 MiB bound before parse) takes
  `{idempotencyKey, expectedDatasetId, expectedEpoch, expectedRevision, backup}`. HTTP-only, not bridged.
- Rejected with specific 422 and zero writes: malformed UTF-8/JSON, oversize (413), nesting > 64,
  wrong app, future/unsupported version, invalid timestamp/summary, missing identity
  ("Identity unavailable"; historical v1 previews counts but cannot be restored), wrong identity,
  invalid Snapshot shape, credential-bearing/expiring/unsafe links (`token`, `X-Amz-*`, `Expires`, ...).
  Stale epoch/revision/dataset is 409 and requires a fresh preview.
- One SQLite `BEGIN IMMEDIATE`: Snapshot replace (revision+1), restored pending/issued notifications
  converted to dashboard-only (#39), pending/running queue jobs cancelled with generation bump (old
  claims fenced), `data_lifecycle.epoch`+1, #38 reminder plan rebuilt once (generation returned),
  receipt saved. Any failure rolls back everything. The reminder delivery ledger is preserved so
  already-requested reminders are not replayed. Memory store mirrors this under its lock.
- Same key + same payload returns the receipt (`replayed: true`); a different payload under the key is 409.
  The UI retries after response loss ("Restore outcome unknown; checking receipt").
- Active material transfers are fenced in the same transaction (queued -> cancelled; in-flight -> cancelRequested + generation bump, no new descriptor). The extension reminder worker reads the epoch each wake; a change clears the old due alarm before reconciling the rebuilt plan.
- Not restored: document bytes, local extraction/OCR evidence, downloaded files. Links are metadata;
  access is unverified.
