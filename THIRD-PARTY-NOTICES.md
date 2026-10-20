# Third-Party Notices

FrameFlow Pro incorporates third-party software. This file reproduces the
notices those licenses require. It must ship with every distributed binary.

---

## 1. FrameFlow (original project)

FrameFlow Pro derives from the FrameFlow project, released under the MIT
License. MIT permits proprietary derivative works, subject to reproducing the
notice below. Contributors to the original project retain copyright in their
own contributions, licensed to this work under the same terms.

Original contributors: Navid Shad, Somayeh Roohani (SomiVista),
Esat Can Karabag.

```
MIT License

Copyright (c) 2026 Navid

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. FFmpeg

FrameFlow Pro bundles the FFmpeg and FFprobe executables and invokes them as
separate processes. FFmpeg is not linked into this application; the two are
distributed as an aggregate.

**Version:** FFmpeg 9.0.1, on every platform.

**License:** GNU General Public License, **version 3 or later**. Every bundled
build is configured `--enable-gpl --enable-version3`; the `--enable-version3`
flag is what makes this v3 rather than v2-or-later, so GPL-3.0 terms govern.
None is configured `--enable-nonfree`.

The full licence text ships next to the executables it covers, as
`LICENSE.txt` in the app's `ffmpeg` resources directory.

### Builds

Binaries are pinned by URL and SHA-256 in `scripts/ffmpeg-manifest.json` and
fetched at install time by `scripts/fetch-ffmpeg.mjs`.

| Target | Builder |
|---|---|
| macOS arm64 | [martin-riedl.de](https://ffmpeg.martin-riedl.de/) |
| macOS x64 | [martin-riedl.de](https://ffmpeg.martin-riedl.de/) |
| Windows x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) |
| Linux x64 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) |

Two builders rather than one because **licensing varies by platform within a
single builder** — martin-riedl's macOS builds are clean GPL while its Linux
builds are `--enable-nonfree`, and BtbN publishes no macOS build at all. Each
shipped binary records the archive it came from, that archive's SHA-256, and
its full `configure` line in `PROVENANCE.txt`, alongside `LICENSE.txt`.

The build that ships is never trusted on the strength of its source. The fetch
script reads the `configure` line out of each executable on every install and
refuses to install one carrying `--enable-nonfree`; the release workflow
re-runs that check before packaging, and `.github/workflows/ffmpeg-licence.yml`
re-checks all four targets whenever the pins change. This replaced
`ffmpeg-static`, whose darwin-arm64 build was `--enable-nonfree` while its
other three platforms were clean — a split nothing in the toolchain surfaced.

### Corresponding source

- FFmpeg homepage: https://ffmpeg.org
- Upstream source for this version:
  https://git.ffmpeg.org/gitweb/ffmpeg.git/shortlog/refs/tags/n9.0.1
- Build recipes: the builders' own published scripts, linked in the table above.
- **Written offer:** the complete corresponding source code for the bundled
  FFmpeg build is available on request for a period of three years, at no
  charge beyond the cost of distribution. Contact: <navidshad72@gmail.com>.

---

## 3. yt-dlp

Downloaded at runtime for URL and YouTube media import. Released into the
public domain under the Unlicense. https://github.com/yt-dlp/yt-dlp

Note: yt-dlp is fetched at runtime rather than bundled. This is incompatible
with Mac App Store distribution (App Review Guideline 2.5.2) and must be
reviewed before any store submission.

---

## 4. PySceneDetect — removed

No longer a dependency. Scene detection now uses FFmpeg's native `scdet` filter
(see section 2), which removed the Python runtime requirement and the last
obstacle to a self-contained installer.

This section is retained as a record: releases up to and including v1.1.23
invoked the PySceneDetect CLI as an external process when it was present on the
host. It is licensed under the BSD 3-Clause License,
Copyright (c) 2014-2024 Brandon Castellano, https://www.scenedetect.com — and it
was never bundled or redistributed, only called if the user had installed it.

---

## 5. npm dependencies

627 packages across the dependency tree, distributed under:

| License | Packages |
|---|---|
| MIT | 507 |
| ISC | 45 |
| Apache-2.0 | 22 |
| BSD-3-Clause | 22 |
| BSD-2-Clause | 14 |
| BlueOak-1.0.0 | 4 |
| MPL-2.0 | 2 |
| Other (0BSD, BSD, CC0-1.0, CC-BY-4.0, Python-2.0, WTFPL) | 8 |
| Unspecified | 1 (`browser-assert@1.2.1`) |

No dependency imposes copyleft obligations on this application's own source.
`ffmpeg-static` is reported as GPL-3.0-or-later because it declares the license
of the binary it downloads — see section 2; the wrapper itself is not linked
into the application.

The complete per-package attribution list is generated at build time and ships
inside the installer. Regenerate with:

    npx license-checker-rseidelsohn --production --files ./attribution

---

## 6. Fonts

Fonts distributed with style packs are licensed under the SIL Open Font
License 1.1. Each pack includes its own `OFL.txt`. OFL permits bundling and
commercial use; the fonts themselves are not sold, and any modified font is
renamed as the license requires.

Motion templates embed two fonts into every motion page, so a page renders the
same in the preview and the export without reaching the network:

| Font | Copyright | License | Where |
|---|---|---|---|
| Inter (variable, latin) | © The Inter Project Authors | SIL OFL 1.1 | `src/shared/motion-templates/fonts/OFL.txt` |
| Outfit (variable, latin; Google Fonts v15) | © 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts) | SIL OFL 1.1 | `src/shared/motion-templates/fonts/OFL-Outfit.txt` |

Both are unmodified subsets as Google Fonts serves them, under their reserved
names. `scripts/embed-motion-fonts.mjs` turns them into data URLs.
