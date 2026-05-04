"""Generate uPEG OTC Lens extension icons by overlaying a magnifier on the logo."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "logo-source.png"
OUT_DIR = ROOT / "icons"
OUT_DIR.mkdir(exist_ok=True)

WORK = 1024
SIZES = [16, 48, 128]

# Magnifier geometry (in WORK px)
LENS_CX, LENS_CY = 720, 740
LENS_OUTER = 235
LENS_INNER = 195
HANDLE_W = 70
HANDLE_LEN = 200

NAVY = (15, 23, 42, 255)        # ring + handle fill
WHITE = (255, 255, 255, 255)    # outline
LENS_TINT = (255, 255, 255, 70) # subtle highlight inside the glass


def build_master() -> Image.Image:
    base = Image.open(SRC).convert("RGBA").resize((WORK, WORK), Image.LANCZOS)

    # Layer for the magnifier (separate so we can soft-shadow it)
    mag = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
    d = ImageDraw.Draw(mag)

    # Handle: thick line from lens edge toward bottom-right
    angle_dx, angle_dy = 0.6, 0.8  # roughly 53° from horizontal
    handle_start = (
        LENS_CX + int(LENS_OUTER * angle_dx),
        LENS_CY + int(LENS_OUTER * angle_dy),
    )
    handle_end = (
        handle_start[0] + int(HANDLE_LEN * angle_dx),
        handle_start[1] + int(HANDLE_LEN * angle_dy),
    )
    # White outline (drawn first, wider)
    d.line([handle_start, handle_end], fill=WHITE, width=HANDLE_W + 28)
    # Navy core
    d.line([handle_start, handle_end], fill=NAVY, width=HANDLE_W)

    # Lens ring: outer white outline, navy band, inner transparent
    # White outer
    d.ellipse(
        [LENS_CX - LENS_OUTER - 14, LENS_CY - LENS_OUTER - 14,
         LENS_CX + LENS_OUTER + 14, LENS_CY + LENS_OUTER + 14],
        fill=WHITE,
    )
    # Navy ring
    d.ellipse(
        [LENS_CX - LENS_OUTER, LENS_CY - LENS_OUTER,
         LENS_CX + LENS_OUTER, LENS_CY + LENS_OUTER],
        fill=NAVY,
    )
    # Punch out interior so logo shows through
    cutout = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cutout)
    cd.ellipse(
        [LENS_CX - LENS_INNER, LENS_CY - LENS_INNER,
         LENS_CX + LENS_INNER, LENS_CY + LENS_INNER],
        fill=(0, 0, 0, 255),
    )
    # Use cutout alpha to clear the mag layer interior
    mag_arr = mag.copy()
    cutout_alpha = cutout.split()[3]
    transparent = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
    mag = Image.composite(transparent, mag_arr, cutout_alpha)

    # Subtle tint inside the lens (so it reads as "glass" not just a hole)
    tint = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
    td = ImageDraw.Draw(tint)
    td.ellipse(
        [LENS_CX - LENS_INNER, LENS_CY - LENS_INNER,
         LENS_CX + LENS_INNER, LENS_CY + LENS_INNER],
        fill=LENS_TINT,
    )
    # Small specular highlight
    td.ellipse(
        [LENS_CX - 130, LENS_CY - 150, LENS_CX - 30, LENS_CY - 70],
        fill=(255, 255, 255, 110),
    )

    # Drop shadow under the magnifier
    shadow = Image.new("RGBA", (WORK, WORK), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse(
        [LENS_CX - LENS_OUTER - 6, LENS_CY - LENS_OUTER + 10,
         LENS_CX + LENS_OUTER + 6, LENS_CY + LENS_OUTER + 22],
        fill=(0, 0, 0, 110),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))

    out = Image.alpha_composite(base, shadow)
    out = Image.alpha_composite(out, tint)
    out = Image.alpha_composite(out, mag)
    return out


def main() -> None:
    master = build_master()
    master.save(OUT_DIR / "icon-master.png")
    for s in SIZES:
        # For very small sizes, pre-blur slightly to avoid aliasing on the ring
        img = master
        if s <= 32:
            img = img.filter(ImageFilter.GaussianBlur(0.6))
        img.resize((s, s), Image.LANCZOS).save(OUT_DIR / f"icon-{s}.png")
        print(f"wrote icons/icon-{s}.png")


if __name__ == "__main__":
    main()
