'use client';

import Editor, { loader } from '@monaco-editor/react';

// Monaco from our own origin (public/monaco, copied at build): the CSP allows no other script host.
loader.config({ paths: { vs: '/monaco/vs' } });

const MONACO_LANGUAGE: Record<string, string> = {
  python: 'python',
  javascript: 'javascript',
  java: 'java',
  cpp: 'cpp',
  go: 'go',
  csharp: 'csharp',
};

export function CodeEditor({
  value,
  language,
  onChange,
  label,
}: {
  value: string;
  language: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-slate-300" data-testid="code-editor">
      <Editor
        height="360px"
        language={MONACO_LANGUAGE[language] ?? 'plaintext'}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize: 14,
          ariaLabel: label,
          accessibilitySupport: 'on',
          tabFocusMode: false,
          scrollBeyondLastLine: false,
        }}
      />
      <p className="bg-slate-50 px-3 py-1 text-xs text-muted">
        Tip: press Ctrl+M (Cmd+M on Mac) to let Tab move focus out of the editor.
      </p>
    </div>
  );
}
