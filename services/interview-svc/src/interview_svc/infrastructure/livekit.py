"""LiveKit access tokens (JWT, HS256 with the API secret). The candidate may publish audio from
the microphone only, in room `iv_{sid}`; the agent may publish its TTS track and subscribe."""

from __future__ import annotations

import time
from typing import Any

import jwt


class LiveKitTokens:
    def __init__(self, api_key: str, api_secret: str, url: str) -> None:
        if len(api_secret) < 32:
            raise ValueError('the LiveKit API secret must be at least 32 characters')
        self.api_key = api_key
        self.api_secret = api_secret
        self.url = url

    def _mint(self, identity: str, ttl_s: int, video: dict[str, Any]) -> str:
        now = int(time.time())
        claims = {
            'iss': self.api_key,
            'sub': identity,
            'nbf': now - 5,
            'exp': now + ttl_s,
            'video': video,
        }
        return str(jwt.encode(claims, self.api_secret, algorithm='HS256'))

    def candidate(self, room: str, identity: str, ttl_s: int) -> str:
        return self._mint(
            identity,
            ttl_s,
            {
                'room': room,
                'roomJoin': True,
                'canPublish': True,
                'canPublishSources': ['microphone'],
                'canSubscribe': True,
                'canPublishData': False,
                'canUpdateOwnMetadata': False,
            },
        )

    def agent(self, room: str, identity: str, ttl_s: int) -> str:
        return self._mint(
            identity,
            ttl_s,
            {
                'room': room,
                'roomJoin': True,
                'canPublish': True,
                'canSubscribe': True,
                'canPublishData': True,
                'agent': True,
                'hidden': False,
            },
        )
