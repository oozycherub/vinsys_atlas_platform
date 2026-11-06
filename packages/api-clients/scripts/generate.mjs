// Regenerates src/generated/<service>.ts from services/<service>/openapi.yaml (openapi-typescript).
// `--check` exits 1 if the checked-in files are stale (CI and the drift test use it).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
export const SERVICES = [
  'tenant-svc',
  'identity-svc',
  'taxonomy-svc',
  'profile-svc',
  'matching-svc',
  'assessment-svc',
  'proctoring-svc',
  'interview-svc',
  'intelligence-svc',
  'notification-svc',
  'report-svc',
];

export async function render(service) {
  const spec = pathToFileURL(path.join(root, 'services', service, 'openapi.yaml'));
  const ast = await openapiTS(spec, { alphabetize: true, exportType: true });
  return `/* eslint-disable */\n// Generated from services/${service}/openapi.yaml by packages/api-clients/scripts/generate.mjs. Do not edit.\n\n${astToString(ast)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  let stale = [];
  for (const service of SERVICES) {
    const file = path.join(here, '../src/generated', `${service}.ts`);
    const next = await render(service);
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      // not generated yet
    }
    if (current !== next) {
      stale.push(service);
      if (!check) writeFileSync(file, next);
    }
  }
  if (check && stale.length) {
    console.error(
      `stale clients: ${stale.join(', ')} (run npm run generate -w @atlas/api-clients)`,
    );
    process.exit(1);
  }
  console.log(
    check ? 'clients up to date' : `generated ${SERVICES.length} clients (${stale.length} changed)`,
  );
}
