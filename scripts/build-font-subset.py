#!/usr/bin/env python
"""
Build the self-hosted interface font subset.

Why this exists
---------------
The reference loaded Noto Sans SC through its framework font loader, which downloads it from Google at build
time. That does not work here: this appliance may be built and deployed without egress, so the
font has to come from the repository.

Why a subset rather than the font
---------------------------------
The upstream variable font is 16.9MB, which is why a CJK face is normally not vendored. It does
not need to be. The UI text is a closed set, so the subset only carries glyphs that can appear.

Coverage: the app's own text PLUS the full GB2312 character set
---------------------------------------------------------------
Subsetting to just today's strings would mean regenerating whenever someone adds a sentence with
an unfamiliar character - and, worse, silently falling back to a system font if they forget.
GB2312's 6763 ideographs cover essentially all modern simplified Chinese, so the subset is built
once over that whole range and regeneration becomes a rare event rather than a routine step.

Measured sizes (variable font, woff2):

    UI text only                     275 KB
    + GB2312 (this build)          1,877 KB
    + all CJK Unified Ideographs   5,581 KB
    upstream source font          16,900 KB

Emits `coverage.json` next to the font
--------------------------------------
`scripts/check-font-coverage.mjs` validates the subset against the source on every gate run. It
reads this manifest rather than parsing the woff2, so the check needs neither fontTools nor the
source font, and therefore works on any platform, offline.

Run with: npm run build:fonts
"""
import io
import json
import os
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'src')
# Source font locations probed in order. `XCLOUD_FONT_SOURCE` overrides the search, so no
# single platform's font directory is baked in as the only option.
FONT_CANDIDATES = (
    'C:/Windows/Fonts/NotoSansSC-VF.ttf',
    os.path.expanduser('~/Library/Fonts/NotoSansSC-VF.ttf'),
    os.path.expanduser('~/.local/share/fonts/NotoSansSC-VF.ttf'),
    '/usr/share/fonts/opentype/noto/NotoSansSC-VF.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansSC-VF.ttf',
    '/usr/local/share/fonts/NotoSansSC-VF.ttf',
)


def resolve_source_font():
    """Explicit override wins; otherwise probe the per-platform default locations.

    The font is only needed to REGENERATE the committed subset, so a miss is not fatal:
    `main` reports it and exits without touching the shipped artefact.
    """
    explicit = os.environ.get('XCLOUD_FONT_SOURCE')
    if explicit:
        return explicit
    for candidate in FONT_CANDIDATES:
        if os.path.isfile(candidate):
            return candidate
    return FONT_CANDIDATES[0]


SRC_FONT = resolve_source_font()
OUT_DIR = os.path.join(ROOT, 'assets', 'fonts')
OUT_FONT = os.path.join(OUT_DIR, 'NotoSansSC-subset.woff2')
OUT_MANIFEST = os.path.join(OUT_DIR, 'coverage.json')


def walk(d, acc):
    for name in os.listdir(d):
        full = os.path.join(d, name)
        if os.path.isdir(full):
            walk(full, acc)
        elif full.endswith(('.ts', '.tsx', '.css', '.html')):
            acc.append(full)
    return acc


def gb2312_chars():
    """Decode GB2312's byte ranges: level 1 0xB0A1-0xD7F9, level 2 0xD8A1-0xF7FE."""
    chars = set()
    for hi in list(range(0xB0, 0xD8)) + list(range(0xD8, 0xF8)):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return chars


def source_chars():
    chars = set()
    for f in walk(ROOT, []):
        if 'assets' in f.replace('\\', '/').split('/'):
            continue
        try:
            chars.update(io.open(f, encoding='utf-8').read())
        except Exception:
            pass
    return chars


def base_chars():
    """Ranges that must render even when no source file contains them today: ASCII, Latin-1,
    general punctuation, currency, arrows, maths, box drawing, geometric shapes, CJK punctuation
    and fullwidth forms. Covers operator input and server-returned strings."""
    chars = set()
    for lo, hi in [(0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x2070, 0x209F),
                   (0x20A0, 0x20BF), (0x2100, 0x214F), (0x2190, 0x21FF), (0x2200, 0x22FF),
                   (0x2500, 0x257F), (0x25A0, 0x25FF), (0x2600, 0x26FF),
                   (0x3000, 0x303F), (0xFF00, 0xFFEF)]:
        chars.update(chr(c) for c in range(lo, hi + 1))
    return chars


def to_ranges(codepoints):
    out = []
    for cp in sorted(codepoints):
        if out and cp == out[-1][1] + 1:
            out[-1][1] = cp
        else:
            out.append([cp, cp])
    return out


def main():
    if not os.path.exists(SRC_FONT):
        sys.stderr.write(
            'source font not found: %s\n'
            'The committed subset is still valid for building and shipping the app; this script\n'
            'is only needed to REGENERATE it after adding text the subset does not cover.\n'
            'Install Noto Sans SC, or set XCLOUD_FONT_SOURCE to another copy of the variable font.\n' % SRC_FONT)
        return 1

    chars = base_chars() | gb2312_chars() | source_chars()
    text = ''.join(sorted(chars))
    os.makedirs(OUT_DIR, exist_ok=True)

    charset_file = os.path.join(OUT_DIR, '.charset.tmp')
    io.open(charset_file, 'w', encoding='utf-8').write(text)
    try:
        subprocess.run([
            sys.executable, '-m', 'fontTools.subset', SRC_FONT,
            '--text-file=' + charset_file,
            '--flavor=woff2',
            '--layout-features=*',
            '--name-IDs=1,2,3,4,6',
            '--no-hinting',
            '--desubroutinize',
            '--output-file=' + OUT_FONT,
        ], check=True)
    finally:
        if os.path.exists(charset_file):
            os.remove(charset_file)

    # Record the ACTUAL coverage by reading back the generated font's cmap, not the set of
    # codepoints we asked for. The subsetter silently drops any requested codepoint the upstream
    # font has no glyph for - U+21B5 for one - and a manifest built from the request would then
    # report that codepoint as covered while the browser substitutes a fallback font for it.
    from fontTools.ttLib import TTFont
    actual = set()
    for table in TTFont(OUT_FONT)['cmap'].tables:
        actual.update(table.cmap.keys())
    dropped = sorted(set(ord(c) for c in chars) - actual)
    if dropped:
        print('note: %d requested codepoints have no glyph in the upstream font and were dropped'
              % len(dropped))

    # Written compactly, with the ranges flattened to a single [lo, hi, lo, hi, ...] array.
    # GB2312's ideographs are scattered across the CJK block, so this is ~3500 ranges; pretty
    # printing them costs 112KB against 40KB flat, for a file that is machine-read only.
    ranges = to_ranges(actual)
    flat = []
    for lo, hi in ranges:
        flat.append(lo)
        flat.append(hi)
    io.open(OUT_MANIFEST, 'w', encoding='utf-8').write(json.dumps({
        'font': 'Noto Sans SC',
        'licence': 'SIL Open Font License 1.1',
        'coverage': 'UI source text + full GB2312',
        'rangeCount': len(ranges),
        'codepointCount': len(actual),
        'ranges': flat,
    }, ensure_ascii=False, separators=(',', ':')) + '\n')

    print('subset: %.1f KB, %d codepoints covered' % (os.path.getsize(OUT_FONT) / 1024, len(actual)))
    print('manifest: %s' % os.path.relpath(OUT_MANIFEST, ROOT))
    return 0


if __name__ == '__main__':
    sys.exit(main())
