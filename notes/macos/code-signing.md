# Code signing identity on macOS

macOS assigns a code identity to signed code. Subsystems that gate access to resources
key their decisions to that identity. This note covers the mechanism the location
permission depends on; see [location-permission.md](./location-permission.md).

Primary reference: Apple, [Technical Note TN2206: macOS Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
(accessed 2026-10-04). TN2206 predates recent macOS releases; its identity model still
matches what is observed below.

## Identity is the designated requirement

- **Documented:** a subsystem's initial policy decision is verified afterward against the
  code's designated requirement (DR). "All policy decisions are determined by a specific
  subsystem and not by code signing itself", and subsystems differ in whether they track
  identity at all (TN2206, "Trust and Code Signing").
- **Documented:** the DR is synthesized at signing time unless supplied. It "should also
  be satisfied by updates, i.e., new versions of that code, and by nothing else"
  (TN2206, "Code Designated Requirement").
- **Documented:** the requirement language includes `cdhash <hash>`, the CodeDirectory's
  SHA-1 hash (TN2206, "Code Requirements").

## Ad-hoc signatures use a cdhash based requirement

- **Observed:** `codesign -s -` (ad-hoc) on an app bundle produces a DR of two `cdhash`
  values, one per architecture slice, for example
  `cdhash H"e1b48f73..." or cdhash H"13ef12ff..."`. The two values correspond to the
  `arm64` and `x86_64` slices of the universal binary.

A cdhash based DR has no certificate and no stable identifier. Any change to the signed
content produces a different cdhash. Whether a given subsystem then treats the code as a
distinct identity is that subsystem's policy, not a property of the signature (TN2206,
"Trust and Code Signing").

## Signing modifies the executable

- **Documented:** "Signing a program will modify its main executable file." (TN2206,
  "Signing Modifies the Executable").
- **Observed:** signing the same prebuilt executable inside two bundles that differed
  only in `Info.plist` values produced two different executable hashes and two different
  cdhashes. The bundle's `Info.plist` is sealed by the bundle signature, so its hash is
  part of the code identity.

Consequently, changing only the bundle metadata (for example
`NSLocationUsageDescription`) changes the cdhash, even though the compiled code is
identical.

## Signing is deterministic for identical content

- **Observed:** re-signing a bundle with identical content produced the same executable
  hash and the same cdhash across repeated runs (macOS 26.5.2). Recreating a bundle from
  identical inputs reproduces the same identity.

## Stability across updates

- **Documented:** the DR is intended to be satisfied by updates to the same program
  (TN2206).
- **Inference:** a stable signing identity (for example Developer ID) yields a DR based
  on the signing identifier and certificate, so it could survive content changes. Ad-hoc
  signing has neither, so its DR cannot survive a content change.
Whether a stable signing identity would persist location permission across changes is not established. The [permission note](./location-permission.md#authorization-retention) owns the observed authorization results.
