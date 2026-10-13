# -*- coding: utf-8 -*-
"""生成 PWA 图标（无需外部素材）。用法: python tools/make_icons.py"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bottom, y / max(1, size - 1)))
    return img


def make_icon(size, radius_ratio=0.22, pad_ratio=0.0, glyph="墨"):
    """pad_ratio: 内容安全区留白（maskable 图标需要 ~0.18）"""
    ss = 4  # 超采样，边缘更平滑
    S = size * ss
    base = gradient(S, (30, 27, 75), (109, 40, 217)).convert("RGBA")

    # 径向高光
    glow = Image.new("L", (S, S), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-S * 0.25, -S * 0.55, S * 0.95, S * 0.45], fill=90)
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.16))
    base = Image.composite(Image.new("RGBA", (S, S), (167, 139, 250, 255)), base, glow)

    # 底部淡淡墨痕
    ink = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    idr = ImageDraw.Draw(ink)
    idr.ellipse([-S * 0.1, S * 0.62, S * 1.1, S * 1.25], fill=(15, 12, 45, 150))
    ink = ink.filter(ImageFilter.GaussianBlur(S * 0.05))
    base = Image.alpha_composite(base, ink)

    # 字体
    box = S * (1 - 2 * pad_ratio)
    font = load_font(int(box * 0.72))
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    try:
        l, t, r, b = ld.textbbox((0, 0), glyph, font=font)
        tw, th = r - l, b - t
    except Exception:
        tw, th, l, t = font.getsize(glyph)
    x = (S - tw) / 2 - l
    y = (S - th) / 2 - t - S * 0.01
    # 阴影
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((x, y + S * 0.012), glyph, font=font, fill=(20, 12, 50, 170))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.012))
    layer = Image.alpha_composite(layer, shadow)
    ImageDraw.Draw(layer).text((x, y), glyph, font=font, fill=(255, 255, 255, 255))
    base = Image.alpha_composite(base, layer)

    img = base.resize((size, size), Image.LANCZOS)

    # 圆角
    if radius_ratio > 0:
        mask = Image.new("L", (size * ss, size * ss), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, size * ss - 1, size * ss - 1], radius=int(size * ss * radius_ratio), fill=255
        )
        mask = mask.resize((size, size), Image.LANCZOS)
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        img = out
    return img


def main():
    make_icon(192, 0.22).save(os.path.join(OUT, "icon-192.png"))
    make_icon(512, 0.22).save(os.path.join(OUT, "icon-512.png"))
    make_icon(512, 0.0, 0.19).save(os.path.join(OUT, "icon-maskable-512.png"))
    make_icon(180, 0.0).save(os.path.join(OUT, "apple-touch-icon.png"))
    make_icon(64, 0.18).save(os.path.join(OUT, "favicon-64.png"))
    make_icon(32, 0.18).save(os.path.join(OUT, "favicon-32.png"))
    print("icons written to", OUT)
    for f in sorted(os.listdir(OUT)):
        print(" -", f, os.path.getsize(os.path.join(OUT, f)), "bytes")


if __name__ == "__main__":
    main()
