"""Low-memory, rasterized PDF export for the address-areas report.

Goals (chosen for a 256MB fly.io VM):
  * Correct Marathi (Devanagari) shaping  -> Pillow built with RAQM (HarfBuzz).
  * Visible watermark baked into the pixels -> drawn straight onto each page.
  * No copyable / selectable text          -> pages are images, assembled with
                                              img2pdf; there is no text layer.

Memory strategy: render ONE page image at a time, flush it to a temp PNG on
disk, free it, then let img2pdf stitch the PNG files into a single PDF without
re-decoding them into RAM. Peak usage stays around a single page bitmap
(~7MB at 150 DPI), comfortably inside 256MB.
"""

import os
import math
import tempfile

import img2pdf
from PIL import Image, ImageDraw, ImageFont, features

try:  # optional: adds advisory permission flags on top of rasterization
    import pikepdf
    from pikepdf import Permissions, Encryption
except Exception:  # pragma: no cover - pikepdf is optional
    pikepdf = None


# --- page geometry (A4 landscape @ 150 DPI) --------------------------------
DPI = 150
PAGE_W = int(297 / 25.4 * DPI)   # ~1754 px
PAGE_H = int(210 / 25.4 * DPI)   # ~1240 px
MARGIN = 70

# --- fonts ------------------------------------------------------------------
# Candidate Devanagari-capable fonts. Noto is installed in the container;
# Nirmala UI / Mangal cover local Windows development.
_FONT_CANDIDATES = [
    os.getenv("SAMAJ_PDF_FONT"),
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
    "/usr/share/fonts/truetype/Noto/NotoSansDevanagari-Regular.ttf",
    r"C:\Windows\Fonts\Nirmala.ttf",
    r"C:\Windows\Fonts\Nirmala.ttc",
    r"C:\Windows\Fonts\mangal.ttf",
]
_BOLD_CANDIDATES = [
    os.getenv("SAMAJ_PDF_FONT_BOLD"),
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf",
    "/usr/share/fonts/truetype/Noto/NotoSansDevanagari-Bold.ttf",
    r"C:\Windows\Fonts\NirmalaB.ttf",
    r"C:\Windows\Fonts\Nirmala.ttc",
]

