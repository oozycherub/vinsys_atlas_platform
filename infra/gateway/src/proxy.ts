import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import { type Logger } from 'pino';
import { type Edge } from './edge';
import { page, PAGE_HEADERS } from './pages';

const DROP_FROM_UPSTREAM = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'x-powered-by',
  'server',
]);

/**
 * The gateway's HTTP transport: asks the Edge, then streams the request to the upstream service
 * and its response back (SSE and downloads included). TLS and WAF are terminated in front of it
 * (infra/gateway/envoy).
 */
export function createGatewayServer(edge: Edge, logger?: Logger): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(edge, req, res, logger);
  });
}

async function handle(
  edge: Edge,
  req: IncomingMessage,
  res: ServerResponse,
  logger?: Logger,
): Promise<void> {
  const started = Date.now();
  let d;
  try {
    d = await edge.decide({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      remoteAddress: req.socket.remoteAddress ?? 'unknown',
    });
  } catch (error) {
    logger?.error({ err: error }, 'gateway decision failed');
    res.writeHead(500, { 'content-type': 'application/problem+json' });
    res.end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Internal error',
        status: 500,
        code: 'INTERNAL',
      }),
    );
    return;
  }
  const log = (status: number, upstream?: string) =>
    logger?.info(
      {
        request_id: d.requestId,
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        status,
        upstream,
        ms: Date.now() - started,
      },
      'gateway',
    );

  if (d.kind === 'page') {
    res.writeHead(d.status, { ...PAGE_HEADERS, ...d.responseHeaders });
    res.end(d.html);
    log(d.status);
    return;
  }
  if (d.kind === 'problem') {
    res.writeHead(d.status, {
      ...d.responseHeaders,
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
    });
    res.end(
      JSON.stringify({
        type: 'about:blank',
        title: d.title,
        status: d.status,
        code: d.code,
        request_id: d.requestId,
      }),
    );
    log(d.status);
    return;
  }
  if (d.kind === 'preflight') {
    res.writeHead(d.status, d.responseHeaders);
    res.end();
    log(d.status);
    return;
  }

  const target = new URL(d.upstream);
  const upstream = request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: d.headers,
    },
    (up) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers))
        if (v !== undefined && !DROP_FROM_UPSTREAM.has(k)) headers[k] = v;
      res.writeHead(up.statusCode ?? 502, { ...headers, ...d.responseHeaders });
      up.pipe(res);
      up.on('end', () => log(up.statusCode ?? 502, target.host));
    },
  );
  upstream.on('error', (error) => {
    logger?.warn(
      { err: error, request_id: d.requestId, upstream: target.host },
      'upstream unreachable',
    );
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const html =
      (req.headers['accept'] ?? '').includes('text/html') && !(req.url ?? '').startsWith('/v1/');
    if (html) {
      res.writeHead(502, PAGE_HEADERS);
      res.end(page('unavailable.html', { request_id: d.requestId }));
    } else {
      res.writeHead(502, { ...d.responseHeaders, 'content-type': 'application/problem+json' });
      res.end(
        JSON.stringify({
          type: 'about:blank',
          title: 'Bad gateway',
          status: 502,
          code: 'UPSTREAM_UNAVAILABLE',
          request_id: d.requestId,
        }),
      );
    }
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}
