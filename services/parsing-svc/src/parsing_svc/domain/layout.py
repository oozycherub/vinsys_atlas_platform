"""LayoutDoc (PRD §2.1(b) stage 3) and the rules that work on it: hidden text, reading order."""

from __future__ import annotations

from dataclasses import dataclass, field

#: Font size at or below which text is treated as hidden (PRD §2.1(d)).
HIDDEN_FONT_SIZE = 2.0
#: Text this close to white (each channel ≥ 0xF0) is invisible on a white page.
NEAR_WHITE = 0xF0


@dataclass(frozen=True)
class Block:
    text: str
    bbox: tuple[float, float, float, float]  # x0, y0, x1, y1 (points, origin top-left)
    font_size: float = 11.0
    bold: bool = False
    color: int = 0x000000  # sRGB

    @property
    def x0(self) -> float:
        return self.bbox[0]

    @property
    def y0(self) -> float:
        return self.bbox[1]


@dataclass(frozen=True)
class Page:
    width: float
    height: float
    blocks: tuple[Block, ...]


@dataclass(frozen=True)
class LayoutDoc:
    pages: tuple[Page, ...]
    source: str  # pdf | docx | text | ocr
    ocr_confidence: float | None = None

    @property
    def char_count(self) -> int:
        return sum(len(b.text) for p in self.pages for b in p.blocks)

    def chars_per_page(self) -> float:
        return self.char_count / max(1, len(self.pages))


@dataclass
class HiddenReport:
    blocks: int = 0
    reasons: set[str] = field(default_factory=set)


def is_near_white(color: int) -> bool:
    r, g, b = (color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF
    return min(r, g, b) >= NEAR_WHITE


def hidden_reason(block: Block, page: Page) -> str | None:
    if block.font_size <= HIDDEN_FONT_SIZE:
        return 'tiny_font'
    if is_near_white(block.color):
        return 'white_text'
    x0, y0, x1, y1 = block.bbox
    if x1 <= 0 or y1 <= 0 or x0 >= page.width or y0 >= page.height:
        return 'off_page'
    return None


def drop_hidden(doc: LayoutDoc) -> tuple[LayoutDoc, HiddenReport]:
    """Hidden text is excluded from everything downstream, and reported (PRD §2.1(d))."""
    report = HiddenReport()
    pages = []
    for page in doc.pages:
        kept = []
        for block in page.blocks:
            reason = hidden_reason(block, page) if block.text.strip() else None
            if reason:
                report.blocks += 1
                report.reasons.add(reason)
            else:
                kept.append(block)
        pages.append(Page(page.width, page.height, tuple(kept)))
    return LayoutDoc(tuple(pages), doc.source, doc.ocr_confidence), report


def reading_order(blocks: tuple[Block, ...] | list[Block], page_width: float) -> list[Block]:
    """Multi-column reading order (an XY-cut variant).

    Finds the vertical channel that the fewest blocks cross (a gutter between columns). Blocks
    that do cross it (a name banner, a full-width contact line) separate horizontal bands;
    inside each band the left column is read before the right, each recursively. Pages without
    such a channel are read top to bottom, left to right.
    """
    items = list(blocks)
    channel = _channel(items, page_width)
    if channel is None:
        return sorted(items, key=lambda b: (round(b.y0, 1), b.x0))
    spanning = sorted((b for b in items if b.bbox[0] < channel < b.bbox[2]), key=lambda b: b.y0)
    rest = [b for b in items if not b.bbox[0] < channel < b.bbox[2]]
    out: list[Block] = []
    for separator in [*spanning, None]:
        limit = separator.y0 if separator else float('inf')
        band = [b for b in rest if b.y0 < limit]
        rest = [b for b in rest if b.y0 >= limit]
        left = [b for b in band if b.bbox[2] <= channel]
        right = [b for b in band if b.bbox[0] >= channel]
        out += reading_order(left, page_width) + reading_order(right, page_width)
        if separator:
            out.append(separator)
    return out


def _channel(items: list[Block], page_width: float) -> float | None:
    """The x of the emptiest vertical channel in the middle 60% of the page, if it really
    separates columns: at least 3 blocks each side and at most 10% of blocks crossing it."""
    if len(items) < 6:
        return None
    best: tuple[int, float] | None = None
    x = 0.2 * page_width
    while x <= 0.8 * page_width:
        left = sum(1 for b in items if b.bbox[2] <= x)
        right = sum(1 for b in items if b.bbox[0] >= x)
        if left >= 3 and right >= 3:
            crossing = sum(1 for b in items if b.bbox[0] < x < b.bbox[2])
            if best is None or crossing < best[0]:
                best = (crossing, x)
        x += 2.0
    if best is None or best[0] > max(1, len(items) // 10):
        return None
    return best[1]
