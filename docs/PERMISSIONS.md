# Permissions

## Grant location access

Choose Allow in the macOS location prompt to get coordinates. The helper is named `mac-location` by default. In Node.js, use `createApplication()` to show your name and purpose.

## Change location access

Allow permits a location request. Deny makes the request reject with `PERMISSION_DENIED`; the CLI prints the error and exits `1`. Do not change the application ID to bypass a denial. Ask the user to review the existing entry in Settings instead. Restricted access or disabled Location Services has a separate [error code](NODE.md#errors).

With an unchanged helper, macOS reuses the recorded decision. Changes to the helper or application metadata can make macOS ask again, including after a denial.

To review or change the setting:

1. Open **System Settings**.
2. Go to **Privacy & Security > Location Services**.
3. Find **mac-location**, or your application's name, and toggle access.

If the entry does not appear, ensure Location Services itself is enabled.

## Show your application's name

Use [`createApplication()`](./NODE.md#createapplicationidentity) in Node.js to show your name and purpose. This feature is Node-only; the CLI always uses `mac-location`. macOS uses the helper bundle's identity, not the parent Node process or terminal.

## After changing your application

- Create another application object with new metadata, or call [`app.updateMeta()`](./NODE.md#appupdatemetametadata-options) to prepare the change without requesting location. Helper upgrades are handled automatically on the next request.
- Settings may not refresh immediately after preparation. Name-refresh behavior has not been tested. In the icon experiment, Settings kept the old icon until a later location approval; this does not establish how names behave.
- The next location request can prompt again, including after a denial.
- Changed purpose text can produce a new prompt with the old explanation. The prompt-text cache key and invalidation behavior are unknown.

## Stored helper apps

The library owns the prepared helper apps under `~/Library/Application Support/mac-location/`.

- Delete this directory only while no `mac-location` call is running. Deleting it during preparation can remove the lock file that coordinates concurrent calls.
- Whether deleting it resets permission or cached prompt text is unknown.
- A location request or `app.updateMeta({})` re-prepares a corrupted helper.

## Tested macOS versions

Interactive permission behavior was tested on macOS 26.5.2 (25F84), arm64. Permission dialogs on other versions remain unverified.
Automated tests also cover macOS 14, 15, and 26, but do not exercise permission dialogs. The helper targets macOS 11.0; macOS 11-13 remain unverified. Maintainer evidence is recorded in the repository's [platform note](https://github.com/privatenumber/mac-location/blob/develop/notes/macos/location-permission.md) and [release-validation matrix](https://github.com/privatenumber/mac-location/blob/develop/notes/mac-location/release-validation.md).
