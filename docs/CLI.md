# CLI

## Usage

```sh
mac-location            # 35.6586,139.7454
mac-location --json     # { latitude, longitude, accuracy, timestamp }
```

The default output is `latitude,longitude`, so it composes with tools that take coordinates:

```sh
# Get the weather for the current location
curl "https://wttr.in/$(mac-location)?format=3"
```

`--json` prints the full object, pretty-printed.

```sh
mac-location --timeout 10000 --maximumAge 60000 --json
```

macOS identifies the CLI as `mac-location`. Custom names, icons, and metadata updates are available only through the [Node application API](./NODE.md#createapplicationidentity).

## Flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--timeout` | number | `30000` | Milliseconds to wait for a location after access is granted. Time on the permission prompt does not count. |
| `--maximumAge` | number | `0` | Accept a cached location up to this many milliseconds old. `0` requires a new measurement. |
| `--json` | boolean | off | Print the full object instead of `latitude,longitude`. |

- `--timeout` accepts an integer from `1` through `2147483647`.
- Press Ctrl-C to cancel.

## Exit behavior

- Success: prints the location to stdout and exits `0`.
- Failure: prints the error message to stderr and exits `1`.

While the macOS permission prompt waits for an answer, the CLI prints `Waiting for location permission. Choose Allow in the macOS prompt, or press Ctrl-C to cancel.` to stderr and keeps waiting.

If access was granted but no location arrives within `--timeout`, the CLI prints `No location within <timeout> ms after location access was granted` and exits `1`.

Use `mac-location --help` for the built-in usage text.
