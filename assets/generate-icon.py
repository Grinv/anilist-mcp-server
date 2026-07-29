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

Keep the geometry/colors here in sync with icon-source.svg by hand if you
ever edit one — there's no automated link between the two.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "icon.png"

SIZE = 512
SCALE = 4  # supersample then downsample for anti-aliased edges (Pillow's
           # ImageDraw has no native AA)

# A generic "kawaii creature" head: round face + two pointed (cat/fox-like)
# ears (with a navy inner-ear accent for depth) + a navy belly highlight +
# simple dot eyes. Deliberately generic (no belly *markings*/pattern, no
# whiskers, no character-specific proportions) — evokes anime-mascot
# cuteness in general, not any one copyrighted character. Deliberately
# distinct from the sibling mal-mcp icon's round bear/mouse ears + flat
# single-tone color: here the ears are pointed and there's a second accent
# color, so the two read as different creatures even though both are
# anime-list trackers.
HEAD_CENTER = (256, 306)
HEAD_R = 148

# Each ear is a 3-point polygon, rounded at every vertex via a same-color
# thick closed stroke with a round join + a filled circle at each vertex —
# the same trick tmdb-mcp's icon uses, since PIL's ImageDraw has no native
# corner-radius on an arbitrary polygon. Bases sit well inside the head
# circle so the union has no visible seam.
EAR_TRIANGLES = [
    [(120, 232), (232, 176), (168, 96)],
    [(392, 232), (280, 176), (344, 96)],
]
EAR_STROKE = 56

# A smaller, nested navy triangle inside each ear — an inner-ear accent for
# depth, same rounding trick, thinner stroke.
INNER_EAR_TRIANGLES = [
    [(148, 214), (222, 178), (178, 128)],
    [(364, 214), (290, 178), (334, 128)],
]
INNER_EAR_STROKE = 26

BELLY_CENTER = (256, 378)
BELLY_RX, BELLY_RY = 84, 58

EYE_CENTERS = [(206, 296), (306, 296)]
EYE_R = 20

# Real AniList brand colors, pulled directly from their own official logo
# SVG (upload.wikimedia.org/wikipedia/commons/6/61/AniList_logo.svg) —
# verified live 2026-07-29, not guessed from memory. Used here as the
# GLYPH's own colors on a transparent canvas (per the MCPB icon spec's "PNG
# with transparency" requirement), not as a filled background tile like
# AniList's own real usage — this is an original creature shape, not their
# actual "A" lettermark.
CYAN = (0x02, 0xA9, 0xFF)
NAVY = (0x1E, 0x26, 0x30)
WHITE = (0xFE, 0xFE, 0xFE)


def draw_rounded_triangle(d, verts, stroke, fill):
    d.polygon(verts, fill=fill)
    d.line(verts + [verts[0]], fill=fill, width=stroke, joint="curve")
    for vx, vy in verts:
        r = stroke / 2
        d.ellipse([vx - r, vy - r, vx + r, vy + r], fill=fill)


def main():
    w = h = SIZE * SCALE
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    stroke = EAR_STROKE * SCALE
    for tri in EAR_TRIANGLES:
        verts = [(x * SCALE, y * SCALE) for x, y in tri]
        draw_rounded_triangle(d, verts, stroke, (*CYAN, 255))

    hx, hy = HEAD_CENTER[0] * SCALE, HEAD_CENTER[1] * SCALE
    hr = HEAD_R * SCALE
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=(*CYAN, 255))

    inner_stroke = INNER_EAR_STROKE * SCALE
    for tri in INNER_EAR_TRIANGLES:
        verts = [(x * SCALE, y * SCALE) for x, y in tri]
        draw_rounded_triangle(d, verts, inner_stroke, (*NAVY, 255))

    bx, by = BELLY_CENTER[0] * SCALE, BELLY_CENTER[1] * SCALE
    brx, bry = BELLY_RX * SCALE, BELLY_RY * SCALE
    d.ellipse([bx - brx, by - bry, bx + brx, by + bry], fill=(*NAVY, 255))

    er = EYE_R * SCALE
    for ex, ey in EYE_CENTERS:
        ex, ey = ex * SCALE, ey * SCALE
        d.ellipse([ex - er, ey - er, ex + er, ey + er], fill=(*WHITE, 255))

    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(OUT)
    print(f"wrote {OUT} ({out.size[0]}x{out.size[1]}, mode={out.mode})")


if __name__ == "__main__":
    main()
