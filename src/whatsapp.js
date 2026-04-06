import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import qrcode  from 'qrcode';
import { db }  from './db.js';
import { botEngine } from './bot-engine.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

class WAManager {
  constructor() {
    this.instances = new Map(); // id → { sock, qr, status }
  }

  async connect(instanceId) {
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/instance_${instanceId}`);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      browser: ['CRM Tarot', 'Chrome', '1.0'],
      printQRInTerminal: false,
    });

    this.instances.set(instanceId, { sock, qr: null, status: 'connecting' });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const qrDataUrl = await qrcode.toDataURL(qr);
        const inst = this.instances.get(instanceId);
        if (inst) {
          inst.qr     = qrDataUrl;
          inst.status = 'qr_ready';
        }
        await db.query(`UPDATE wa_instances SET status='qr_ready' WHERE id=$1`, [instanceId]);
      }

      if (connection === 'open') {
        const info = sock.user;
        const inst = this.instances.get(instanceId);
        if (inst) {
          inst.status = 'connected';
          inst.qr     = null;
        }
        await db.query(
          `UPDATE wa_instances SET status='connected', phone=$1 WHERE id=$2`,
          [info?.id?.split(':')[0], instanceId]
        );
        console.log(`✅ Instância ${instanceId} conectada`);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        await db.query(`UPDATE wa_instances SET status='disconnected' WHERE id=$1`, [instanceId]);

        if (shouldReconnect) {
          console.log(`🔄 Reconectando instância ${instanceId}...`);
          setTimeout(() => this.connect(instanceId), 5000);
        } else {
          this.instances.delete(instanceId);
          console.log(`❌ Instância ${instanceId} desconectada permanentemente`);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;

        const phone = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        const msgContent = msg.message;

        // ── Mensagem de texto ──
        const text = msgContent.conversation
                  || msgContent.extendedTextMessage?.text
                  || '';

        // ── Mensagem de áudio/voz ──
        const isAudio = !!(msgContent.audioMessage || msgContent.pttMessage);

        if (text) {
          try {
            await botEngine.handle(instanceId, sock, phone, text);
          } catch(e) {
            console.error('[BOT TEXT ERROR]', e.message);
          }
        } else if (isAudio) {
          try {
            // Baixa o áudio
            const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
              logger,
              reuploadRequest: sock.updateMediaMessage
            });

            const mimeType = msgContent.audioMessage?.mimetype
                          || msgContent.pttMessage?.mimetype
                          || 'audio/ogg; codecs=opus';

            await botEngine.handle(instanceId, sock, phone, '', audioBuffer, mimeType);
          } catch(e) {
            console.error('[BOT AUDIO ERROR]', e.message);
            // Fallback: avisa que não conseguiu processar o áudio
            try {
              await this.sendText(instanceId, phone,
                `🙏 Recebi seu áudio, mas tive dificuldade em processá-lo. Poderia escrever sua mensagem? Estou aqui para ajudar. 💜`
              );
            } catch(e2) {}
          }
        }
      }
    });

    return sock;
  }

  async disconnect(instanceId) {
    const inst = this.instances.get(instanceId);
    if (inst?.sock) {
      try { await inst.sock.logout(); } catch(e) {}
      this.instances.delete(instanceId);
    }
    await db.query(`UPDATE wa_instances SET status='disconnected' WHERE id=$1`, [instanceId]);
  }

  getQR(instanceId)     { return this.instances.get(instanceId)?.qr     || null; }
  getStatus(instanceId) { return this.instances.get(instanceId)?.status  || 'disconnected'; }

  async sendText(instanceId, phone, text) {
    const inst = this.instances.get(instanceId);
    if (!inst?.sock) throw new Error('Instância não conectada');
    const jid = `${phone}@s.whatsapp.net`;

    // Simula digitação humana (anti-ban)
    await inst.sock.sendPresenceUpdate('composing', jid);
    const delay = Math.min(Math.max(text.length * 28, 1500), 6000);
    await new Promise(r => setTimeout(r, delay));
    await inst.sock.sendPresenceUpdate('paused', jid);

    return inst.sock.sendMessage(jid, { text });
  }

  async reconnectAll() {
    const { rows } = await db.query(`SELECT id FROM wa_instances WHERE status != 'disconnected'`);
    for (const row of rows) {
      console.log(`🔄 Reconectando instância ${row.id}...`);
      this.connect(row.id);
    }
  }
}

export const waManager = new WAManager();
