"""PaddleOCR (multilingual) for scanned résumés. Installed only in the OCR worker image (its
dependency pins conflict with the rest of the stack), so it is imported lazily."""

from __future__ import annotations

import asyncio
import io
from typing import Any

from parsing_svc.domain.layout import Block, LayoutDoc, Page
from parsing_svc.domain.sniff import PDF


class PaddleOcrEngine:  # pragma: no cover - needs the OCR worker image
    def __init__(self, lang: str = 'en') -> None:
        from paddleocr import PaddleOCR

        self._ocr: Any = PaddleOCR(lang=lang, use_textline_orientation=True)

    def _images(self, mime: str, data: bytes) -> list[Any]:
        import numpy as np
        import pymupdf
        from PIL import Image

        if mime == PDF:
            images = []
            with pymupdf.open(stream=data, filetype='pdf') as doc:
                for page in doc:
                    pix = page.get_pixmap(dpi=200)
                    images.append(
                        np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
                    )
            return images
        return [np.array(Image.open(io.BytesIO(data)).convert('RGB'))]

    def _run(self, mime: str, data: bytes) -> LayoutDoc:
        pages, scores = [], []
        for image in self._images(mime, data):
            height, width = image.shape[:2]
            blocks = []
            for result in self._ocr.predict(image):
                for text, score, box in zip(
                    result['rec_texts'], result['rec_scores'], result['rec_boxes'], strict=False
                ):
                    x0, y0, x1, y1 = (float(v) for v in box)
                    blocks.append(
                        Block(text, (x0, y0, x1, y1), font_size=max(3.0, (y1 - y0) * 0.75))
                    )
                    scores.append(float(score))
            pages.append(Page(float(width), float(height), tuple(blocks)))
        confidence = sum(scores) / len(scores) if scores else 0.0
        return LayoutDoc(tuple(pages), 'ocr', confidence)

    async def ocr(self, mime: str, data: bytes) -> LayoutDoc:
        return await asyncio.to_thread(self._run, mime, data)
