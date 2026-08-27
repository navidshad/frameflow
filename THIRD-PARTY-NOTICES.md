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

> ### ⚠️ ACTION REQUIRED BEFORE ANY DISTRIBUTION
>
> The build currently resolved by `ffmpeg-static@5.3.0` is configured with
> **both `--enable-gpl` and `--enable-nonfree`**. Per FFmpeg's own licensing
> terms, a `--enable-nonfree` build **cannot be redistributed at all**.
>
> Before shipping any binary — free or paid — pin a GPL-but-not-nonfree build
> (e.g. BtbN/FFmpeg-Builds) or an LGPL build via the `FFMPEG_BINARIES_URL`
> environment variable, and verify the `configure` line of the binary for
> **each** target platform. Then replace this box with the confirmed license.

Once repinned to a GPL build, the following applies:

- FFmpeg is licensed under the GNU General Public License, version 2 or later.
- The full GPL text is distributed alongside the binary.
- **Written offer:** the complete corresponding source code for the bundled
  FFmpeg build is available on request for a period of three years, at no
  charge beyond the cost of distribution. Contact: <navidshad72@gmail.com>.
- FFmpeg homepage: https://ffmpeg.org — source: https://git.ffmpeg.org/ffmpeg.git

---

## 3. yt-dlp

Downloaded at runtime for URL and YouTube media import. Released into the
public domain under the Unlicense. https://github.com/yt-dlp/yt-dlp

Note: yt-dlp is fetched at runtime rather than bundled. This is incompatible
with Mac App Store distribution (App Review Guideline 2.5.2) and must be
reviewed before any store submission.

---

## 4. PySceneDetect

Invoked as an external process for scene detection when present on the host.
Licensed under the BSD 3-Clause License.
Copyright (c) 2014-2024 Brandon Castellano. https://www.scenedetect.com

Note: scheduled for removal in favour of FFmpeg's native `scdet` filter, which
eliminates this dependency and its Python runtime requirement entirely.

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
