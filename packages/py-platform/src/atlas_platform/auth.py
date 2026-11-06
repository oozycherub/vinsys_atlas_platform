"""Bearer-token verification, matching @atlas/platform JwtVerifier (claims: sub, tid, roles, scopes)."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt

from atlas_platform.errors import AppError

ROLES = frozenset(
    {
        'super_admin',
        'tenant_admin',
        'recruiter',
        'hiring_manager',
        'reviewer',
        'sme',
        'employee',
        'candidate',
        'service',
    }
)


@dataclass(frozen=True)
class Principal:
    subject: str
    tenant_id: str | None
    roles: frozenset[str]
    scopes: frozenset[str]

    def is_service(self, scope: str) -> bool:
        return 'service' in self.roles and scope in self.scopes

    def can_access_tenant(self, tenant_id: str) -> bool:
        """Platform staff, or a member of that tenant (a tenant-bound token)."""
        return 'super_admin' in self.roles or (
            self.tenant_id is not None and self.tenant_id.lower() == tenant_id.lower()
        )


class JwtVerifier:
    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        jwks_url: str | None = None,
        shared_secret: str | None = None,
        leeway: int = 30,
    ) -> None:
        if jwks_url:
            self._jwks: jwt.PyJWKClient | None = jwt.PyJWKClient(
                jwks_url, cache_keys=True, lifespan=300
            )
            self._secret: str | None = None
            self._algorithms = ['RS256', 'ES256']
        elif shared_secret and len(shared_secret) >= 32:
            self._jwks = None
            self._secret = shared_secret
            self._algorithms = ['HS256']
        else:
            raise ValueError(
                'JwtVerifier needs jwks_url, or a shared_secret of at least 32 characters.'
            )
        self._issuer = issuer
        self._audience = audience
        self._leeway = leeway

    async def verify(self, token: str) -> Principal:
        try:
            key: Any = (
                (await asyncio.to_thread(self._jwks.get_signing_key_from_jwt, token)).key
                if self._jwks
                else self._secret
            )
            claims = jwt.decode(
                token,
                key,
                algorithms=self._algorithms,
                audience=self._audience,
                issuer=self._issuer,
                leeway=self._leeway,
                options={'require': ['exp', 'sub']},
            )
        except (jwt.PyJWTError, ValueError) as error:
            raise AppError(
                'unauthorized', 'UNAUTHENTICATED', 'The bearer token is invalid or expired.'
            ) from error
        roles = claims.get('roles')
        scopes = claims.get('scopes', [])
        tid = claims.get('tid')
        if (
            not isinstance(roles, list)
            or not roles
            or not set(roles) <= ROLES
            or not isinstance(scopes, list)
            or not all(isinstance(s, str) for s in scopes)
            or (tid is not None and not isinstance(tid, str))
        ):
            raise AppError(
                'unauthorized', 'UNAUTHENTICATED', 'The bearer token is missing required claims.'
            )
        return Principal(str(claims['sub']), tid, frozenset(roles), frozenset(scopes))


class ClientCredentialsTokenProvider:
    """OAuth2 client-credentials tokens for service-to-service calls, cached until shortly
    before expiry; concurrent callers share one fetch (as @atlas/platform's provider)."""

    def __init__(
        self,
        *,
        token_url: str,
        client_id: str,
        client_secret: str,
        scopes: list[str],
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self._url = token_url
        self._auth = (client_id, client_secret)
        self._scopes = scopes
        self._http = http or httpx.AsyncClient(timeout=5.0)
        self._token: str | None = None
        self._expires = 0.0
        self._lock = asyncio.Lock()

    async def token(self) -> str:
        async with self._lock:
            if self._token and time.monotonic() < self._expires - 30:
                return self._token
            response = await self._http.post(
                self._url,
                data={'grant_type': 'client_credentials', 'scope': ' '.join(self._scopes)},
                auth=self._auth,
            )
            response.raise_for_status()
            body = response.json()
            self._token = str(body['access_token'])
            self._expires = time.monotonic() + float(body.get('expires_in', 300))
            return self._token
