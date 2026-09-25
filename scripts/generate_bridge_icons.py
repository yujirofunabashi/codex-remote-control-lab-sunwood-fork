"""Draw the Home Screen icons in public/bridge-icons/.

Two things have to read at a glance on a phone's Home Screen, so each is carried
by a different channel:

- the Mac (or PC) is the background colour and the big name: Air blue, mini
  amber, mini2 violet, Windows green - the same hues the app uses for machine
  labels and notifications;
- the AI is the tile in the middle and the pill below it: Codex a black
  terminal tile, Claude a white speech bubble.

Black against white stays distinct on every background, and no background
shares a hue with either tile. Run with `python3 scripts/generate_bridge_icons.py`
on macOS (it uses the system SF fonts); Pillow is the only dependency.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "bridge-icons"
ROUNDED = "/System/Library/Fonts/SFNSRounded.ttf"
MONO = "/System/Library/Fonts/SFNSMono.ttf"
SIZE = 1024

MACHINES = {
    "air": {"name": "AIR", "top": (59, 130, 246), "bottom": (23, 50, 140)},
    "mini": {"name": "MINI", "top": (245, 158, 11), "bottom": (146, 64, 14)},
    "mini2": {"name": "MINI 2", "top": (139, 92, 246), "bottom": (76, 29, 149)},
    "windows": {"name": "WINDOWS", "top": (34, 170, 90), "bottom": (20, 83, 45)},
}

PROVIDERS = {
    "codex": {"label": "CODEX", "pill": (12, 15, 23), "pill_text": (255, 255, 255)},
    "claude": {"label": "CLAUDE", "pill": (255, 247, 237), "pill_text": (194, 65, 12)},
}


def font(path, size, weight):
    face = ImageFont.truetype(path, size)
    face.set_variation_by_name(weight)
    return face


def fitted(path, text, weight, max_width, start):
    size = start
    while size > 20:
        face = font(path, size, weight)
        left, _, right, _ = face.getbbox(text)
        if right - left <= max_width:
            return face
        size -= 4
    return font(path, size, weight)


def gradient(top, bottom):
    image = Image.new("RGB", (SIZE, SIZE))
    draw = ImageDraw.Draw(image)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        draw.line([(0, y), (SIZE, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    # A soft light from the top left keeps a flat fill from looking like a placeholder.
    glow = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(glow).ellipse((-300, -380, 760, 560), fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    return Image.composite(Image.new("RGB", (SIZE, SIZE), (255, 255, 255)), image, glow)


def shadowed(canvas, shape_draw, blur=28, offset=(0, 18), alpha=110):
    shadow = Image.new("L", (SIZE, SIZE), 0)
    shape_draw(ImageDraw.Draw(shadow), 255)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    layer.putalpha(shadow.point(lambda v: v * alpha // 255))
    canvas.alpha_composite(layer, offset)


def codex_tile(canvas):
    box = (222, 150, 802, 540)
    shadowed(canvas, lambda d, fill: d.rounded_rectangle(box, 70, fill=fill))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(box, 70, fill=(12, 15, 23, 255), outline=(255, 255, 255, 70), width=8)
    # Window controls, so the tile reads as a terminal rather than a black box.
    for i, colour in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
        cx = 290 + i * 48
        draw.ellipse((cx - 15, 200, cx + 15, 230), fill=colour + (255,))
    mono = font(MONO, 200, "Heavy")
    draw.text((330, 372), ">", font=mono, fill=(255, 255, 255, 255), anchor="lm")
    draw.rounded_rectangle((500, 425, 680, 462), 12, fill=(52, 211, 153, 255))


def claude_tile(canvas):
    body = (212, 150, 812, 510)
    tail = [(330, 490), (300, 600), (440, 500)]

    def shape(d, fill):
        d.rounded_rectangle(body, 110, fill=fill)
        d.polygon(tail, fill=fill)

    shadowed(canvas, shape)
    draw = ImageDraw.Draw(canvas)
    shape(draw, (255, 247, 237, 255))
    for cx in (382, 512, 642):
        draw.ellipse((cx - 44, 330 - 44, cx + 44, 330 + 44), fill=(217, 119, 87, 255))


def icon(machine, provider):
    spec, look = MACHINES[machine], PROVIDERS[provider]
    canvas = gradient(spec["top"], spec["bottom"]).convert("RGBA")
    (codex_tile if provider == "codex" else claude_tile)(canvas)

    name_font = fitted(ROUNDED, spec["name"], "Black", 840, 250)
    shadowed(canvas, lambda d, fill: d.text((512, 735), spec["name"], font=name_font, fill=fill, anchor="mm"), blur=14, offset=(0, 8), alpha=120)
    draw = ImageDraw.Draw(canvas)
    draw.text((512, 735), spec["name"], font=name_font, fill=(255, 255, 255, 255), anchor="mm")

    pill_font = font(ROUNDED, 96, "Heavy")
    left, top, right, bottom = pill_font.getbbox(look["label"], anchor="mm")
    width = right - left + 150
    pill = (512 - width // 2, 868, 512 + width // 2, 978)
    shadowed(canvas, lambda d, fill: d.rounded_rectangle(pill, 55, fill=fill), blur=16, offset=(0, 8), alpha=90)
    draw.rounded_rectangle(pill, 55, fill=look["pill"] + (255,))
    draw.text((512, 925), look["label"], font=pill_font, fill=look["pill_text"] + (255,), anchor="mm")
    return canvas.convert("RGB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for machine in MACHINES:
        for provider in PROVIDERS:
            master = icon(machine, provider)
            for size in (512, 180):
                path = OUT / f"{provider}-{machine}-{size}.png"
                master.resize((size, size), Image.LANCZOS).save(path, optimize=True)
                print(path.relative_to(ROOT))


if __name__ == "__main__":
    main()
