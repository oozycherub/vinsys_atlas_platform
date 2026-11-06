import { type NextRequest, NextResponse } from 'next/server';

/**
 * Per-request CSP nonce (Component Prompt 14 §6: no inline scripts). Next.js applies the nonce
 * to its own scripts; anything inline without it is blocked. Styles may be inline (Monaco and
 * Tailwind need it); scripts never.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' wss: https:`,
    `media-src 'self' blob: mediastream:`,
    `worker-src 'self' blob:`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{ source: '/((?!v1/|_next/static|_next/image|monaco/|favicon.ico).*)' }],
};
