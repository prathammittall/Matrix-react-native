"""Generate the MATRIX app icon set.

The mark is the product in one glyph: a navigation arrow with a trail behind it
that starts SOLID and becomes DASHED. Solid is the GNSS track, dashed is the AI
dead-reckoning estimate -- the same two line styles the map uses, so the icon
and the app say the same thing. Black ground, white mark, matching the app's
monochrome theme.

Constraints this is drawn to:

* It has to survive 48 px. Anything with fine detail turns to mush in a launcher
  grid, so the arrow is a single bold chevron and the trail is three dashes, not
  a delicate curve.
* Android masks adaptive icons to a circle, squircle or whatever the OEM feels
  like, and animates them with a parallax that crops further. The foreground
  layer therefore keeps everything inside the centre 66 % safe zone.
* Everything is drawn at 4x and downsampled, because PIL has no antialiasing on
  primitives.

Regenerate:
    python mobile/scripts/make-icons.py
"""
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets", "images")

SIZE = 1024
SS = 4  # supersample factor
BLACK = (0, 0, 0, 255)
WHITE = (255, 255, 255, 255)

# Adaptive-icon safe zone: Android may crop to the centre 66 %.
SAFE = 0.66


# ---------------------------------------------------------------- geometry
#
# The mark is defined ONCE, in its own coordinate system: +y is up, the axis of
# travel is vertical, the arrow is above and the trail below. It is then rotated
# as a single rigid body and fitted to the canvas by its real bounding box.
#
# Composing it any other way -- rotating the arrow by one angle and the trail by
# another, positioning both by eye -- is how the first attempt ended up with the
# two halves pointing in different directions, a gap where they should meet, and
# the whole mark sitting low and right of centre.

TILT = -32.0  # degrees; leans the mark so it reads as motion, not as a pin

STROKE = 0.19  # trail width, in axis units

# Trail segments as (start, end) along the axis, tail first.
#
# The gaps must be read NET OF THE ROUND CAPS, which extend every segment by
# STROKE/2 at each end. A nominal 0.30 gap is therefore a 0.13 visible one. Set
# the gaps by their nominal value and the dashes merge back into a single solid
# stick at launcher size -- which destroys the one distinction the mark exists
# to draw.
TRAIL = [
    (-1.25, -0.80),  # GNSS: one continuous stroke
    (-0.50, -0.32),  # AI dead reckoning: dashes, as on the map
    (-0.02, 0.16),
]

# A concave chevron, not a triangle: the notch is what makes it read as a
# heading indicator rather than a generic wedge.
ARROW = [
    (0.00, 1.30),    # tip
    (0.48, 0.40),    # right wing
    (0.00, 0.68),    # notch
    (-0.48, 0.40),   # left wing
]


def rotated(points, deg):
    r = math.radians(deg)
    cos, sin = math.cos(r), math.sin(r)
    return [(x * cos - y * sin, x * sin + y * cos) for x, y in points]


def draw_mark(draw, size, scale, colour=WHITE):
    """The MATRIX glyph, optically centred, fitted to `scale` of `size`."""
    segments = [rotated([(0.0, a), (0.0, b)], TILT) for a, b in TRAIL]
    arrow = rotated(ARROW, TILT)

    # Fit by the bounding box of everything actually drawn, including the half
    # stroke width the round caps add, so nothing is clipped and the mark is
    # centred on what you see rather than on its nominal origin.
    pts = arrow + [p for seg in segments for p in seg]
    pad = STROKE / 2
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x0, x1 = min(xs) - pad, max(xs) + pad
    y0, y1 = min(ys) - pad, max(ys) + pad

    k = (size * scale) / max(x1 - x0, y1 - y0)
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    half = size / 2

    def place(p):
        # +y is up in mark space, down in image space
        return (half + (p[0] - mx) * k, half - (p[1] - my) * k)

    width = max(1, int(STROKE * k))
    for a, b in segments:
        pa, pb = place(a), place(b)
        draw.line([pa, pb], fill=colour, width=width)
        for px, py in (pa, pb):  # PIL line caps are square; round them
            r = width / 2
            draw.ellipse([px - r, py - r, px + r, py + r], fill=colour)

    draw.polygon([place(p) for p in arrow], fill=colour)


def render(size, scale, background, colour=WHITE):
    """One icon layer. `background` may be None for transparency."""
    big = size * SS
    img = Image.new("RGBA", (big, big), background if background else (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_mark(draw, big, scale, colour)
    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, "PNG")
    print("%-34s %5d x %-5d %6.1f KB" % (name, img.width, img.height,
                                         os.path.getsize(path) / 1024))


def main():
    os.makedirs(OUT, exist_ok=True)

    # Square icon: the mark can run larger because nothing crops it.
    save(render(SIZE, 0.70, BLACK), "icon.png")

    # Adaptive icon. The foreground is transparent and stays inside the safe
    # zone -- 0.60 of the safe zone, not of the canvas, or the launcher's
    # circular mask clips the arrow tip.
    save(render(SIZE, 0.70 * SAFE, None), "android-icon-foreground.png")
    save(Image.new("RGBA", (SIZE, SIZE), BLACK), "android-icon-background.png")

    # Themed icons (Android 13+) are recoloured by the system from the alpha
    # channel, so this is the same silhouette on transparency.
    save(render(SIZE, 0.70 * SAFE, None), "android-icon-monochrome.png")

    # Splash: drawn on transparency so it sits on the splash background colour.
    save(render(SIZE, 0.72, None), "splash-icon.png")

    save(render(48, 0.62, BLACK), "favicon.png")

    # A legibility check at launcher size, so a regression is visible in review
    # rather than on a phone.
    preview = Image.new("RGBA", (SIZE, 240), (24, 24, 24, 255))
    x = 24
    for px in (192, 128, 96, 64, 48, 36):
        thumb = render(SIZE, 0.70, BLACK).resize((px, px), Image.LANCZOS)
        preview.paste(thumb, (x, (240 - px) // 2), thumb)
        x += px + 24
    save(preview, "icon-size-check.png")


if __name__ == "__main__":
    main()
