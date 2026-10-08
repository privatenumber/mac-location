# Release validation

Validate the packaged helper on supported macOS versions before release. See [helper preparation](./helper-preparation.md) for the architecture.

## Versions

| macOS | How exercised | Status |
| --- | --- | --- |
| 26.5.2 (25F84), arm64 | Automated suite and interactive checks, Node 24.16.0 | Validated |
| 26 | Automated suite, `macos-26` CI runner | Validated (automated) |
| 15 | Automated suite, `macos-15` CI runner | Validated (automated) |
| 14 | Automated suite, `macos-14` CI runner | Validated (automated) |
| 11-13 | Not covered | Runner images retired |
| 11.0 | Not covered | Advertised floor; unverified |

Record the exact version, build, artifact, and commit for each run.

## Cross-version procedure

Three validation boundaries are distinct:

- **Source, build, and fixture compatibility.** The [Test workflow](../../.github/workflows/test.yml) runs `pnpm build` and ordinary `pnpm test` on `macos-14`, `macos-15`, and `macos-26`. It builds the real helper and checks its executable bit, universal architectures, signature, and usage-description metadata. Preparation and subprocess behavior use fixtures; kernel-lock tests cover exclusive acquisition and killed-holder recovery. CI does not enable native location or lifetime execution. macOS 11-13 runner images are retired, so the advertised floor (11.0) is not covered.
- **Native-runtime validation.** The [lifetime tests](../../tests/specs/native.ts) require `MAC_LOCATION_NATIVE=1`, and the [live-location test](../../tests/specs/index.ts) requires `MAC_LOCATION_LIVE=1`. These opt-in tests are not enabled in the CI matrix. Record their exact environment and outcomes separately; artifact verification and fixture tests do not establish native-runtime behavior.
- **Release-candidate compatibility.** Install the packaged helper exactly as a consumer would
  on a supported macOS and run the interactive checks against it. This needs a signed-in GUI
  session and a human to answer the prompt, so an operator must run it and bring back the
  results. Do not rebuild, because a locally built helper is not the artifact that ships.

Collect from the operator for the release-candidate check:

- `sw_vers` and `uname -m`.
- The tested revision (`git rev-parse HEAD`).
- The artifact identity: package name and version or tarball hash, and the helper's executable
  hash (`shasum -a 256` on the bundle executable).
- The interactive results below.

Release-candidate check, using the same packaged helper without rebuilding it:

1. Install the release-candidate tarball without rebuilding and record its identity and environment as listed above.
2. Run `getCurrentPosition` with a fresh, stable identity. Record the dialog's name and purpose, choose Allow, and record the result.
3. Repeat with the same identity from a new Node process. Record whether approval is retained without a dialog.
4. Use a separate fresh identity for denial. Choose Deny, record `PERMISSION_DENIED`, and repeat to check denial retention.
5. Call `app.updateMeta()` for a controlled metadata change without requesting location. Inspect Settings before the next request, then request location and record renewed consent and the exact purpose text, including stale text. Repeat with a changed helper version, which the next request prepares automatically.

## Integrated request

Historical validation used a local branch build on the version in the table above, before the application factory and signal-only API. The equivalent request with the current API is:

```ts
import { createApplication } from 'mac-location'

const app = createApplication({
    id: 'com.privatenumber.mac-location.e2e',
    name: 'Mac Location E2E',
    locationUsageDescription: 'Verify the macOS permission dialog shows the calling application name and purpose.'
})

await app.getCurrentPosition({
    signal: AbortSignal.timeout(120_000)
})
```

The request returned a position with about 52 m horizontal accuracy. The artifacts under
`~/Library/Application Support/mac-location/` matched the caller-supplied identity:

- One identity directory (`shortHash(id)`) with a historical `config.json` recording the application, helper `executableSha256`, and `inputHash`. The current factory does not use this record.
- One published bundle at `apps/<inputHash>/mac-location.app`, with no staging directory and
  no second bundle.
- `Info.plist`: `CFBundleIdentifier` = the id, `CFBundleName` and `CFBundleDisplayName` =
  the name, and `NSLocationUsageDescription` = the purpose.
- The bundle and its executable are ad-hoc signed with identifier = the id.

A second request with the same identity reused the prepared bundle and returned a position
without another dialog.

## Dialog appearance

Confirmed through the public API with a fresh identity
(`com.privatenumber.mac-location.visual-check`, name `Mac Location Visual Check`) on the
version in the table above. The dialog read:

> "Mac Location Visual Check" would like to use your current location.
>
> Visual validation: this exact purpose text should appear in the dialog.

The displayed name matches the supplied name, and the body matches the supplied purpose. Because the bundle's name fields and purpose keys share values, this does not isolate which field macOS reads. The earlier experiment confirmed its own prompts; this
confirms the production path.

The dialog was denied to exercise the denial path. `getCurrentPosition` then rejected with
`PERMISSION_DENIED` and the message "Location permission was denied. Enable it in System
Settings > Privacy & Security > Location Services." This confirms the production denial
path; the approval path was already shown by the integrated request above.

## Remaining evidence gaps

- The local interactive run did not identify a packaged tarball by hash. It proves the production API path on that environment, not compatibility of a shipped artifact.
- Interactive checks below macOS 26 and all checks on macOS 11-13 remain absent.
- Display-name source, prompt-text invalidation, stable certificate signing, and a stock installation without Xcode remain [platform unknowns](./runtime-permission-experiment.md#unknowns).
- Updating only the name without requesting location has not been tested against System Settings. Fixture tests establish helper metadata preparation, not a Settings rename.
