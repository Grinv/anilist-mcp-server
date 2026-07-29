#!/usr/bin/env python3
"""Regenerate assets/icon.png from the design in icon-source.svg.

Not part of the npm build — this is a one-off design asset, run manually
whenever the icon needs to change. Requires Pillow (`pip install pillow`).

Renders directly with Pillow instead of an SVG->PNG pipeline: both a
Chrome/chrome-devtools screenshot and macOS Quick Look's SVG thumbnailer
silently composite the transparent background against opaque white, which
Anthropic's MCPB icon spec explicitly requires ("PNG with transparency" —
see claude.com/docs/connectors/building/mcpb). Drawing directly gives real
per-pixel alpha with no compositing step to lose it.

Keep the geometry/gradient stops here in sync with icon-source.svg by hand
if you ever edit one — there's no automated link between the two.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "icon.png"

SIZE = 512
SCALE = 4  # supersample then downsample for anti-aliased edges (Pillow's
           # ImageDraw has no native AA)
STROKE = 30  # rounds every vertex (a "bookmark ribbon" polygon, matching
             # icon-source.svg's stroke-width) via the same trick tmdb-mcp's
             # icon uses: fill the polygon, stroke its closed outline with a
             # round join, and drop a filled circle on each vertex — this
             # reproduces SVG's stroke-linejoin="round" since PIL's
             # ImageDraw has no native corner-radius on an arbitrary path.

# A bookmark/ribbon: a tall rectangle with a triangular notch cut from the
# bottom edge — the universal "saved to my list" glyph, which is exactly
# what AniList (Anime List) tracking is about. One bold shape only (no
# secondary stripes/lines) so it stays legible down to a 16px favicon —
# a past icon attempt with thin interior lines "blended into mush" at that
# size; this shape has none.
VERTS = [
    (176, 90),   # top-left
    (336, 90),   # top-right
    (336, 422),  # bottom-right (ribbon tail)
    (256, 350),  # notch tip (cut up into the ribbon)
    (176, 422),  # bottom-left (ribbon tail)
]

# Real AniList brand blues, not guessed: pulled live from anilist.co's own
# CSS custom properties (`--color-blue-500` / `-600` / `-900`, inspected via
# getComputedStyle(document.documentElement) on the rendered site, 2026-07-29).
# `--color-blue` (their primary accent, `--color-blue-600`) is rgb(61,180,242)
# — sampled independently as the actual rendered color of an on-site link,
# confirming the token is live, not dead CSS. Top-to-bottom, light to dark,
# same 3-stop-from-a-real-scale rigor as tmdb-mcp's icon (which pulled its
# stops from TMDB's own gradient asset).
STOPS = [
    (0.0, (0x6F, 0xC8, 0xFF)),  # --color-blue-500
    (0.45, (0x3D, 0xB4, 0xF2)),  # --color-blue-600 / --color-blue (primary accent)
    (1.0, (0x0B, 0x46, 0x71)),  # --color-blue-900
]


def lerp_color(t, stops):
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t0 <= t <= t1 or i == len(stops) - 2:
            local_t = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            local_t = max(0.0, min(1.0, local_t))
            return tuple(round(c0[ch] + (c1[ch] - c0[ch]) * local_t) for ch in range(3))
    return stops[-1][1]


def main():
    w = h = SIZE * SCALE
    stroke = STROKE * SCALE
    verts = [(x * SCALE, y * SCALE) for x, y in VERTS]

    # alpha mask: filled polygon + a thick closed round-joined stroke along
    # its edges, plus a circle at each vertex (mirrors an SVG round linejoin).
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.polygon(verts, fill=255)
    d.line(verts + [verts[0]], fill=255, width=stroke, joint="curve")
    for x, y in verts:
        r = stroke / 2
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)

    # vertical gradient, scoped to the shape's own dilated bounding box —
    # matches the SVG gradient's default objectBoundingBox units (y1=0/y2=1
    # relative to the shape, not the full canvas).
    x0, y0, x1, y1 = mask.getbbox()
    grad = Image.new("RGB", (w, h))
    gpix = grad.load()
    span = max(1, y1 - y0)
    for y in range(y0, y1):
        col = lerp_color((y - y0) / span, STOPS)
        for x in range(x0, x1):
            gpix[x, y] = col

    big = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    big.paste(grad, (0, 0), mask)

    out = big.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(OUT)
    print(f"wrote {OUT} ({out.size[0]}x{out.size[1]}, mode={out.mode})")


if __name__ == "__main__":
    main()
