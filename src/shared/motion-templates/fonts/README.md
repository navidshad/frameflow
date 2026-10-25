# Motion page fonts

Bundled into every motion page as data URLs by `scripts/embed-motion-fonts.mjs`
(run `node scripts/embed-motion-fonts.mjs` after changing a file here). Pages
cannot load fonts any other way: their CSP allows only `data:` fonts.

| File | Family | Version and source | Licence |
| --- | --- | --- | --- |
| `Inter-roman-latin.woff2` | Inter | Latin subset, variable 100–900 | `OFL.txt` |
| `Outfit-latin.woff2` | Outfit | Google Fonts v15, Latin subset, variable 100–900 | `OFL-Outfit.txt` |
| `Vazirmatn-arabic.woff2` | Vazirmatn (also inside Inter for Arabic script) | v33.003, official release `vazirmatn-v33.003.zip` from https://github.com/rastikerdar/vazirmatn/releases/tag/v33.003 (zip sha256 `0a9afd41967e6f57096a56a181a23f81a2b999b62f1f2a4e4b26736580854fdb`), `fonts/variable/Vazirmatn[wght].ttf`, variable 100–900 | `OFL-Vazirmatn.txt` (from the same zip) |

## How the Vazirmatn subset was cut

Arabic script (Persian, Arabic and Urdu letters, Persian and Arabic-Indic
digits, harakat, ZWNJ/ZWJ and the direction marks, presentation forms), plus
the space and the punctuation Persian text uses most (`! ( ) , - . : « » – — …`
and the no-break space), so a stack that names Vazirmatn alone does not borrow
them from a system font. Latin letters and digits are left to Inter. Every
OpenType layout feature is kept, so joining, ligatures and mark placement still
work, and so is the weight axis.

```bash
pyftsubset 'Vazirmatn[wght].ttf' \
  --unicodes='U+0020-0021,U+0028-0029,U+002C-002E,U+003A,U+00A0,U+00AB,U+00BB,U+2013-2014,U+2026,U+0600-06FF,U+0750-077F,U+08A0-08FF,U+200C-200F,U+25CC,U+FB50-FDFF,U+FE70-FEFF' \
  --layout-features='*' --no-hinting --desubroutinize \
  --flavor=woff2 --output-file=Vazirmatn-arabic.woff2
```

fontTools 4.67 with brotli. Result: 45,788 bytes (the full variable TTF is 241,328).
Keep the ranges in step with `SPACING_RANGE` and `ARABIC_RANGE` in the embed
script. Inside the Inter family the face claims `ARABIC_RANGE` only, so Inter
keeps its own space and punctuation.
