"""Security gate rules that need no external tools: content sniffing (never trust the declared
type) and archive limits (zip bombs, macros, encrypted Office files)."""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

from parsing_svc.domain.errors import PipelineError, malicious

PDF = 'application/pdf'
DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
DOC = 'application/msword'
PNG = 'image/png'
JPEG = 'image/jpeg'
TEXT = 'text/plain'
ZIP = 'application/zip'
OLE = 'application/x-ole-storage'

MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
#: PRD §2.1(b) stage 2: DOCX uncompressed ≤ 50 MB, ≤ 2,000 entries.
MAX_DOCX_UNCOMPRESSED = 50 * 1024 * 1024
MAX_DOCX_ENTRIES = 2000
#: A single entry expanding more than this is treated as a bomb whatever the totals say.
MAX_COMPRESSION_RATIO = 200

_OLE_MAGIC = bytes.fromhex('D0CF11E0A1B11AE1')


def sniff(data: bytes) -> str | None:
    """The real type from the bytes; None when it is none of the accepted types."""
    head = data[:1024]
    if b'%PDF-' in head:
        return PDF
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return PNG
    if data.startswith(b'\xff\xd8\xff'):
        return JPEG
    if data.startswith(_OLE_MAGIC):
        return OLE
    if data.startswith(b'PK\x03\x04'):
        return ZIP
    if _looks_like_text(data):
        return TEXT
    return None


def _looks_like_text(data: bytes) -> bool:
    if not data or b'\x00' in data[:4096]:
        return False
    try:
        sample = data[:8192].decode('utf-8')
    except UnicodeDecodeError as error:
        if error.start < 8188:  # a multi-byte character cut at the sample edge is fine
            return False
        sample = data[: error.start].decode('utf-8')
    printable = sum(ch.isprintable() or ch in '\r\n\t' for ch in sample)
    return printable / max(1, len(sample)) > 0.95


@dataclass(frozen=True)
class ArchiveReport:
    entries: int
    uncompressed: int


def inspect_docx(data: bytes) -> ArchiveReport:
    """Zip-bomb guard and structure check for a DOCX. Raises PipelineError."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except zipfile.BadZipFile as error:
        raise PipelineError('UNREADABLE_DOCUMENT', 'The DOCX archive is corrupt.') from error
    if len(infos) > MAX_DOCX_ENTRIES:
        raise malicious('zip_bomb', f'{len(infos)} archive entries (limit {MAX_DOCX_ENTRIES}).')
    total = 0
    for info in infos:
        total += info.file_size
        if (
            info.compress_size
            and info.file_size / info.compress_size > MAX_COMPRESSION_RATIO
            and info.file_size > 1_000_000
        ):
            raise malicious('zip_bomb', 'An archive entry has an extreme compression ratio.')
    if total > MAX_DOCX_UNCOMPRESSED:
        raise malicious('zip_bomb', f'Uncompressed size {total} bytes exceeds the limit.')
    names = {i.filename for i in infos}
    if any(n.lower().endswith('vbaproject.bin') for n in names):
        raise malicious('active_content', 'The document contains macros.')
    if '[Content_Types].xml' not in names or 'word/document.xml' not in names:
        raise malicious('mime_mismatch', 'A ZIP archive that is not a Word document.')
    return ArchiveReport(len(infos), total)


def classify_ole(data: bytes) -> None:
    """OLE containers are either password-protected OOXML or legacy binary .doc. Raises."""
    if 'EncryptedPackage'.encode('utf-16-le') in data or b'EncryptedPackage' in data:
        raise PipelineError('ENCRYPTED_DOCUMENT', 'The document is password-protected.')
    raise PipelineError(
        'UNSUPPORTED_DOCUMENT', 'Legacy binary .doc files are not supported; upload PDF or DOCX.'
    )


def check_declared(declared: str, actual: str | None) -> str:
    """Resolves the type to parse. A mismatch between what was declared and what the bytes are
    is a quarantine: profile-svc sniffs too, so this means the object changed after upload."""
    if actual is None:
        raise malicious('mime_mismatch', 'The content is not an accepted document type.')
    if actual == ZIP:
        actual = DOCX if declared == DOCX else ZIP
    if actual == OLE and declared in (DOC, DOCX):
        return OLE
    if actual != declared and not (declared == DOC and actual == OLE):
        if actual == ZIP:
            raise malicious('mime_mismatch', 'A ZIP archive was uploaded as a document.')
        raise malicious('mime_mismatch', f'Declared {declared} but the content is {actual}.')
    return actual