# Latin-capable fonts. The Noto Devanagari face has no Latin letters, so Latin
# text is drawn with a separate font (DejaVu / Noto Sans / Arial).
_LATIN_CANDIDATES = [
    os.getenv("SAMAJ_PDF_LATIN_FONT"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
]
_LATIN_BOLD_CANDIDATES = [
    os.getenv("SAMAJ_PDF_LATIN_FONT_BOLD"),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
]

_LAYOUT = (
    ImageFont.Layout.RAQM if features.check("raqm") else ImageFont.Layout.BASIC
)

_font_cache = {}


def _first_existing(paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None


_REGULAR_PATH = _first_existing(_FONT_CANDIDATES)
_BOLD_PATH = _first_existing(_BOLD_CANDIDATES) or _REGULAR_PATH
_LATIN_PATH = _first_existing(_LATIN_CANDIDATES)
_LATIN_BOLD_PATH = _first_existing(_LATIN_BOLD_CANDIDATES) or _LATIN_PATH


def raqm_available():
    return _LAYOUT == ImageFont.Layout.RAQM


def font_found():
    return _REGULAR_PATH is not None


def _font(size, bold=False):
    key = (size, bold)
    cached = _font_cache.get(key)
    if cached is not None:
        return cached
    path = _BOLD_PATH if bold else _REGULAR_PATH
    if path:
        font = ImageFont.truetype(path, size, layout_engine=_LAYOUT)
    else:  # last resort: glyphs will be missing for Marathi
        font = ImageFont.load_default()
    _font_cache[key] = font
    return font


_latin_cache = {}


def _latin_font(size, bold=False):
    key = (size, bold)
    cached = _latin_cache.get(key)
    if cached is not None:
        return cached
    path = _LATIN_BOLD_PATH if bold else _LATIN_PATH
    if path:
        font = ImageFont.truetype(path, size, layout_engine=_LAYOUT)
    else:  # no Latin font found -> fall back to the Devanagari face
        font = _font(size, bold)
    _latin_cache[key] = font
    return font


# --- mixed-script text (Latin + Devanagari in one string) -------------------
def _is_deva(ch):
    return "\u0900" <= ch <= "\u097F" or "\uA8E0" <= ch <= "\uA8FF"


def _segments(text):
    """Split text into (run, is_devanagari) segments. Neutral characters
    (digits, spaces, punctuation) stick to the current run to avoid splits."""
    segs = []
    cur = None
    buf = ""
    for ch in text:
        if _is_deva(ch):
            t = True
        elif ("a" <= ch <= "z") or ("A" <= ch <= "Z"):
            t = False
        else:
            t = cur if cur is not None else False
        if cur is None:
            cur, buf = t, ch
        elif t == cur:
            buf += ch
        else:
            segs.append((buf, cur))
            cur, buf = t, ch
    if buf:
        segs.append((buf, cur))
    return segs


def _mixed_len(draw, text, size, bold):
    latin_f, deva_f = _latin_font(size, bold), _font(size, bold)
    return sum(
        draw.textlength(b, font=(deva_f if d else latin_f))
        for b, d in _segments(text)
    )


def _mixed_draw(draw, x, y, text, size, bold, fill):
    latin_f, deva_f = _latin_font(size, bold), _font(size, bold)
    for b, d in _segments(text):
        f = deva_f if d else latin_f
        draw.text((x, y), b, font=f, fill=fill)
        x += draw.textlength(b, font=f)
    return x


# --- font sizes / spacing ---------------------------------------------------
TITLE_SIZE = 32
SUBTITLE_SIZE = 17
AREA_SIZE = 24
HEADER_SIZE = 17
BODY_SIZE = 16
LINE_GAP = 1.32
CELL_PAD_X = 10
CELL_PAD_Y = 8

INK = (28, 28, 30)
MUTED = (110, 110, 116)
HEADER_BG = (16, 110, 78)        # matches the app's green
HEADER_INK = (255, 255, 255)
AREA_INK = (16, 110, 78)
ROW_ALT = (244, 247, 245)
GRID = (214, 218, 216)

# Relative column widths by data key (addresses/names need more room).
_WEIGHTS = {
    "name": 1.6, "name_mr": 1.6,
    "address1_clean": 2.2, "address2_clean": 2.2,
    "address1_raw": 2.2, "address2_raw": 2.2,
    "address1_mr": 2.2, "address2_mr": 2.2,
    "mobile": 1.1, "district": 1.0, "taluka": 1.0,
    "state": 1.0, "surname": 1.2, "createdBy": 1.2,
    "members": 0.6,
}


def _line_h(size):
    return int(size * LINE_GAP)


def _wrap(draw, text, size, bold, max_w):
    """Greedy word-wrap; falls back to hard char-breaks for long tokens."""
    text = "" if text is None else str(text)
    if not text.strip():
        return [""]
    lines = []
    for raw_line in text.splitlines() or [""]:
        words = raw_line.split(" ")
        cur = ""
        for word in words:
            trial = word if not cur else cur + " " + word
            if _mixed_len(draw, trial, size, bold) <= max_w or not cur:
                # token itself may still be wider than the cell
                if _mixed_len(draw, trial, size, bold) > max_w and not cur:
                    lines.extend(_hard_break(draw, word, size, bold, max_w))
                    cur = ""
                else:
                    cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines or [""]


def _hard_break(draw, token, size, bold, max_w):
    out, cur = [], ""
    for ch in token:
        if _mixed_len(draw, cur + ch, size, bold) <= max_w or not cur:
            cur += ch
        else:
            out.append(cur)
            cur = ch
    if cur:
        out.append(cur)
    return out


def _column_widths(keys, usable_w):
    weights = [_WEIGHTS.get(k, 1.0) for k in keys]
    total = sum(weights) or 1.0
    widths = [int(usable_w * w / total) for w in weights]
    # absorb rounding drift into the last column
    widths[-1] += usable_w - sum(widths)
    return widths


# --- watermark --------------------------------------------------------------
def _load_watermark(path):
    if not path or not os.path.exists(path):
        return None
    try:
        img = Image.open(path).convert("RGBA")
    except Exception:
        return None
    # scale to a quarter of the page width so tiling looks balanced
    target_w = PAGE_W // 4
    if img.width != target_w:
        ratio = target_w / img.width
        img = img.resize((target_w, max(1, int(img.height * ratio))))
    return img


def _build_watermark_overlay(wm_img, wm_text):
    """Build the tiled/rotated watermark ONCE (it is identical on every page).

    Returns an RGBA overlay sized to the page, or None.
    """
    overlay = Image.new("RGBA", (PAGE_W, PAGE_H), (0, 0, 0, 0))

    if wm_img is not None:
        faded = wm_img.copy()
        alpha = faded.split()[3].point(lambda a: int(a * 0.06))
        faded.putalpha(alpha)
        tile = faded.rotate(30, expand=True)
        step_x = int(tile.width * 1.4)
        step_y = int(tile.height * 1.6)
        for y in range(-tile.height, PAGE_H + tile.height, step_y):
            for x in range(-tile.width, PAGE_W + tile.width, step_x):
                overlay.alpha_composite(tile, (x, y))
    elif wm_text:
        wm_font = _font(54, bold=True)
        text_layer = Image.new("RGBA", (PAGE_W, PAGE_H), (0, 0, 0, 0))
        d = ImageDraw.Draw(text_layer)
        bbox = d.textbbox((0, 0), wm_text, font=wm_font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        step_x, step_y = tw + 180, th + 170
        for y in range(0, PAGE_H + step_y, step_y):
            for x in range(0, PAGE_W + step_x, step_x):
                d.text((x, y), wm_text, font=wm_font, fill=(16, 110, 78, 22))
        overlay = text_layer.rotate(30, expand=False)
    else:
        return None

    return overlay


# --- layout planning --------------------------------------------------------
# A plan is a list of pages; each page is a list of draw ops carrying
# PRE-WRAPPED text, so the render pass never re-measures. Knowing the total
# page count up front lets us stamp "Page X of N" while rendering each page
# image exactly once (no second image pass).
CONTENT_BOTTOM = PAGE_H - MARGIN


def _title_height(subtitle):
    h = _line_h(TITLE_SIZE)
    if subtitle:
        h += _line_h(SUBTITLE_SIZE)
    return h + 12


def _plan_pages(headers, areas, widths, body_specs, title, subtitle):
    measure = ImageDraw.Draw(Image.new("RGB", (8, 8)))
    header_specs = [(HEADER_SIZE, True)] * len(headers)
    header_h, header_cells = _measure_row(measure, headers, header_specs, widths)
    area_h = _line_h(AREA_SIZE) + 6

    pages, cur = [], []
    y = MARGIN

    def new_page():
        nonlocal cur, y
        pages.append(cur)
        cur = []
        y = MARGIN

    cur.append(("title", title, subtitle))  # title only on the first page
    y += _title_height(subtitle)

    for area_name, families, rows in areas:
        first_h = (_measure_row(measure, rows[0], body_specs, widths)[0]
                   if rows else _line_h(BODY_SIZE))
        if (CONTENT_BOTTOM - y) < area_h + header_h + first_h:
            new_page()
        cur.append(("area", area_name, families, False))
        y += area_h
        cur.append(("header", header_cells, header_h))
        y += header_h

        alt = False
        for row in rows:
            h, cells = _measure_row(measure, row, body_specs, widths)
            if (CONTENT_BOTTOM - y) < h:
                new_page()
                cur.append(("area", area_name, families, True))
                y += area_h
                cur.append(("header", header_cells, header_h))
                y += header_h
                alt = False
            cur.append(("row", cells, h, alt))
            y += h
            alt = not alt
        y += 18  # gap after an area block

    pages.append(cur)
    return pages, header_specs


def _measure_row(draw, values, specs, widths):
    """Return (row_height, wrapped_cells). ``specs`` is a list of (size, bold)
    per column."""
    cells = []
    max_lines = 1
    max_size = BODY_SIZE
    for val, (size, bold), w in zip(values, specs, widths):
        lines = _wrap(draw, val, size, bold, w - 2 * CELL_PAD_X)
        cells.append(lines)
        max_lines = max(max_lines, len(lines))
        max_size = max(max_size, size)
    height = max_lines * _line_h(max_size) + 2 * CELL_PAD_Y
    return height, cells


def _paint_cells(draw, y, cells, specs, widths, height, ink):
    x = MARGIN
    for lines, (size, bold), w in zip(cells, specs, widths):
        lh = _line_h(size)
        ty = y + CELL_PAD_Y
        for ln in lines:
            _mixed_draw(draw, x + CELL_PAD_X, ty, ln, size, bold, ink)
            ty += lh
        x += w
    gx = MARGIN
    for w in widths:
        draw.line([gx, y, gx, y + height], fill=GRID, width=1)
        gx += w
    draw.line([gx, y, gx, y + height], fill=GRID, width=1)


def _render_op(draw, y, op, widths, body_specs, header_specs):
    kind = op[0]
    if kind == "title":
        _, title, subtitle = op
        _mixed_draw(draw, MARGIN, y, title, TITLE_SIZE, True, INK)
        y += _line_h(TITLE_SIZE)
        if subtitle:
            _mixed_draw(draw, MARGIN, y, subtitle, SUBTITLE_SIZE, False, MUTED)
            y += _line_h(SUBTITLE_SIZE)
        return y + 12
    if kind == "area":
        _, area, families, continued = op
        label = (area or "Unclassified") + ("  (continued)" if continued else "")
        _mixed_draw(draw, MARGIN, y, label, AREA_SIZE, True, AREA_INK)
        count = f"{families} families"
        cw = _mixed_len(draw, count, SUBTITLE_SIZE, False)
        _mixed_draw(draw, PAGE_W - MARGIN - cw, y + 6, count,
                    SUBTITLE_SIZE, False, MUTED)
        return y + _line_h(AREA_SIZE) + 6
    if kind == "header":
        _, cells, h = op
        draw.rectangle([MARGIN, y, PAGE_W - MARGIN, y + h], fill=HEADER_BG)
        _paint_cells(draw, y, cells, header_specs, widths, h, HEADER_INK)
        return y + h
    # data row
    _, cells, h, alt = op
    if alt:
        draw.rectangle([MARGIN, y, PAGE_W - MARGIN, y + h], fill=ROW_ALT)
    _paint_cells(draw, y, cells, body_specs, widths, h, INK)
    draw.line([MARGIN, y + h, PAGE_W - MARGIN, y + h], fill=GRID, width=1)
    return y + h


def _draw_footer(draw, page_no, total, label):
    fy = PAGE_H - MARGIN + 14
    draw.line(
        [MARGIN, PAGE_H - MARGIN + 4, PAGE_W - MARGIN, PAGE_H - MARGIN + 4],
        fill=GRID, width=1,
    )
    if label:
        _mixed_draw(draw, MARGIN, fy, label, SUBTITLE_SIZE, False, MUTED)
    text = f"Page {page_no} of {total}"
    tw = _mixed_len(draw, text, SUBTITLE_SIZE, False)
    _mixed_draw(draw, PAGE_W - MARGIN - tw, fy, text, SUBTITLE_SIZE, False, MUTED)


def render_address_pdf(headers, keys, areas, title, subtitle,
                       watermark_path=None, watermark_text="SAMAJ"):
    """Render the grouped report to a rasterized PDF (returns bytes).

    headers : list[str]   column labels (area excluded; it is a section head)
    keys    : list[str]   matching data keys, used for column-width weighting
    areas   : list[(area_name, families_count, rows)] where each row is a
              list[str] aligned to ``headers``.

    Strategy: plan the pagination once (wrapping text, no bitmaps) so the total
    page count is known, then render each page image exactly once with its
    footer. Peak memory stays around a single page bitmap.
    """
    widths = _column_widths(keys, PAGE_W - 2 * MARGIN)
    body_specs = [(BODY_SIZE, False)] * len(headers)

    pages, header_specs = _plan_pages(
        headers, areas, widths, body_specs, title, subtitle)
    total = len(pages)

    # Watermarked blank page built ONCE; each page is a fast in-memory copy.
    template = Image.new("RGB", (PAGE_W, PAGE_H), (255, 255, 255))
    overlay = _build_watermark_overlay(_load_watermark(watermark_path),
                                       watermark_text)
    if overlay is not None:
        template.paste(overlay, (0, 0), overlay)

    with tempfile.TemporaryDirectory() as tmpdir:
        paths = []
        for idx, page_ops in enumerate(pages, start=1):
            img = template.copy()
            draw = ImageDraw.Draw(img)
            y = MARGIN
            for op in page_ops:
                y = _render_op(draw, y, op, widths, body_specs, header_specs)
            _draw_footer(draw, idx, total, watermark_text)
            path = os.path.join(tmpdir, f"page-{idx:04d}.png")
            img.save(path, format="PNG", compress_level=1)
            img.close()
            paths.append(path)

        pdf_bytes = img2pdf.convert(
            paths,
            layout_fun=img2pdf.get_fixed_dpi_layout_fun((DPI, DPI)),
        )

    return _harden(pdf_bytes)


def _harden(pdf_bytes):
    """Optional advisory copy/modify restriction on top of rasterization."""
    if pikepdf is None:
        return pdf_bytes
    try:
        import io
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
            out = io.BytesIO()
            pdf.save(
                out,
                encryption=Encryption(
                    owner=os.getenv("SAMAJ_PDF_OWNER_PW", "samaj-export"),
                    user="",
                    allow=Permissions(
                        extract=False,
                        modify_annotation=False,
                        modify_assembly=False,
                        modify_form=False,
                        modify_other=False,
                        print_lowres=True,
                        print_highres=True,
                    ),
                ),
            )
            return out.getvalue()
    except Exception:
        return pdf_bytes  # never fail the export over hardening
