# Engineering research notes

Tracked maintainer references for the tools and contracts that shape mac-location.

## Ownership

Each upstream folder owns that platform's behavior, implementation, configuration, and
version boundaries. The mac-location folder owns project policy, integration, and
cross-tool synthesis, and links to upstream evidence.

## Index

| Folder | Owns |
| --- | --- |
| [macos/](./macos/README.md) | macOS location-permission and code-signing behavior |
| [mac-location/](./mac-location/README.md) | Project policy, helper build, and permission decisions |

## Evidence

Cite upstream facts beside the claim using public primary sources, preferably pinned
releases or commits. Ground project behavior in repository source or tests, and label
decisions with their rationale. Distinguish documented and observed behavior from
inference. Keep executable contracts in the test suite.

## Maintenance

When upstream evidence changes, update the notes and identify affected project
decisions and tests. Make implementation or packaging changes only when they are within
the requested scope.

`notes/` is not listed in the package `files` field, so it is not published to npm.
