# Location permission on macOS

On macOS 26.5.2, unchanged ad-hoc-signed helpers retained approval and denial. Tested changes to signed contents renewed consent, but changed purpose text could remain stale. These observations do not establish macOS's complete authorization or prompt-cache keys.

Unless stated otherwise, observations below were made on **macOS 26.5.2 (build 25F84),
arm64 (Apple M2 Max)**. They were produced by spawning ad-hoc-signed copies of an app
bundle and reading the native dialog. They are not verified on other macOS versions and
must not be generalized to them.

## What the prompt shows

macOS shows the app's display name and the value of `NSLocationUsageDescription` from
the app bundle's `Info.plist`.

- **Documented:** an app that reads location must provide `NSLocationUsageDescription`
  in its `Info.plist` (Apple, [NSLocationUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationusagedescription),
  accessed 2026-10-04).
- **Observed:** the prompt title is `"<name>" would like to use your current location.`
  and the explanation is the `NSLocationUsageDescription` string, for example
  `"Mac Location Experiment A" would like to use your current location.` /
  `Experiment A: show the local forecast.`
- **Not isolated:** the app set `CFBundleName`, `CFBundleDisplayName`, and the `.app`
  file name to the same string. Which of those supplies `<name>` was not tested.

The app bundle also carried `NSLocationWhenInUseUsageDescription` and
`NSLocationAlwaysAndWhenInUseUsageDescription` with the same value as
`NSLocationUsageDescription`. The observed prompt used the value, but the experiment
did not vary the three keys independently, so which key macOS reads for the prompt is
not isolated.

## The prompt is attributed to the app bundle

- **Observed:** the dialog attributes access to the spawned bundle. It did not
  attribute access to the parent Node.js process or the terminal.

## The prompt text can go stale

- **Observed:** after the first prompt for a bundle identifier and path, changing
  `NSLocationUsageDescription` and re-signing the bundle produced a new prompt (the
  signature changed, see [code-signing.md](./code-signing.md)) but the explanation was
  the original string, not the updated one. Reproduced twice at the same identity and
  path, once with an unmistakable replacement string.

The cache key and invalidation behavior are unknown. The stale text is consistent with the
location subsystem storing the app's name and purpose when it first registers the app, but
whether the key is the bundle identifier, the path, registration state, or a combination
was not isolated. Whether removing the app from Location Services resets the text was not
tested, because that requires resetting permission.

## The runtime purpose property is deprecated

- **Documented:** `CLLocationManager.purpose` exists but is deprecated on macOS 11; Apple
  directs developers to `NSLocationUsageDescription` (Apple,
  [CLLocationManager/purpose](https://developer.apple.com/documentation/corelocation/cllocationmanager/purpose),
  accessed 2026-10-04).
- **Observed:** compiling an app that sets `CLLocationManager.purpose` with the macOS 26
  SDK emits
  `'purpose' was deprecated in macOS 11.0: Set the purpose string in Info.plist using key NSLocationUsageDescription [#DeprecatedDeclaration]`.
- **Observed:** on a fresh identity, setting `purpose` to a string different from
  `NSLocationUsageDescription` did not change the prompt. The `NSLocationUsageDescription`
  string appeared.

The deprecated property cannot set the application name and is not a substitute for
`NSLocationUsageDescription`.

## The prompt does not show the app icon

- **Observed (macOS 26.5.2):** with `CFBundleIconFile` set to a custom `.icns` (a distinctive
  colored disc), the location consent dialog showed a fixed system location symbol, not the
  bundle icon. System Settings > Privacy & Security > Location Services showed the supplied
  icon.
- **Observed (macOS 26.5.2):** changing only the icon contents at the same
  `ApplicationIcon.icns` filename and re-signing changed the executable hash and the
  cdhash and produced a new prompt. System Settings showed the old icon before Allow and
  the new icon after Allow. This sequence does not establish that approval is the only
  refresh trigger.

A custom icon changes the app's appearance in System Settings, but not the consent dialog.
The icon is sealed by the bundle signature, so changing it changed the executable hash and
the cdhash in this experiment (see [code-signing.md](./code-signing.md)).

## Authorization retention

The signing mechanism is described in [code-signing.md](./code-signing.md). The [historical experiment](../mac-location/runtime-permission-experiment.md#observations) records the cases and provenance.

- **Observed (macOS 26.5.2):** unchanged signed bundles retained both approval and denial across new Node processes. Purpose-text and executable changes followed by re-signing produced new prompts; a purpose change also renewed the prompt after a denial.

- **Observed (macOS 26.5.2):** an identical signed bundle (same cdhash) copied to a second
  path retained the permission decision with no prompt. This supports relocating or
  versioning a bundle at a new path. It does not establish that permission depends solely on
  the code identity; identity, path, and other state are not isolated.
