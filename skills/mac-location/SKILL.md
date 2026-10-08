---
name: mac-location
description: Getting the Mac's coordinates from a terminal, integrating mac-location in Node.js, or resolving its permission, cancellation, and application-update errors.
---

# mac-location

## Get coordinates

```ts
import { getCurrentPosition } from 'mac-location'

const { latitude, longitude, accuracy } = await getCurrentPosition()
```

```sh
mac-location            # 35.6586,139.7454
mac-location --json     # { latitude, longitude, accuracy, timestamp }
mac-location --timeout 10000 --maximumAge 60000 --json
```

## Control the wait

```ts
await getCurrentPosition({
	signal: AbortSignal.timeout(10_000), // includes preparation and the permission prompt
	maximumAge: 60_000 // accept a cached location up to 60 seconds old; default 0 requires a new measurement
})
```

## Cancel

```ts
const controller = new AbortController()
const pending = getCurrentPosition({ signal: controller.signal })
controller.abort() // rejects with the signal's reason (AbortError by default)
await pending
```

- Without a signal, requests and metadata updates use a 30-second timeout signal.
- Pass a signal to replace the default deadline.
- Cancellation rejects with `signal.reason`; timeout signals use `TimeoutError`.
- Use `signal` in Node.js and `--timeout` in the CLI. Press Ctrl-C to cancel the CLI.

## Show your application's name

Create an application so the prompt shows your name and purpose instead of `mac-location`:

```ts
import { createApplication } from 'mac-location'

const app = createApplication({
	id: 'com.example.weather-cli',
	name: 'Weather CLI',
	locationUsageDescription: 'Show the weather forecast for your current location.'
})

await app.getCurrentPosition()
```

Keep the identity stable. Do not change the ID to bypass a denial; direct the user to the existing Location Services entry. Changed metadata or helper versions are prepared automatically on the next request.

## Handle errors

- For `PERMISSION_DENIED`, ask the user to enable the existing helper in **System Settings > Privacy & Security > Location Services**. Follow the [permission guide](../../docs/PERMISSIONS.md) for restricted access, disabled services, stale text, or prepared-storage recovery.
- For `LOCATION_SERVICES_DISABLED`, ask the user to enable Location Services. For `PERMISSION_RESTRICTED`, ask them to check device restrictions.
- For other failures, use the [Node error reference](../../docs/NODE.md#errors).

## Update the application

Prepare metadata without requesting location:

```ts
import { readFile } from 'node:fs/promises'

await app.updateMeta({ name: 'Weather Station' })

// Supply .icns bytes (Uint8Array or Buffer); null removes the custom icon
await app.updateMeta({ icon: await readFile('./weather.icns') })

// Prepare the current identity without requesting coordinates
await app.updateMeta({})
```

The ID stays fixed. Await completion before making requests with the new metadata. Failed or canceled updates leave the object unchanged. See the [permission guide](../../docs/PERMISSIONS.md#after-changing-your-application) for prompts and Settings refresh after updates, and the [icon guide](../../docs/NODE.md#custom-icons) for where custom icons appear.

## Full reference

- [NODE.md](../../docs/NODE.md) — options, cancellation, application identity, updates, errors.
- [CLI.md](../../docs/CLI.md) — flags, output, exit behavior.
- [PERMISSIONS.md](../../docs/PERMISSIONS.md) — prompts, denial recovery, prepared storage.
