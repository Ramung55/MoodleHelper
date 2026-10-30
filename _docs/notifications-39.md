# #39 Notifications and change alerts

## Permission inventory (extension/manifest.json)

| Permission | Why | Since |
|---|---|---|
| `alarms` | queue and #38 reminder wakeups | #16/#38 |
| `notifications` | show optional OS notifications for alerts already kept in the dashboard | #39 |
| host `http://127.0.0.1:8000/*` | local backend only | #10 |

No `tabs`, `storage`, `cookies`, `webRequest`, `scripting` or broad hosts were added. A notification
click calls `chrome.tabs.create({url})` with a fixed dashboard origin (`APPROVED_ORIGINS[0]`); that does
not need the `tabs` permission and reads no tab data. The icon is the packaged `icon-128.png`. Minimum
Chrome stays 106; the notifications adapter uses the callback forms of `getPermissionLevel`/`create`/`clear`.

## Data flow

1. The dashboard Alert is persisted first, in the same Snapshot transaction as its cause:
   - #22/#29 source change: `alert_delivery.change_alert` runs where the `DeadlineChange` is appended
     (`deadline_tracking.py`, `syllabus_revision.py`). Delivery key `change:<changeId>`.
   - #38 dispatch: one Alert per on-time request, one consolidated `catch_up` Alert per missed set,
     written with the ledger rows (`ReminderService.dispatch`).
2. `Alert.context` holds the closed destination (`assessment`/`week`/`alerts`), reason, course,
   canonical assessment or week and, for changes, typed old/new `DeadlineAssertion`s plus
   `changeId`, `sourceId`, `detectedAt` and `sourceObservedAt` (kept distinct).
3. `Alert.delivery` is the OS channel state: `dashboard_only`, `pending`, `issued`, `shown`, `denied`,
   `failed`, `unknown`. Reminders off, hidden items and hidden-item source changes are `dashboard_only`.
4. `reconcile`/`dispatch`/`plan` list `pendingDeliveries` live from the Snapshot, so a lost dispatch
   response (the #38 gap) is still picked up on the next wake.
5. The worker reads `getPermissionLevel` before each delivery pass (never prompts). Denied: it reports
   `denied`. Granted: `POST /api/reminders/delivery-status state=issued` atomically reserves the one
   attempt (rechecking enabled/hidden/completed/stale and the plan generation), then calls
   `notifications.create(<stable mhn- id>, fixed options)` with backend-derived title/message, then
   reports `shown` or `failed` (`create_failed`, no Chrome message text).

## Duplicate policy (at-most-once, not exactly-once)

Only a `pending` alert can be reserved, once. A second attempt id, a repeated alarm or a worker restart
gets `reserved:false`. A crash or lost response after reservation leaves `issued` (shown as "outcome
unknown") and is never re-created, so one OS notification can be missed in that window; the dashboard
row remains. Stable notification ids are not the dedup guard. Pending rows older than one hour become
`dashboard_only` (`stale`). Restored/imported Snapshots and legacy `PUT /api/alerts` cannot create or
roll back delivery state (`neutralize_imported`, `merge_legacy_save`).

## Click handling

`POST /api/reminders/notification-target` (binding + dataset checked) maps the opaque id to the closed
destination. The worker builds only `/deadlines?id=<encoded>`, `/planner` or `/alerts` on the approved
dashboard origin; any failure or changed dataset opens `/alerts`. The dashboard Alerts page uses the same
mapping (`alertDestination`), canonicalises alias ids, and the existing AssessmentSheet shows
"Assessment not available" or the hidden item with "Restore item".

## History controls

`POST /api/alerts/update {ids, action: read|delete}` is a narrow idempotent operation; it never replaces the
array, so concurrently appended alerts and delivery state survive. In backend storage mode the dashboard no
longer generates alerts client-side (demo mode still does).

## Verification limits

Chrome APIs were exercised through mocks (`browser-workspace/notification-delivery.test.ts`). Real Chrome
OS notification display, OS-level permission changes and real click behaviour were not observed in an
installed browser in this environment.
