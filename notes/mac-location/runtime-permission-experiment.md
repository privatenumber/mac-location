# Runtime permission-metadata experiment

Caller-supplied bundle metadata worked with the precompiled helper on macOS 26.5.2. Direct executable spawning worked, and unchanged signatures retained both approval and denial. Tested metadata and executable changes changed the cdhash and renewed consent. Changed purpose text produced new prompts with the old explanation; the cache key and invalidation behavior remain unknown. Display-name changes were not tested.

Historical experiment, recorded before the `application` option was implemented. See the [Node API](../../docs/NODE.md) and [release validation](./release-validation.md) for current behavior and coverage.

## Environment and provenance

- macOS 26.5.2 (build 25F84), arm64 (Apple M2 Max); Node 24.16.0; pnpm 10.20.0.
- Harness and Swift variants: [archived experiment software](https://github.com/privatenumber/mac-location-dev/tree/ec271b5/experiments/runtime-permission). The experiment software is no longer tracked; a local copy can remain under the gitignored `experiments/` directory.
- Original helper: ad-hoc signed, identifier `com.privatenumber.mac-location`, executable
  sha256 `728ec79e…`, designated requirement cdhash-based.
- `codesign` and `plutil` are the only tools runtime preparation uses; both ship with macOS.
  The experimental Swift variants needed `swiftc`/`strip`.

## Method

The harness copies `helper/mac-location.app`, rewrites the bundle metadata with `plutil`,
ad-hoc signs and verifies the copy, and moves it into place from a staging directory. It then
spawns the executable through the production `runHelper` path, preserving subprocess lifetime,
stdin-EOF, cancellation, timeout, and force-kill. Reuse was keyed on a manifest of the inputs.
Dialogs were answered manually.

Bundle metadata set for every identity: `CFBundleIdentifier`, `CFBundleName`,
`CFBundleDisplayName`, `CFBundleExecutable` (kept equal to the file name), and the three
`NSLocation*UsageDescription` keys. The three purpose keys were set to the same string.
`CFBundleName`, `CFBundleDisplayName`, and the `.app` file name were all set to the same value,
so which one drives the displayed name is not isolated.

## Observations

| Case | Expected | Observed | Evidence |
| --- | --- | --- | --- |
| Identity A first use, Allow | prompt with caller name and purpose; a fix | Title `"Mac Location Experiment A" would like to use your current location.`, explanation `Experiment A: show the local forecast.`; a position fix (accuracy 237 m, ~18.9 s) | `run-a-approve`, user report |
| Identity B first use, Allow | its own prompt | Its own dialog; distinct cdhash `ddd339d6…`; position accuracy 53 m | `run-b-deny`, user report |
| Concurrent preparation (identity C) | serialize, no partial bundle | One prepared, the other reused after the lock; final bundle verifies | `run/concurrent` |
| A repeat from a new Node process | approval retained, no dialog | No dialog; cached fix in 140 ms | `run-a-repeat` |
| B repeat from a new Node process | approval retained, no dialog | No dialog; cached fix in 140 ms | `run-b-repeat` |
| A re-created from identical inputs | same cdhash, no dialog | Same executable hash `6914f170…`, same cdhash `e1b48f73…`; fix in 398 ms | `run-a-reprep` |
| A purpose text changed | new cdhash, new prompt | New cdhash `c85e4439…`, new prompt, but dialog text stayed the original purpose | `run-a-purpose-change`, user report |
| A purpose changed to an unmistakable string | new prompt with new text | New cdhash `941c4437…`, new prompt, dialog text still the original purpose | `run-a-unmistakable`, user report |
| Identity D first use, Deny | its own prompt; denial | Title `"Mac Location Experiment D" …`, explanation `Experiment D: test denial retention.`; `PERMISSION_DENIED` | `run-d-deny`, user report |
| D repeat | denial retained, no dialog | No dialog; `PERMISSION_DENIED` in 17 ms | `run-d-repeat` |
| D purpose changed after denial | does a prior denial suppress the next prompt | Purpose-only change caused the previously denied identity to prompt again (cdhash `e18392a8…`); the prompt retained the original explanation; denied again; `PERMISSION_DENIED` | `run-d-revised`, user report |
| A executable replaced with a rebuilt helper | new cdhash, new prompt | Source hashes `b3bce749…` vs `728ec79e…`; new cdhash `eee1c4df…`; new prompt; fix in ~23.8 s | `run-a-exe-update`, user report |
| Deprecated `CLLocationManager.purpose` (identity E) | plist string vs runtime property | Plist string `Experiment E PLIST purpose: show the local forecast.` shown; runtime property ignored | `run-e-purpose`, user report |
| Icon identity first use, Allow | does the dialog show the app icon | Dialog showed a system location symbol, not the supplied icon; System Settings showed the supplied magenta disc; position returned | `run-icon-allow`, user report |
| Icon identity repeat | decision retained | No dialog; cached fix in 178 ms | `run-icon-reuse` |
| Icon contents changed (same filename) | new identity and prompt | Executable `2e3bfb52…` → `3ef6ce2a…`, cdhash `e67f1de3…` → `5401b95b…`; new prompt with the cached text; System Settings showed magenta before Allow and green after Allow | `run-icon-change`, user report |
| Same identity at a second path | does the bundle path affect the decision | Identical bundle (cdhash `82f3cdd2…`) at `p1` and `p2`; `p1` allowed, then `p2` returned a fix in 383 ms with no dialog | `path-p1-allow`, `path-p2`, user report |

## Permission persistence

With these ad-hoc-signed helpers on macOS 26.5.2:

- Unchanged bundle, same cdhash: approval and denial both retained across new Node processes.
- Identical re-preparation (same inputs): same cdhash; permission retained.
- Metadata change (purpose text): new cdhash; new prompt. A denied identity also prompted
  again; the prior denial did not suppress it.
- Metadata change (display name): not tested.
- Executable update: new cdhash; new prompt.
- Cached prompt text: the original explanation continued to appear after purpose-text changes
  and re-signing at the same bundle identity and path. The cache's key and invalidation
  behavior remain unknown.

The dialog attributes access to the helper bundle, not to Node or the terminal. Recorded
prompt text: A `"Mac Location Experiment A" would like to use your current location.` /
`Experiment A: show the local forecast.`; D and E were transcribed; B was approved but not
transcribed. System Settings showed `Mac Location Experiment A`; B, D, and E were not
individually confirmed. The consent dialog showed a fixed system symbol, not the bundle icon.

## Cost

Historical, from 5 samples each: copy 5 to 6 ms, plist edits 38 to 95 ms, ad-hoc sign 16 to
18 ms, verify 9 to 12 ms, rename 0 ms. Cold total 70 to 140 ms per step set; warm reuse wall
clock 0.10 to 0.11 s including Node startup. These are historical measurements only. Use the [benchmark commands](../../CONTRIBUTING.md#benchmarks) for repeatable measurements of the production implementation.

## Decision

Recorded before implementation. The shipped design follows the recommendation: prepare a
customized bundle lazily per caller configuration, key reuse on the inputs, require a stable
`CFBundleIdentifier`, write the name, display name, and purpose keys, keep the precompiled
executable, stage then move, and fail loudly rather than fall back to the generic helper. See
[helper-preparation.md](./helper-preparation.md) for the implemented architecture.

## Unknowns

- Other macOS versions (11 through 15, and other 26.x). Only 26.5.2 was tested.
- An executable update after a denial. The purpose-change result makes renewed consent
  plausible, but does not establish it.
- Which property drives the displayed name: `CFBundleName`, `CFBundleDisplayName`, or the
  `.app` file name.
- Whether removing the app from Location Services resets the cached purpose text; this needs a
  permission reset, which was not done.
- Behavior with a stable signing identity (Developer ID) instead of ad-hoc signing.
- Whether a stock macOS install without Xcode behaves the same.

The experiments created Location Services entries `Mac Location Experiment A`, `B`, `D`, and
`E`. Their removal was not performed.
