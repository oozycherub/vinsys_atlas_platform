"""JSON logs to stdout, one object per line, with `extra` fields merged in."""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any


class JsonFormatter(logging.Formatter):
    _std = set(logging.makeLogRecord({}).__dict__) | {'message', 'asctime'}

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            'time': datetime.fromtimestamp(record.created, UTC).isoformat(),
            'level': record.levelname.lower(),
            'service': self.service,
            'msg': record.getMessage(),
        }
        out.update({k: v for k, v in record.__dict__.items() if k not in self._std})
        if record.exc_info:
            out['exc'] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def configure_logging(service: str, level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    logging.basicConfig(level=level, handlers=[handler], force=True)
