# Releasing mcpfabric

This project ships one mod, built for every supported Minecraft version from a single source tree
([Stonecutter](https://stonecutter.kikugie.dev/)). A release builds all of those versions, publishes
each to Modrinth, and creates a GitHub Release with every jar attached — all driven by pushing a
single git tag.

## How a release flows

```
git tag vX.Y.Z  ──push──▶  .github/workflows/release.yml
                              ├─ verify tag == mod_version
                              ├─ ./gradlew chiseledBuild        (build all MC versions)
                              ├─ ./gradlew publishMods          (upload each to Modrinth)
                              └─ GitHub Release with all jars attached
```

Each Minecraft version becomes its own Modrinth version, numbered `X.Y.Z+<mcVersion>` (for example
`0.2.0+1.21.8`), targeting exactly the Minecraft version(s) it was built for. Users filtering Modrinth
by their Minecraft version get the correct jar.

## One-time setup

You only do this once, before the first published release.

### 1. Create the Modrinth project

1. Go to <https://modrinth.com> → **Create a project** (type: **Mod**, loader: **Fabric**).
2. Fill in the name, summary, description/body, license (**MIT**), and an icon. The publish step
   does **not** sync the project page — set the body and icon on the website.
3. Add **Fabric API** as a required dependency on the project (the publish step also declares it
   per version, but setting it on the project is good hygiene).
4. Copy the project **ID** (Settings → General) or its **slug** from the URL.

Put it in [`gradle.properties`](../gradle.properties):

```properties
modrinth_id=YOUR_ID_OR_SLUG   # replace CHANGEME
```

### 2. Create a Modrinth token

1. Modrinth → **Account settings → PATs** (Personal Access Tokens).
2. Create a token with at least the **Create versions** scope. Copy it once — it is shown only once.

### 3. Add the token as a GitHub secret

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name             | Value                     |
| ---------------- | ------------------------- |
| `MODRINTH_TOKEN` | the PAT created in step 2 |

> Until both `modrinth_id` and `MODRINTH_TOKEN` are set, the release still runs but Modrinth upload
> is skipped (the Gradle task runs in **debug mode**: it builds and validates, uploads nothing).
> The GitHub Release with jars is still created.

## Cutting a release

1. **Bump the version** in [`gradle.properties`](../gradle.properties):

   ```properties
   mod_version=0.3.0
   ```

   Version scheme: the jar/Modrinth version is `mod_version+minecraft_version`. The git tag carries
   only the mod version (`v0.3.0`). For pre-releases use a suffix — `0.3.0-beta.1`, `0.3.0-rc.1` —
   which the workflow flags as a GitHub pre-release automatically.

2. **Update [`CHANGELOG.md`](../CHANGELOG.md)**: move the `[Unreleased]` notes into a new
   `## [0.3.0] - YYYY-MM-DD` section. The Modrinth version notes are pulled from the section whose
   header matches `mod_version`, so this header must exist.

3. **Commit, tag, push:**

   ```bash
   git add gradle.properties CHANGELOG.md
   git commit -m "chore: release v0.3.0"
   git push
   git tag v0.3.0
   git push origin v0.3.0
   ```

   The tag must match `mod_version` exactly, or the workflow fails fast with a clear message.

4. Watch the **Release** workflow in the Actions tab. On success you get the Modrinth versions and a
   GitHub Release.

### Manual / re-run

The workflow also has a `workflow_dispatch` trigger (Actions tab → **Release** → **Run workflow**),
which takes the version (without the leading `v`) and creates the tag if it does not yet exist.
Useful for re-running a failed publish.

## Build locally without publishing

```bash
./gradlew chiseledBuild        # build every version → versions/<mc>/build/libs/*.jar
./gradlew publishMods          # debug mode unless MODRINTH_TOKEN is set; uploads nothing locally
./gradlew :1.21.8:build        # build a single version
```

## Adding a new Minecraft version

1. Add the version to the `versions(...)` list in [`settings.gradle`](../settings.gradle).
2. Create `versions/<newVersion>/gradle.properties` (copy an existing one; set `minecraft_version`,
   `fabric_api_version`, `minecraft_dep`, `java_version`).
3. Resolve any source differences with Stonecutter `//?` comments.

It is then built and published automatically by the next release — no workflow changes needed.

## Enabling CurseForge later

CurseForge is intentionally left out for now. To add it:

1. Create the CurseForge project and note its **numeric project ID**.
2. Add the [`net.darkhax.curseforgegradle`](https://github.com/Darkhax-Minecraft/CurseForgeGradle)
   plugin to `stonecutter.gradle` (apply false) and apply it in `build.gradle`, registering a
   `curseforge` task per node that uploads `remapJar` with the node's `minecraft_version`.
3. Add `dependsOn(stonecutter.tasks.named('curseforge'))` to the `publishMods` task.
4. Add a `CURSEFORGE_TOKEN` GitHub secret and pass it through `env:` in the publish step of
   `release.yml`.
