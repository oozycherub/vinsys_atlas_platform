// Serves Monaco from our own origin (CSP: no third-party script hosts): copies its AMD build to
// public/monaco/vs, where @monaco-editor/react's loader is pointed.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The package's export map hides package.json, so walk up to the hoisted node_modules.
let dir = path.join(here, '..');
while (!existsSync(path.join(dir, 'node_modules', 'monaco-editor', 'min', 'vs', 'loader.js'))) {
  const up = path.dirname(dir);
  if (up === dir) throw new Error('monaco-editor is not installed');
  dir = up;
}
const src = path.join(dir, 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = path.join(here, '..', 'public', 'monaco', 'vs');
if (existsSync(dest)) rmSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`monaco copied to ${path.relative(process.cwd(), dest)}`);
