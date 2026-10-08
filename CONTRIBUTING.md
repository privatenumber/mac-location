# Contributing

## Building

```sh
pnpm install
pnpm build
```

`pnpm build` compiles the Swift helper (requires Xcode command line tools) and bundles the JavaScript with [pkgroll](https://github.com/privatenumber/pkgroll).

On non-macOS systems, the native helper step is skipped and only the JavaScript is built.

## Repository layout

| Directory | Contents |
| --- | --- |
| `src/` | TypeScript API and CLI |
| `src-native/` | Swift helper source |
| `dist/` | Built JavaScript and type declarations (gitignored) |
| `dist-native/` | Built macOS app bundle (gitignored) |
| `bench/` | Benchmarks and reporting utilities |

## Testing

```sh
pnpm test
```

Most tests use fixture executables and run anywhere. Tests that need the real native helper are skipped when the helper has not been built or when running outside macOS.

To run the live location test, which requires an approved Location Services permission on macOS:

```sh
MAC_LOCATION_LIVE=1 pnpm test
```

To run the native helper tests, which launch the real helper to check that it exits at its own deadline and when its caller goes away:

```sh
MAC_LOCATION_NATIVE=1 pnpm test
```

## Rebuilding the native helper

The helper source lives at `src-native/LocHelper.swift`. To rebuild just the helper:

```sh
pnpm build:helper
```

The build writes a universal Apple Silicon and Intel app bundle to `dist-native/mac-location.app`. This directory is gitignored. Package builds compile the helper from source and fail if either architecture cannot be built.

## Location permission

See the [permission guide](docs/PERMISSIONS.md) for user recovery and the [release-validation note](notes/mac-location/release-validation.md) for the tested-version matrix, artifact identity, and interactive validation procedure.

## Benchmarks

```sh
pnpm build
pnpm benchmark:preparation
pnpm benchmark:end-to-end --live
```

Benchmark code lives in `bench/`; reports are written to `bench/results/` (gitignored). Pass `--help` to either benchmark for flags and defaults.

The live benchmark requests location access. Reports record the commit, macOS build, architecture, Node version, and helper executable hash. Preparation and location acquisition are separate costs; compare absolute milliseconds under the same conditions.

The preparation benchmark uses Mitata with fixed sample counts and no batching:

- Cold preparation and metadata changes each discard one warm-up call. Warm reuse and retained versions discard five.
- Every cold call uses fresh storage, including warm-up calls. Setup and cleanup are outside timing.
- Preparation errors stop the run.
- The contention scenarios launch multiple processes and record per-request latency and total completion time.

The end-to-end benchmark measures location requests:

- Both the generic helper and application helper must return a location before sampling begins. If either preflight request fails, the comparison stops with exit code `1`.
- Reports separate preflight outcomes, failed warm-up requests, and failed measured requests.
- Setup/update duration can include reuse of a retained bundle; it is not a cold-preparation measurement.

Both benchmarks require a readable helper to record its hash.

## Publishing

Publish with `npm publish` (or `pnpm dlx semantic-release`, which uses npm). For Git branch distribution, use `git-publish`. The `publishConfig.executableFiles` declaration preserves the native helper's executable permission when `pnpm pack` creates the package archive.

Run `pnpm verify-helper` and follow [release validation](notes/mac-location/release-validation.md) against the packaged artifact before publishing.
