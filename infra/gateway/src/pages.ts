import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Branded error pages (Component Prompt 14 §2): static HTML, no scripts, values escaped. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

const PAGES_DIR = path.resolve(__dirname, '../pages');
const cache = new Map<string, string>();

function template(name: string): string {
  let t = cache.get(name);
  if (!t) {
    t = readFileSync(path.join(PAGES_DIR, name), 'utf8');
    cache.set(name, t);
  }
  return t;
}

export function page(
  name: 'not-found.html' | 'suspended.html' | 'unavailable.html',
  values: Record<string, string>,
): string {
  return template(name).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => escapeHtml(values[k] ?? ''));
}

/** Security headers for the gateway's own pages. */
export const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
