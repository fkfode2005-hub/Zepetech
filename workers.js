
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const workerFile = path.join(
  __dirname,
  'workers',
  'whatsapp-worker.js'
);

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Utilisation : node workers.js <numéro> <dossier-session>');
  process.exit(1);
}

const child = spawn(process.execPath, [workerFile, ...args], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env
});

child.on('exit', code => {
  process.exit(code ?? 1);
});
