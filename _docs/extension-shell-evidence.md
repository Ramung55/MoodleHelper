# #7 engineering evidence

Implementation is an inert dependency-free MV3 shell. No collection or bridge
capability is claimed. Browser acceptance remains blocked pending actual Chrome
installation and inspection; the issue stays open for independent QA.

## Browser preparation, 2026-10-26

Computer-use skill and its guidance/API/confirmations were read. `sky.list_apps`
succeeded but returned no Chrome entry/window. The installed executable was
confirmed at `C:\Program Files\Google\Chrome\Application\chrome.exe`.
Calling `sky.launch_app` for that path through node_repl returned:
`Computer Use was not approved to use Google Chrome` (`isError: true`).
No browser window was selected, no extension installed, and no login attempted.

Additionally, the computer-use confirmation policy [8.3–8.5] requires action-time
confirmation for installing browser extensions. Unpacked loading is paused at
that boundary until confirmation. This is an explicit verification blocker,
not evidence of successful loading.

Read-only revalidation on 2026-10-26 again returned no Chrome app from
`sky.list_apps`; no alternative channel was used to bypass the earlier denial.

After the human explicitly approved Chrome access and loading this exact built
extension, a supported `sky.launch_app` retry succeeded. `sky.list_apps` returned
one Chrome window (ID 67410, title `Google Chrome`). The first state capture
returned `isError: true` and stopped Computer Use for the turn because it
"could not determine the current browser URL on Windows with enough confidence
to enforce policy." No browser input or unpacked loading occurred. UI work
stopped immediately; the remaining actual-browser evidence is still blocked.

The human subsequently opened `https://example.com/` manually and left Chrome
open. On the next turn, `sky.list_apps` returned exactly one Chrome window,
ID 1443794 titled `Example Domain - Google Chrome`. Its first
`get_window_state` again returned the same URL-confidence policy stop. No input,
extension loading or alternate inspection channel was attempted. A matching
window title is not browser URL/content evidence; the blocker persists after
this manual recovery attempt.

## Automated engineering verification, 2026-10-26

Verified installed Bun 1.3.13 and Node v24.20.0. Both root build commands
(`bun run --cwd extension build`, `bun run --cwd shared build`) exited 0.
The root browser-workspace Vitest command documented in README passed all
13 tests in two files, using actual emitted assets. A stale `dist/stale.txt`
sentinel disappeared on rebuild. Temporarily moving the local popup source
made the build fail with exit 1/ENOENT and removed partial `extension/dist/`;
restoring the source and rebuilding restored all 13 passing checks.

Full regression: frontend `bun run test` passed 52 tests in five files;
`bun run build` completed client/SSR/Nitro output (existing tsconfig-paths and
inlineDynamicImports warnings). Root `uv run pytest` passed 297 tests with
the existing Starlette TestClient deprecation warning after using the documented
local `UV_CACHE_DIR` workaround. The initial default-cache interpreter query
failed with `ModuleNotFoundError: No module named 'python'`; no dependency or
lockfile change was needed. `git diff --check` passed.

Reviewable unpacked directory:
`C:\Users\hpram\Desktop\MoodleHelper\extension\dist`.
Manifest declares only MV3, name/version, module worker, local blank popup and
the exact static SDU match. No API permissions, separate host permissions,
optional permissions or external connections are declared. Build output has
exactly four files; the inert worker is legitimately zero-byte Bun output.

Missing actual evidence: Chrome version/card/ID; Load unpacked; empty popup and
worker/popup errors; SDU public login script source/context; unrelated-site
non-injection and extension site-access view; reload/reopen, Network/storage
and permission-prompt observations. Follow README's manual checklist after
computer-use access and installation confirmation are available.
