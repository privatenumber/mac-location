# mac-location

Get your Mac's location from Node.js or the command line.

Uses Apple's [Core Location](https://developer.apple.com/documentation/corelocation) through a bundled native helper.

### Features

- Latitude, longitude, accuracy, and location timestamp
- Node.js API and CLI
- Custom application names, permission descriptions, and [icons](docs/NODE.md#custom-icons)
- Prebuilt for Apple Silicon and Intel
- No Xcode or Swift installation required
- Native macOS location, with no IP-based fallback
- One-shot requests, with no background tracking

## Install

Requires macOS on Apple Silicon or Intel and Node.js >= 22.22.2. Linux and Windows are not supported.

```sh
npm i mac-location
```

For terminal use, install with `npm i -g mac-location`.

## Node.js

```ts
import { getCurrentPosition } from 'mac-location'

const position = await getCurrentPosition()
console.log(position)
// {
//   latitude: 35.6586,       // Latitude in degrees (WGS84)
//   longitude: 139.7454,     // Longitude in degrees (WGS84)
//   accuracy: 35,            // Horizontal accuracy in meters
//   timestamp: 1750000000000 // When macOS measured the location, in Unix milliseconds
// }
```

### Application identity

Use `createApplication()` to show your application's name and purpose in the macOS permission prompt instead of `mac-location`:

```ts
import { createApplication } from 'mac-location'

const app = createApplication({
    id: 'com.example.weather-cli',
    name: 'Weather CLI',
    locationUsageDescription: 'Show the weather forecast for your current location.'
})

const position = await app.getCurrentPosition()

// Prepare a new name without requesting location
await app.updateMeta({ name: 'Weather Station' })
```

The first request prepares a helper for your application; later requests reuse it. See the [Node guide](docs/NODE.md#createapplicationidentity) for icons, updates, and permission behavior.

## CLI

```sh
mac-location # 35.6586,139.7454
```

The default output is `latitude,longitude`, so it composes with tools that take coordinates:

```sh
# Get the weather for the current location
curl "https://wttr.in/$(mac-location)?format=3"
```

## Permissions

macOS asks for location access on first use. Choose Allow to get coordinates. Review access in **System Settings > Privacy & Security > Location Services**.

See the [permission guide](docs/PERMISSIONS.md) if access is denied or you change your application's metadata.

## How it works

The package includes a precompiled universal Swift helper inside an app bundle. The Node library launches its executable, waits for one location result, and cleans up the subprocess. Core Location supplies the coordinates; there is no IP-based fallback.

## Documentation

- [Node API](docs/NODE.md): exports, types, options, cancellation, application identity, updates, and errors.
- [CLI](docs/CLI.md): flags, output formats, shell examples, and exit behavior.
- [Permissions](docs/PERMISSIONS.md): allow/deny behavior, Settings recovery, renewed consent, and prepared storage.
- [Agent skill](skills/mac-location/SKILL.md): commands and task recipes.
- [Contributing](https://github.com/privatenumber/mac-location/blob/develop/CONTRIBUTING.md): build, test, benchmark, and publishing commands.
- [Engineering notes](https://github.com/privatenumber/mac-location/blob/develop/notes/README.md): platform evidence and project architecture.
