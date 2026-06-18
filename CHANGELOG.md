# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Multi-version support** via [Stonecutter](https://stonecutter.kikugie.dev/): the mod now builds
  for Minecraft 1.21.1–1.21.11 and the 26.x line (26.1.x, 26.2) from a single source tree.
  Per-version jars are produced as `mcpfabric-<modVersion>+<mcVersion>.jar`.
- `./gradlew chiseledBuild` to build every supported version; per-version configuration lives in
  `versions/<mcVersion>/gradle.properties`.
- GitHub Actions CI building all versions and type-checking the MCP server.
- `CONTRIBUTING.md`, `SECURITY.md`, issue/PR templates.

### Changed
- Build upgraded to Fabric Loom 1.17.x and Gradle 9.5.x.
- README is now in English.

## [0.1.0]

- Initial single-version (Minecraft 1.21.8) release: Fabric mod with an embedded HTTP bridge and a
  TypeScript MCP server exposing ~50 tools for full read & control of Minecraft.
