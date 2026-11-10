// Local simulation: the stub gateway (port 4010, with a demo inbox at /__inbox) and the web app
// as a production build (port 3100). Not a deployment: data lives in memory until it stops.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = {
  ...process.env,
  STUB_PORT: '4010',
  STUB_DEMO: '1',
  STUB_WEB_ORIGIN: 'http://localhost:3100',
  ATLAS_GATEWAY_URL: 'http://127.0.0.1:4010',
  NEXT_PUBLIC_ATLAS_TENANT: 'acme',
  NEXT_TELEMETRY_DISABLED: '1',
};
const run = (cmd, args) => spawn(cmd, args, { cwd: root, env, stdio: 'inherit' });

const stub = run('node', ['e2e/stub/server.mjs']);
const build = run('npm', ['run', 'build', '--workspace=@atlas/web']);
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const web = run('npx', ['--workspace=@atlas/web', 'next', 'start', '--port', '3100']);
  const stop = () => {
    web.kill();
    stub.kill();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
});
