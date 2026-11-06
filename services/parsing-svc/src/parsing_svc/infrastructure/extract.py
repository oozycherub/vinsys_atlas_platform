"""Text and layout extraction: PyMuPDF (blocks with bbox, font size, colour), pdfplumber as a
fallback, python-docx (paragraphs and tables), plain text; pikepdf (qpdf) to sanitise PDFs."""

from __future__ import annotations

import io
import logging

from parsing_svc.domain.errors import PipelineError
from parsing_svc.domain.layout import Block, LayoutDoc, Page
from parsing_svc.domain.sniff import DOCX, PDF, TEXT

log = logging.getLogger('parsing_svc')

#: A4 at 72 dpi; DOCX and text have no geometry, so they get one synthetic page per ~60 lines.
A4 = (595.0, 842.0)


class DocumentExtractor:
    def sanitize_pdf(self, data: bytes) -> bytes:
        """qpdf (through pikepdf): refuse encrypted files, drop JavaScript, actions and embedded
        files, and re-serialise, so the extractors never see the original byte stream."""
        import pikepdf

        try:
            pdf = pikepdf.open(io.BytesIO(data))
        except pikepdf.PasswordError as error:
            raise PipelineError('ENCRYPTED_DOCUMENT', 'The PDF is password-protected.') from error
        except pikepdf.PdfError as error:
            raise PipelineError('UNREADABLE_DOCUMENT', 'The PDF is corrupt.') from error
        with pdf:
            if pdf.is_encrypted:
                raise PipelineError('ENCRYPTED_DOCUMENT', 'The PDF is encrypted.')
            root = pdf.Root
            for key in ('/OpenAction', '/AA', '/AcroForm'):
                if key in root:
                    del root[key]
            names = root.get('/Names')
            if names is not None:
                for key in ('/JavaScript', '/EmbeddedFiles'):
                    if key in names:
                        del names[key]
            for page in pdf.pages:
                if '/AA' in page.obj:
                    del page.obj['/AA']
                annots = page.obj.get('/Annots')
                if annots is not None:
                    kept = [
                        a for a in annots if a.get('/Subtype') not in ('/FileAttachment', '/Screen')
                    ]
                    page.obj['/Annots'] = pikepdf.Array(kept)
            out = io.BytesIO()
            pdf.save(out)
        return out.getvalue()

    def extract(self, mime: str, data: bytes) -> LayoutDoc:
        if mime == PDF:
            try:
                return _pdf_pymupdf(data)
            except PipelineError:
                raise
            except Exception:  # noqa: BLE001 - a parser crash on hostile input: try the fallback
                log.warning('pymupdf failed; trying pdfplumber')
                return _pdf_plumber(data)
        if mime == DOCX:
            return _docx(data)
        if mime == TEXT:
            return _text(data.decode('utf-8', errors='replace'), 'text')
        raise PipelineError('UNSUPPORTED_DOCUMENT', f'No extractor for {mime}.')


def _pdf_pymupdf(data: bytes) -> LayoutDoc:
    import pymupdf

    try:
        doc = pymupdf.open(stream=data, filetype='pdf')
    except Exception as error:
        raise PipelineError('UNREADABLE_DOCUMENT', 'The PDF cannot be opened.') from error
    with doc:
        if doc.needs_pass:
            raise PipelineError('ENCRYPTED_DOCUMENT', 'The PDF is password-protected.')
        pages = []
        for page in doc:
            blocks = []
            for b in page.get_text('dict')['blocks']:
                if b.get('type') != 0:
                    continue
                for line in b['lines']:
                    spans = [s for s in line['spans'] if s['text'].strip()]
                    if not spans:
                        continue
                    text = ''.join(s['text'] for s in line['spans']).strip()
                    main = max(spans, key=lambda s: len(s['text']))
                    blocks.append(
                        Block(
                            text=text,
                            bbox=tuple(line['bbox']),
                            font_size=float(main['size']),
                            bold=bool(main['flags'] & 16),
                            color=int(main['color']),
                        )
                    )
            pages.append(Page(float(page.rect.width), float(page.rect.height), tuple(blocks)))
    return LayoutDoc(tuple(pages), 'pdf')


def _pdf_plumber(data: bytes) -> LayoutDoc:
    import pdfplumber

    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            pages = []
            for page in pdf.pages:
                lines = (page.extract_text() or '').splitlines()
                blocks = tuple(
                    Block(line, (36.0, 36.0 + 14 * n, page.width - 36.0, 48.0 + 14 * n))
                    for n, line in enumerate(lines)
                    if line.strip()
                )
                pages.append(Page(float(page.width), float(page.height), blocks))
    except Exception as error:
        raise PipelineError('UNREADABLE_DOCUMENT', 'The PDF cannot be read.') from error
    return LayoutDoc(tuple(pages), 'pdf')


def _docx(data: bytes) -> LayoutDoc:
    import docx

    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as error:
        raise PipelineError('UNREADABLE_DOCUMENT', 'The DOCX cannot be read.') from error
    lines: list[tuple[str, float, bool, int]] = []

    def run_style(paragraph: object) -> tuple[float, bool, int]:
        size, bold, color = 11.0, False, 0
        for run in getattr(paragraph, 'runs', []):
            if not run.text.strip():
                continue
            if run.font.size is not None:
                size = run.font.size.pt
            bold = bold or bool(run.bold)
            rgb = (
                run.font.color.rgb
                if run.font.color is not None and run.font.color.type is not None
                else None
            )
            if rgb is not None:
                color = int(str(rgb), 16)
            break
        return size, bold, color

    for paragraph in document.paragraphs:
        if paragraph.text.strip():
            size, bold, color = run_style(paragraph)
            if paragraph.style is not None and paragraph.style.name.lower().startswith('heading'):
                bold = True
            lines.append((paragraph.text, size, bold, color))
    for table in document.tables:  # résumé templates often lay sections out in tables
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    if paragraph.text.strip():
                        size, bold, color = run_style(paragraph)
                        lines.append((paragraph.text, size, bold, color))
    return _paginate(lines, 'docx')


def _text(content: str, source: str) -> LayoutDoc:
    return _paginate(
        [(line, 11.0, False, 0) for line in content.splitlines() if line.strip()], source
    )


def _paginate(lines: list[tuple[str, float, bool, int]], source: str) -> LayoutDoc:
    pages = []
    for start in range(0, max(1, len(lines)), 60):
        chunk = lines[start : start + 60]
        blocks = tuple(
            Block(text, (36.0, 36.0 + 13 * n, A4[0] - 36.0, 49.0 + 13 * n), size, bold, color)
            for n, (text, size, bold, color) in enumerate(chunk)
        )
        pages.append(Page(A4[0], A4[1], blocks))
    return LayoutDoc(tuple(pages), source)
