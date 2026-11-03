# Backup export format (#45)

File: `{app:"moodle-helper", version:1, exportedAt, note, datasetId?, summary?, data: Snapshot}`.

- `version` stays 1. `datasetId` (opaque UUID from `GET /api/local-context`) and `summary`
  (`counts`, `exclusions`, `redactions`) are additive optional fields. Current exports always
  include both; historical v1 files without them still parse. Whether identity-less backups are
  accepted for restore is #55's decision; this issue adds no new restore acceptance.
- `data` is a validated projection: an independent `structuredClone` parsed by the `Snapshot`
  schema (unknown keys dropped, strict models fail). Every remaining string is scanned:
  non-http(s) link schemes, userinfo, session/token/signature query keys (`token`, `sesskey`,
  `X-Amz-*`, `sig`, ...), and login/token routes fail the export; known credential markers in text
  (provider keys, Bearer, MoodleSession, private keys) fail too. Errors name field paths only,
  never values. Nothing is redacted silently (`redactions: 0`); safe query params such as `id` stay.
- Not included: original PDF/DOCX bytes, session-local extracted/OCR text, disk-downloaded
  material files, credentials/bridge tokens/namespace/Moodle user identifiers, browser IndexedDB.
- Preparation: identity read, one `adapter.load()`, identity read; mismatch or unavailability aborts.
  This is not a coordinated identity session: an unsignalled switch-and-switch-back between the
  reads cannot be detected.
- Preview counts, timestamp, version and byte size come from the same frozen object whose JSON is
  downloaded. "Prepare again" re-reads explicitly. The UI reports "Download requested; check your
  browser downloads" because anchor downloads give no disk-completion signal. Object URLs are revoked
  after 60 s, on re-download or on page teardown, or immediately if dispatch throws.
