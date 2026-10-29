import { default as makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'node:fs';

const phone = String(process.argv[2] || '').replace(/\D/g, '');
const sessionDir = process.argv[3];
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
if (!phone || !sessionDir) { emit({ type: 'status', status: 'error', message: 'Missing arguments' }); process.exit(1); }
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

let sock;
let stopped = false;
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: ['ZEPE TECH', 'Chrome', '1.0.0']
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting') emit({ type: 'status', status: 'connecting' });
    if (connection === 'open') emit({ type: 'status', status: 'online' });
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      emit({ type: 'status', status: code === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected', code });
      // Do not loop indefinitely after auth rejection. Operator can stop and restart manually.
      if (!stopped) process.exit(code === DisconnectReason.loggedOut ? 2 : 1);
    }
    if (connection === 'connecting' && !state.creds.registered) {
      setTimeout(async () => {
        if (stopped || state.creds.registered) return;
        try {
          const code = await sock.requestPairingCode(phone);
          emit({ type: 'pairing', code });
        } catch (e) {
          emit({ type: 'status', status: 'error', message: String(e?.message || e).slice(0, 180) });
        }
      }, 2500);
    }
  });
}
process.on('SIGTERM', async () => {
  stopped = true;
  try { sock?.end(undefined); } catch {}
  process.exit(0);
});
start().catch(e => { emit({ type: 'status', status: 'error', message: String(e?.message || e).slice(0, 180) }); process.exit(1); });
