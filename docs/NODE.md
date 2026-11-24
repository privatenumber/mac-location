# Node.js API

Get your Mac's location from Node.js. On other platforms, requests reject with `UNSUPPORTED_PLATFORM`.

## getCurrentPosition(options?)

Returns `Promise<Position>` with one location measurement. macOS identifies the helper as `mac-location`; use [`createApplication()`](#createapplicationidentity) for your own application name.

```ts
import { getCurrentPosition } from 'mac-location'

const position = await getCurrentPosition()

console.log(position)
// { latitude, longitude, accuracy, timestamp }
```

### Result

| Property | Type | Description |
| --- | --- | --- |
| `latitude` | `number` | Latitude in degrees (WGS84). |
| `longitude` | `number` | Longitude in degrees (WGS84). |
| `accuracy` | `number` | Horizontal accuracy in meters. |
| `timestamp` | `number` | When macOS measured the location, in Unix milliseconds. Cached results can predate the request. |

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maximumAge` | `number` | `0` | Accept a cached location up to this many milliseconds old. `0` requires a new measurement. |
| `timeout` | `number` | `30000` | Milliseconds to wait for a location after access is granted. Time on the permission prompt does not count. |
| `signal` | `AbortSignal` | none | Cancel the whole request, including the permission prompt. |
| `onPermissionRequest` | `() => void` | none | Called when macOS is asked to show the permission prompt. |

`maximumAge` must be finite and non-negative. `timeout` must be an integer from `1` through `2147483647`. Invalid values reject with `TypeError`.

### Cached locations

Use `maximumAge` to allow cached locations, and `timestamp` to check their age or display the measurement time:

```ts
import { getCurrentPosition } from 'mac-location'

const position = await getCurrentPosition({ maximumAge: 60_000 })
const ageMs = Date.now() - position.timestamp
const measuredAt = new Date(position.timestamp)

console.log(ageMs, measuredAt)
```

This request can return a location measured 30 seconds ago. With `maximumAge: 0`, the helper requires a measurement taken after the request started.

### Timeouts and the permission prompt

The first request for an application identity can show the macOS permission prompt. The request waits until the user answers it. The `timeout` deadline starts only after macOS grants access, so it measures how long the location takes. This matches the [`timeout` option of the W3C Geolocation API](https://www.w3.org/TR/geolocation/#timeout-attribute).

- A request rejects with `LocationError` code `TIMEOUT` only when access was granted and no location arrived in time.
- With no `signal`, a prompt that nobody answers keeps the request waiting. Pass a `signal` to set a limit on the complete request.
- Use `onPermissionRequest` to tell the user to answer the prompt:

```ts
import { getCurrentPosition } from 'mac-location'

await getCurrentPosition({
    onPermissionRequest: () => console.error('Choose Allow in the macOS location prompt.')
})
```

The library calls `onPermissionRequest` only while the permission is undecided, at most once for each request. If the callback throws, the request stops the helper and rejects with that error.

### Cancellation

Pass `signal` to cancel a request, or to limit the total time including the permission prompt:

```ts
import { getCurrentPosition } from 'mac-location'

// Stop after 60 seconds, whether the prompt is still open or no location arrived
await getCurrentPosition({ signal: AbortSignal.timeout(60_000) })

// Caller-controlled cancellation
const controller = new AbortController()
const pending = getCurrentPosition({ signal: controller.signal })
controller.abort()
await pending
```

- The signal covers preparation, lock waiting, and helper execution, including the permission prompt.
- Without a signal, preparation of a [custom application](#createapplicationidentity) still stops after 30 seconds.
- Cancellation rejects with the exact `signal.reason`, not a `LocationError`. Timeout signals supply a `DOMException` named `TimeoutError`; `controller.abort()` uses `AbortError` unless you pass a custom reason.
- To learn whether a canceled request was waiting on the prompt, record the `onPermissionRequest` call.

Cancellation stops the helper, using a force-kill if needed. Cleanup can finish after the deadline. The helper also exits when its parent dies and stdin closes.

## createApplication(identity)

Create an application object to show your name and purpose instead of `mac-location`:

```ts
import { createApplication } from 'mac-location'

const app = createApplication({
    id: 'com.example.weather-cli',
    name: 'Weather CLI',
    locationUsageDescription: 'Show the weather forecast for your current location.'
})

await app.getCurrentPosition({ signal: AbortSignal.timeout(5000) })
```

`ApplicationIdentity` describes your application:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Stable application ID, such as `com.example.weather-cli`. |
| `name` | `string` | Application name shown in the permission prompt and System Settings. |
| `locationUsageDescription` | `string` | Explanation shown in the permission prompt. |
| `icon` | `Uint8Array \| null` | Optional `.icns` bytes, including Node.js `Buffer`. `null` means no custom icon. |

The factory validates and copies the fields, including icon bytes, synchronously. It does not prepare a helper or request permission. The ID, name, and usage description must be non-empty strings; invalid fields throw `TypeError`.

### Custom icons

Supply an existing `.icns` file. mac-location does not convert images or validate the icon format.

```ts
import { readFile } from 'node:fs/promises'
import { createApplication } from 'mac-location'

const app = createApplication({
    id: 'com.example.weather',
    name: 'Weather',
    locationUsageDescription: 'Show the local forecast.',
    icon: await readFile('./weather.icns')
})

// Prepare a replacement without requesting coordinates
await app.updateMeta({ icon: await readFile('./weather-station.icns') })

// Remove the custom icon
await app.updateMeta({ icon: null })
```

In the [recorded macOS 26.5.2 experiment](https://github.com/privatenumber/mac-location/blob/develop/notes/mac-location/runtime-permission-experiment.md):

- **System Settings > Privacy & Security > Location Services** showed the custom icon.
- The permission dialog showed a system location symbol, not the custom icon.

Changing the icon changes the signed bundle and may cause another permission prompt. Preparing an icon does not guarantee an immediate Settings refresh. See [permission and Settings behavior after updates](./PERMISSIONS.md#after-changing-your-application).

### app.getCurrentPosition(options?)

Accepts the same [options](#options) and returns the same [result](#result) as the standalone function. The first request prepares and signs a helper; later requests verify and reuse it. Changed metadata or helper contents select a matching bundle automatically, including after package upgrades.

Objects with the same ID can use different metadata or helper versions without replacing each other's bundles. Separate bundles do not guarantee separate permission decisions in macOS. For denied access, follow the [permission guide](./PERMISSIONS.md#change-location-access).

### app.updateMeta(metadata, options?)

Prepare a new name, purpose, or icon without requesting coordinates:

```ts
await app.updateMeta({
    name: 'Weather Station',
    locationUsageDescription: 'Show nearby weather stations.'
}, {
    signal: AbortSignal.timeout(5000)
})
```

Returns `Promise<void>`.

- Pass `name`, `locationUsageDescription`, or `icon` in any combination. Omitted fields stay unchanged; the ID is fixed.
- Icon bytes are copied when you call the method. Use `icon: null` to remove the custom icon.
- Pass `{}` to prepare the current configuration.
- Pass `options.signal` to control [cancellation](#cancellation). Without it, the update stops after 30 seconds.

Metadata changes take effect only after preparation succeeds. Failed or canceled updates leave the object unchanged. Requests already in progress keep their original configuration. Other application objects are unaffected.

Updates on one object run in call order. Each patch uses the last successful metadata, so overlapping partial updates preserve each other's changes:

```ts
await Promise.all([
    app.updateMeta({ name: 'Weather Station' }),
    app.updateMeta({ locationUsageDescription: 'Show nearby stations.' })
])
```

The signal also covers time waiting for an earlier update. Canceling a waiting update rejects with its original reason and skips its patch.

For permission prompts and Settings refresh after updates, see the [permission guide](./PERMISSIONS.md#after-changing-your-application).

## isSupported

```ts
import { isSupported } from 'mac-location'

console.log(isSupported) // true on macOS
```

A boolean that checks the platform, not permission or helper availability.

## Errors

```ts
import { getCurrentPosition, LocationError } from 'mac-location'

try {
    await getCurrentPosition()
} catch (error) {
    if (error instanceof LocationError) {
        console.error(error.code, error.message)
    } else {
        throw error
    }
}
```

| Code | Meaning |
| --- | --- |
| `PERMISSION_DENIED` | The user denied location access for this app. |
| `PERMISSION_RESTRICTED` | Location access is restricted, for example by a management profile. |
| `LOCATION_SERVICES_DISABLED` | Location Services is off system-wide. |
| `POSITION_UNAVAILABLE` | Location Services is on, but no location measurement is available. |
| `TIMEOUT` | Access was granted, but no location arrived within `timeout`. |
| `UNSUPPORTED_PLATFORM` | Not macOS. |
| `HELPER_NOT_FOUND` | The bundled helper is missing from the installation. |
| `HELPER_FAILED` | The helper failed unexpectedly. |
| `HELPER_PREPARATION_FAILED` | Preparing the customized helper failed. |

For cancellation errors, see [Cancellation](#cancellation). Invalid options reject with `TypeError`.

The package exports the types `Position`, `GetPositionOptions`, `ApplicationIdentity`, `ApplicationMetadata`, `Application`, and `LocationErrorCode`.
