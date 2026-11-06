import mjml2html from 'mjml';
import { allowedPlaceholders, type Channel, type NotificationType } from './types';

/**
 * Template validation and rendering (Component Prompt 13 §6, ADR-0010 §4).
 *
 * - Placeholders are `{Name}`; only the type's allowlist is accepted, and `{{…}}` never is.
 * - Values are HTML-escaped when substituted, in one pass (a value is never re-expanded).
 * - `{URL}` may appear only as an `href` value and only takes `https:` values.
 * - Active content (`<script>`, event-handler attributes, `javascript:` URLs, frames, forms) is
 *   refused when saving, and the rendered HTML is checked again before it is sent.
 */
export interface TemplateIssue {
  path: 'subject' | 'source';
  message: string;
}

export class TemplateError extends Error {
  constructor(readonly issues: TemplateIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join('; '));
    this.name = 'TemplateError';
  }
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const ACTIVE_CONTENT: [RegExp, string][] = [
  [/<\s*script/i, '<script> is not allowed'],
  [
    /<\s*(iframe|object|embed|form|base|meta|link)\b/i,
    'frames, forms and embedded objects are not allowed',
  ],
  [/\son[a-z]+\s*=/i, 'event-handler attributes (on…=) are not allowed'],
  [/javascript\s*:/i, 'javascript: URLs are not allowed'],
  [/vbscript\s*:|data\s*:\s*text\/html/i, 'script URLs are not allowed'],
];
/** Checked on rendered output, which legitimately has <meta> and <link> in its head. */
const ACTIVE_OUTPUT = ACTIVE_CONTENT.filter(([, message]) => !message.startsWith('frames'));
const FRAMES_OUTPUT = /<\s*(iframe|object|embed|form|base)\b/i;
const URL_IN_HREF = /href\s*=\s*"\{URL\}"/g;

export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

function checkText(
  type: NotificationType,
  path: TemplateIssue['path'],
  text: string,
  issues: TemplateIssue[],
): void {
  if (/\{\{|\}\}/.test(text))
    issues.push({ path, message: 'double braces are not template syntax here' });
  const allowed = new Set(allowedPlaceholders(type));
  for (const name of new Set(placeholdersIn(text)))
    if (!allowed.has(name)) issues.push({ path, message: `unknown placeholder {${name}}` });
  for (const [pattern, message] of ACTIVE_CONTENT)
    if (pattern.test(text)) issues.push({ path, message });
}

/** Validates a template; throws TemplateError listing every problem. */
export async function validateTemplate(
  type: NotificationType,
  channel: Channel,
  subject: string,
  source: string,
): Promise<void> {
  const issues: TemplateIssue[] = [];
  checkText(type, 'subject', subject, issues);
  if (/[\r\n]/.test(subject)) issues.push({ path: 'subject', message: 'must be one line' });
  if (subject.includes('{URL}'))
    issues.push({ path: 'subject', message: '{URL} may only be a link target' });
  checkText(type, 'source', source, issues);
  if (channel === 'in_app' && source.includes('{URL}'))
    issues.push({ path: 'source', message: '{URL} is for email links only' });
  if (channel === 'email') {
    const total = source.split('{URL}').length - 1;
    const inHref = [...source.matchAll(URL_IN_HREF)].length;
    if (total !== inHref)
      issues.push({ path: 'source', message: '{URL} may appear only as href="{URL}"' });
  }
  if (issues.length === 0 && channel === 'email') {
    try {
      await compile(fill(source, sampleValues(type), true));
    } catch (error) {
      issues.push({ path: 'source', message: `invalid MJML: ${firstLine(error)}` });
    }
  }
  if (issues.length) throw new TemplateError(issues);
}

function firstLine(error: unknown): string {
  return (
    String((error as Error).message ?? error)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' ')
      // MJML prefixes errors with the working directory; keep only the element message.
      .replace(/Line \d+ of [^(]*/g, '')
      .slice(0, 300)
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One-pass substitution. Missing values render empty; HTML contexts get escaped values. */
export function fill(
  text: string,
  values: Readonly<Record<string, string>>,
  html: boolean,
): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const value = Object.hasOwn(values, name) ? (values[name] ?? '') : '';
    return html ? escapeHtml(value) : value.replace(/[\r\n]+/g, ' ');
  });
}

async function compile(mjml: string): Promise<string> {
  const result = await mjml2html(mjml, { validationLevel: 'strict', keepComments: false });
  return result.html;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Thrown when rendered output would carry active content: the send is refused, not cleaned. */
export class UnsafeOutputError extends Error {}

export async function renderEmail(
  subject: string,
  source: string,
  values: Readonly<Record<string, string>>,
): Promise<RenderedEmail> {
  if (values['URL'] !== undefined && values['URL'] !== '' && !isHttpsUrl(values['URL']))
    throw new UnsafeOutputError('URL must be https');
  const html = await compile(fill(source, values, true));
  for (const pattern of [...ACTIVE_OUTPUT.map(([p]) => p), FRAMES_OUTPUT])
    if (pattern.test(html)) throw new UnsafeOutputError('rendered email contains active content');
  return { subject: fill(subject, values, false).slice(0, 300), html, text: htmlToText(html) };
}

export function renderText(source: string, values: Readonly<Record<string, string>>): string {
  return fill(source, values, false);
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Plain-text alternative: the body text, links kept as "text (url)". */
export function htmlToText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return body
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

export function sampleValues(type: NotificationType): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of allowedPlaceholders(type))
    values[name] = name === 'URL' ? 'https://example.test/link' : `[${name}]`;
  return values;
}
