"""Malware scanning: clamd over TCP (INSTREAM), and a signature fallback for development.

The fallback knows only the EICAR test string. It exists so a developer machine without ClamAV
still exercises the quarantine path; production configures clamd and fails closed if it is down.
"""

from __future__ import annotations

import asyncio
import re
import struct

from parsing_svc.application.ports import UpstreamError

EICAR = rb'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
_FOUND = re.compile(rb'stream: (.+) FOUND')


class ClamdScanner:
    name = 'clamav'

    def __init__(
        self, host: str, port: int = 3310, timeout: float = 30.0, chunk: int = 64 * 1024
    ) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self.chunk = chunk

    async def scan(self, data: bytes) -> str | None:
        try:
            return await asyncio.wait_for(self._scan(data), self.timeout)
        except (OSError, TimeoutError) as error:
            raise UpstreamError(f'clamd: {type(error).__name__}') from error

    async def _scan(self, data: bytes) -> str | None:
        reader, writer = await asyncio.open_connection(self.host, self.port)
        try:
            writer.write(b'zINSTREAM\0')
            for start in range(0, len(data), self.chunk):
                part = data[start : start + self.chunk]
                writer.write(struct.pack('>I', len(part)) + part)
            writer.write(struct.pack('>I', 0))
            await writer.drain()
            reply = (await reader.read(4096)).rstrip(b'\0').strip()
        finally:
            writer.close()
            await writer.wait_closed()
        if reply.endswith(b'OK'):
            return None
        if found := _FOUND.search(reply):
            return found.group(1).decode(errors='replace')[:200]
        raise UpstreamError(f'clamd: unexpected reply {reply[:80]!r}')


class SignatureScanner:
    name = 'builtin-signatures'

    async def scan(self, data: bytes) -> str | None:
        return 'Eicar-Test-Signature' if EICAR in data else None
