'use client';

import { useT } from './providers';

/** Small accessible building blocks (WCAG 2.2 AA: labels, roles, contrast, focus). */
export function PageTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="mb-6 text-2xl font-semibold">{children}</h1>;
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section
      className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      aria-label={title}
    >
      {title ? <h2 className="mb-3 text-lg font-semibold">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' },
) {
  const { variant = 'primary', className = '', ...rest } = props;
  const style =
    variant === 'primary'
      ? 'bg-brand text-white hover:bg-brand-dark disabled:bg-slate-400'
      : 'border border-slate-300 bg-white text-ink hover:bg-slate-100 disabled:text-slate-400';
  return (
    <button
      {...rest}
      className={`rounded-md px-4 py-2 text-sm font-medium ${style} ${className}`}
    />
  );
}

export function Field({
  label,
  id,
  ...input
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; id: string }) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <input id={id} {...input} className="w-full rounded-md border border-slate-400 px-3 py-2" />
    </div>
  );
}

export function Loading() {
  const t = useT();
  return (
    <p role="status" className="text-muted">
      {t('common.loading')}
    </p>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const t = useT();
  const detail = error instanceof Error && error.message ? error.message : t('common.error');
  return (
    <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800">
      {detail}
    </p>
  );
}

export function Table({
  head,
  rows,
  caption,
}: {
  head: string[];
  rows: React.ReactNode[][];
  caption: string;
}) {
  return (
    <table className="w-full text-start text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-slate-200">
          {head.map((h) => (
            <th key={h} scope="col" className="px-2 py-2 text-start font-semibold">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-slate-100">
            {r.map((c, j) => (
              <td key={j} className="px-2 py-2">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
