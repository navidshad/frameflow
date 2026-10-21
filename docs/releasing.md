# 📦 Releasing & Code Signing

How a FrameFlow installer gets built, signed, and published.

---

## 🏷 Cutting a release

Releases are tag-triggered. Bump the version and push the tag:

```bash
npm version patch && git push --follow-tags
```

`.github/workflows/release.yml` picks the tag up and builds four artefacts in
parallel — macOS arm64, macOS x64, Windows x64, Linux x64 — then attaches them
to the GitHub release. The workflow refuses to run if the tag and the
`package.json` version disagree, because a mismatch produces a release whose
files are named for a different version.

To exercise the build **without** spending a version number, run the workflow
manually from the Actions tab. A manual run builds everything and uploads the
artefacts to the run, but publishes nothing.

---

## ✍️ macOS: signing and notarisation

An unsigned macOS build is blocked by Gatekeeper with "cannot be opened because
the developer cannot be verified". Signing needs an active **Apple Developer
Program** membership ($99/yr) and a **Developer ID Application** certificate.

Packaging is already configured for it in `electron-builder.yml`:
`hardenedRuntime` is on, and `build/entitlements.mac.plist` carries the four
entitlements Electron needs (JIT, unsigned executable memory, and — because the
app spawns bundled ffmpeg/ffprobe/yt-dlp binaries — library-validation and dyld
environment variables). Nothing in the config changes when the certificate
arrives; only the secrets below.

### Repository secrets

| Secret | What it is |
|---|---|
| `MAC_CSC_LINK` | The Developer ID `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | The password the `.p12` was exported with |
| `APPLE_API_KEY_CONTENT` | The full text of the App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | The key's ID |
| `APPLE_API_ISSUER` | The issuer UUID from App Store Connect |

The App Store Connect API key is preferred over `APPLE_ID` +
`APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`: it is scoped, revocable, and
keeps an account password out of CI. electron-builder accepts either.

**Until these secrets exist the build still succeeds** and produces an unsigned,
un-notarised app — `CSC_IDENTITY_AUTO_DISCOVERY` resolves to `false` so
electron-builder does not fail looking for an identity that is not there, and
notarisation skips itself when it cannot assemble credentials.

### Verifying a signed build

```bash
spctl -a -vvv -t install dist/FrameFlow-*.dmg
```

Expect `accepted` and `source=Notarized Developer ID`. Then confirm the ticket
is stapled, so the app opens on a machine that is offline:

```bash
xcrun stapler validate dist/FrameFlow-*.dmg
```

The subtle failure this configuration exists to prevent is a signed, notarised
app whose **ffmpeg child process is killed on spawn**, because binaries under
`app.asar.unpacked` were not themselves signed. electron-builder 26 signs them
automatically and `strictVerify` fails the build if it cannot — but it is worth
checking directly after any change to `asarUnpack`:

```bash
codesign --verify --deep --strict --verbose=2 dist/mac-*/FrameFlow.app
```

Every nested binary should report `flags=0x10000(runtime)` under
`codesign -dv`. The only test that really counts is downloading the DMG on a
machine that has never seen the source tree, installing, and running an import
and an export end to end.

---

## 🪟 Windows: not signed yet

Windows artefacts are currently **unsigned**, so SmartScreen shows an
"unrecognised app" wall that users must click through. This is a deliberate
deferral, not an oversight.

Since 2023 an OV certificate must be held on hardware or in an HSM, so a `.pfx`
file in CI is no longer purchasable. The intended route is **Azure Trusted
Signing** (~$10/month, no HSM to manage), which electron-builder 26 supports
natively — the block to fill in is commented in place under `win:` in
`electron-builder.yml`, and needs no other change.

> electron-builder 27 replaces both `azureSignOptions` and `signtoolOptions`
> with a single `win.sign` object. Expect this shape to move at the next major.

---

## 🚧 Outstanding before the first public installer

- [ ] **Apple Developer Program membership** and a Developer ID Application
      certificate. Enrolment can take days; nothing else blocks on it.
- [ ] **`build/icon.png`** — a square 1024×1024 master. There is no app icon in
      the repo, so every build currently ships the default Electron logo.
      electron-builder derives the `.icns` and `.ico` from this one file.
- [x] **A public releases repo.** Releases publish to `navidshad/frameflow`,
      which is public, so installers are downloadable and `electron-updater`
      can read them without a token.
- [ ] **Windows code signing**, per the section above.

Auto-update itself is a separate roadmap item. The `zip` target alongside `dmg`
is already there for it: Squirrel.Mac cannot consume a `dmg`.

> When auto-update is wired up, note that both macOS legs publish their own
> `latest-mac.yml` to the same release and the second overwrites the first.
> That needs resolving before the updater is trusted to pick an architecture.
