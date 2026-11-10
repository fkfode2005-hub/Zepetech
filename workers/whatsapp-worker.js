// Worker WhatsApp de ZEPE TECH (un process par bot)
// Lancé par server.js : node whatsapp-worker.js <numéro> <dossier_session>
// Il parle au serveur en écrivant des lignes JSON sur stdout.
import fs from 'node:fs';
import baileys from '@whiskeysockets/baileys';
import pino from 'pino';

const makeWASocket = baileys.default ?? baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const [phone, sessionDir] = process.argv.slice(2);
if (!phone || !sessionDir) {
  console.error('Usage: whatsapp-worker.js <numero> <dossier_session>');
  process.exit(1);
}

const emit = m => console.log(JSON.stringify(m));
const logger = pino({ level: 'silent' });
let sock = null;
let reconnecting = false;

async function connect() {
  reconnecting = false;
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['ZEPE TECH', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  // Première connexion : on demande un code de jumelage à saisir dans WhatsApp
  if (!state.creds.registered) {
    setTimeout(async () => {
      try {
        const raw = await sock.requestPairingCode(phone);
        const code = raw.match(/.{1,4}/g).join('-');
        emit({ type: 'pairing', code });
      } catch (e) {
        console.error('Erreur code de jumelage:', e?.message || e);
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      emit({ type: 'status', status: 'online' });
    }
    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        // Appareil déconnecté depuis WhatsApp : on efface la session et on s'arrête
        fs.rmSync(sessionDir, { recursive: true, force: true });
        process.exit(0);
      }
      if (!reconnecting) {
        reconnecting = true;
        emit({ type: 'status', status: 'starting' });
        setTimeout(() => connect().catch(fail), 3000);
      }
    }
  });

  // Commande de test : écris .ping au bot
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (m.key.fromMe || !m.message) continue;
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (text.trim().toLowerCase() === '.ping') {
        await sock.sendMessage(m.key.remoteJid, { text: 'pong ✅ ZEPE TECH' }, { quoted: m }).catch(() => {});
      }
    }
  });
}

function fail(e) {
  console.error(e);
  process.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

connect().catch(fail);
