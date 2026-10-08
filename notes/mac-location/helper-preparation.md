# Helper preparation

Application identities can include copied `.icns` bytes. Preparation includes their SHA-256 digest in the bundle hash, writes them to `Contents/Resources/application.icns`, and sets `CFBundleIconFile` before signing. Omitted icons on updates preserve the current bytes; `null` selects a bundle without a custom icon. Updates adopt the copied bytes only after successful preparation, so requests already in progress retain their captured icon.

The library prepares and reuses an ad-hoc-signed helper for each stable application identity.

This note describes the implemented architecture in [application.ts](../../src/application.ts). See [release validation](./release-validation.md) for tested versions and the [Node guide](../../docs/NODE.md) for the public API.

## Inputs and reuse

The caller supplies a stable `application.id`, `application.name`, and `application.locationUsageDescription`. Empty fields are rejected before filesystem work; identifier syntax is not checked. The fields describe the application, not an individual request.

The reuse key hashes the metadata and the installed helper executable's contents, not the package version. An upgrade with identical inputs reuses the bundle. Changed metadata or helper contents resolve a different content-addressed bundle. Requests do not replace valid signed bundles or fall back to the generic helper.

`createApplication()` copies the identity without preparing it. Requests capture the object's current identity before asynchronous work. `app.updateMeta()` prepares the new metadata and adopts it only on success; requests already in progress keep their captured identity. Updates on one object run in call order, applying each patch to the last successful identity. Canceled waiters reject promptly and skip their patch without letting later updates bypass an earlier active update. The ID cannot change.

There is no shared active configuration. Two objects or installed helper versions sharing one ID resolve their own bundles. Their macOS authorization interaction remains unverified; different paths do not establish independent permission decisions.

## Storage

Prepared bundles live under `~/Library/Application Support/mac-location/`. Superseded bundles remain available for existing requests and other application objects.

Each application ID is hashed to a filesystem-safe directory containing:

- `apps/<inputHash>/mac-location.app`: the prepared bundle.
- `prepare.lock`: the persistent file used for the kernel lock.

Deleting storage removes prepared artifacts; its effect on macOS authorization and prompt-text caches is unknown. See [user recovery](../../docs/PERMISSIONS.md#stored-helper-apps).

## Integrity scope

Every reuse derives the bundle path from the identity and installed helper, confirms the executable exists, and verifies the bundle signature. These checks detect incomplete preparation and accidental modification.

They do not authenticate the helper against another process running as the same user. That process can replace the user-writable bundle and ad-hoc sign a replacement. Verification followed by launching a mutable path also leaves a race. Same-user tamper resistance would require a separate OS-backed boundary; it is not a property of this design.

## Publication and repair

New bundles are prepared at `apps/<inputHash>.staging-<pid>/`, signed and verified, then renamed to `apps/<inputHash>/`. A fresh target does not exist, so publication is atomic without a partial-bundle or empty-path window.

When an existing bundle fails verification, repair removes the invalid directory and publishes the staged replacement. That repair briefly removes the path. Verification establishes that the bundle is invalid, not that no process is using it. A crash before bundle publication can leave a staging directory.

Project decision: content-addressed directories avoid replacing a nonempty `.app` in place or introducing a symlink that changes the executable's real path. Changed inputs select a new directory and leave the prior bundle available.

On macOS 26.5.2, an identical signed bundle copied to a second path retained approval. This supports relocation, but does not isolate all authorization keys or validate the complete publication design. See the [experiment record](./runtime-permission-experiment.md#observations).

## Lock ownership

A per-ID advisory lock is acquired at open time with macOS `O_EXLOCK`. Node does not expose that constant, so the macOS BSD value `0x20` is used. The lock spans verification, preparation, and bundle publication. Requests with identical inputs cannot publish competing staging bundles.

The kernel releases ownership when the file description closes or the process dies. The file persists; its existence does not mean it is locked. A waiter polls until the lock is available or its signal aborts. Cancellation stops only that waiter and never authorizes takeover. There is no independent lock-wait deadline or stale-lock takeover.

Historical rationale: reclaiming lock files by renaming them can move a live successor's lock. Kernel ownership removes that reclamation race. A non-macOS port would need an equivalent locking facility.

## Cancellation and lifetime

The standalone request and both application methods use the caller's signal directly, or create a default 30-second timeout signal if it is omitted. Requests pass that same signal through lock waiting, preparation, and helper execution. Cancellation rejects with its original reason, including a timeout signal's `TimeoutError`.

Node owns helper cancellation and retains SIGTERM-to-SIGKILL escalation. It omits the native helper's `--timeout`, which remains available for direct invocation and native lifetime tests. The native stdin-EOF watcher handles parent-process death.

Preparation checks cancellation before bundle publication. A publication already in progress may finish, and a published bundle may remain reusable, but a canceled request does not launch the helper or adopt changed metadata. Cleanup removes staging state and releases the lock.

Preparation preserves cancellation reasons and existing `LocationError`s, reports a missing source helper as `HELPER_NOT_FOUND`, and wraps other preparation failures as `HELPER_PREPARATION_FAILED`.

Preparation resolves the executable before the [subprocess owner](../../src/helper.ts) launches it.

## Verification

The [application tests](../../tests/specs/application.ts) cover independent configurations, reuse, concurrent preparation, killed-lock-holder recovery, retained bundles, damaged state, and cancellation. The [public API tests](../../tests/specs/index.ts) cover lazy identity capture, metadata updates without location, request snapshots, and canceled updates. Signature verification does not establish correct dialog attribution; interactive evidence is tracked separately in [release validation](./release-validation.md).

## Measured preparation cost

Historical production-preparation measurements, recorded before removal of the active-configuration record, on macOS 26.5.2 (25F84), arm64, Node v24.16.0, source helper executable SHA-256 prefix `728ec79e`:

| Operation | Median | p95 |
| --- | --- | --- |
| First-use preparation | 61.3 ms | 63.5 ms |
| Warm application resolution | 8.9 ms | 10.7 ms |

With eight processes sharing one identity, warm resolution had a median near 10 ms and a p95 near 390 ms due to lock waiting. These measurements exclude location acquisition. Generic and application cached-location requests have no recorded live benchmark here. Use the [benchmark commands](../../CONTRIBUTING.md#benchmarks) to reproduce; reports include the full executable hash and revision.

## Deferred

- Icon support is not part of the API. [Platform observations](../macos/location-permission.md#the-prompt-does-not-show-the-app-icon) show that icons affect Settings, not the consent dialog, and signed icon changes can renew consent.
- The reuse key does not include a separate preparation-recipe version. It uses metadata and source executable contents.
- There is no background cleanup or reconciliation of superseded bundles.
- The source of the displayed name is not isolated, so a separate caller-facing name field is not justified by current evidence.
