import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import qrcode  from 'qrcode';
import { db }  from './db.js';
import { botEngine } from './bot-engine.js';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

const logger = pino({ level: 'silent' });

// Diretório de sessões — usa /tmp para sobreviver a restarts no mesmo container
// (Para persistência total entre deploys, usamos backup no banco)
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/tmp/wa_sessions';

// ─── Garante que o diretório de sessões existe ────────────────────────────────
function ensureSessionDir(instanceId) {
  const dir = path.join(SESSIONS_DIR, `instance_${instanceId}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Salva sessão no banco PostgreSQL ─────────────────────────────────────────
async function saveSessionToDB(instanceId) {
  try {
    const dir = path.join(SESSIONS_DIR, `instance_${instanceId}`);
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);
    const sessionData = {};
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      sessionData[file] = content;
    }

    await db.query(`
      INSERT INTO wa_sessions (instance_id, session_data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (instance_id) DO UPDATE
        SET session_data = $2, updated_at = NOW()
    `, [instanceId, JSON.stringify(sessionData)]);
  } catch (e) {
    // Silencioso — não crítico
  }
}

// ─── Restaura sessão do banco PostgreSQL ──────────────────────────────────────
async function restoreSessionFromDB(instanceId) {
  try {
    const { rows } = await db.query(
      `SELECT session_data FROM wa_sessions WHERE instance_id=$1`, [instanceId]
    );
    if (!rows.length || !rows[0].session_data) return false;

    const dir = ensureSessionDir(instanceId);
    const sessionData = JSON.parse(rows[0].session_data);

    for (const [filename, content] of Object.entries(sessionData)) {
      fs.writeFileSync(path.join(dir, filename), content, 'utf8');
    }
    return true;
  } catch (e) {
    return false;
  }
}

class WAManager {
  constructor() {
    this.instances = new Map(); // id → { sock, qr, status, qrTimestamp }
  }

  async connect(instanceId) {
    // Evita conexões duplicadas
    const existing = this.instances.get(instanceId);
    if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
      return existing.sock;
    }

    // Marca como conectando
    this.instances.set(instanceId, {
      sock: null, qr: null, status: 'connecting', qrTimestamp: null
    });
    await db.query(`UPDATE wa_instances SET status='connecting' WHERE id=$1`, [instanceId]);

    // Restaura sessão do banco se disponível
    await restoreSessionFromDB(instanceId);

    const sessionDir = ensureSessionDir(instanceId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      browser: ['CRM Tarot', 'Chrome', '120.0.0'],
      printQRInTerminal: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 5,
    });

    const inst = this.instances.get(instanceId);
    if (inst) inst.sock = sock;

    // ── Eventos de conexão ──────────────────────────────────────────────────
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr, { width: 300 });
          const inst = this.instances.get(instanceId);
          if (inst) {
            inst.qr          = qrDataUrl;
            inst.status      = 'qr_ready';
            inst.qrTimestamp = Date.now();
          }
          await db.query(`UPDATE wa_instances SET status='qr_ready' WHERE id=$1`, [instanceId]);
          console.log(`📱 QR Code gerado para instância ${instanceId}`);
        } catch (e) {
          console.error('[QR ERROR]', e.message);
        }
      }

      if (connection === 'open') {
        const info = sock.user;
        const phone = info?.id?.split(':')[0] || info?.id?.split('@')[0];
        const inst = this.instances.get(instanceId);
        if (inst) {
          inst.status = 'connected';
          inst.qr     = null;
        }
        await db.query(
          `UPDATE wa_instances SET status='connected', phone=$1 WHERE id=$2`,
          [phone, instanceId]
        );
        // Salva sessão no banco após conectar
        await saveSessionToDB(instanceId);
        console.log(`✅ Instância ${instanceId} conectada — ${phone}`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut
                         || statusCode === 401
                         || statusCode === 403;

        const inst = this.instances.get(instanceId);
        if (inst) inst.status = 'disconnected';
        await db.query(`UPDATE wa_instances SET status='disconnected' WHERE id=$1`, [instanceId]);

        if (isLoggedOut) {
          // Limpa sessão — foi deslogado
          this.instances.delete(instanceId);
          await db.query(`DELETE FROM wa_sessions WHERE instance_id=$1`, [instanceId]);
          const dir = path.join(SESSIONS_DIR, `instance_${instanceId}`);
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          console.log(`❌ Instância ${instanceId} deslogada permanentemente`);
        } else {
          // Reconecta automaticamente após 8 segundos
          console.log(`🔄 Reconectando instância ${instanceId} em 8s... (código: ${statusCode})`);
          setTimeout(() => {
            this.instances.delete(instanceId);
            this.connect(instanceId);
          }, 8000);
        }
      }
    });

    // ── Salva credenciais sempre que atualizar ──────────────────────────────
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await saveSessionToDB(instanceId);
    });

    // ── Recebe mensagens ────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe || !msg.message) continue;

        const phone      = msg.key.remoteJid?.replace('@s.whatsapp.net', '');
        if (!phone || phone.includes('@')) continue;

        const msgContent = msg.message;

        // ── Texto ──
        const text = msgContent.conversation
                  || msgContent.extendedTextMessage?.text
                  || msgContent.imageMessage?.caption
                  || '';

        // ── Áudio / PTT ──
        const isAudio = !!(msgContent.audioMessage || msgContent.pttMessage);

        // ── Imagem ──
        const isImage = !!msgContent.imageMessage;

        // ── Salva mensagem recebida no banco ──
        try {
          const { rows: cRows } = await db.query(`
            INSERT INTO contacts (instance_id, phone)
            VALUES ($1, $2)
            ON CONFLICT (instance_id, phone) DO UPDATE SET last_seen=NOW()
            RETURNING id
          `, [instanceId, phone]);

          const contactId = cRows[0]?.id;
          if (contactId && (text || isAudio || isImage)) {
            const displayContent = text || (isAudio ? '[Áudio]' : isImage ? '[Imagem]' : '[Mídia]');
            await db.query(`
              INSERT INTO messages (instance_id, contact_id, role, content, agent)
              VALUES ($1, $2, 'user', $3, 'whatsapp')
            `, [instanceId, contactId, displayContent]);
          }
        } catch (e) {
          console.error('[DB SAVE MSG ERROR]', e.message);
        }

        // ── Processa com bot ──
        if (text) {
          try {
            await botEngine.handle(instanceId, sock, phone, text);
          } catch(e) {
            console.error('[BOT TEXT ERROR]', e.message);
          }
        } else if (isAudio) {
          try {
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
      try { inst.sock.end(); } catch(e) {}
    }
    this.instances.delete(instanceId);
    await db.query(`UPDATE wa_instances SET status='disconnected' WHERE id=$1`, [instanceId]);
    // Remove sessão salva
    await db.query(`DELETE FROM wa_sessions WHERE instance_id=$1`, [instanceId]);
    const dir = path.join(SESSIONS_DIR, `instance_${instanceId}`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  getQR(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst?.qr) return null;
    // QR Code expira em 60 segundos
    if (inst.qrTimestamp && Date.now() - inst.qrTimestamp > 60000) {
      inst.qr = null;
      return null;
    }
    return inst.qr;
  }

  getStatus(instanceId) {
    return this.instances.get(instanceId)?.status || null;
  }

  async sendText(instanceId, phone, text) {
    const inst = this.instances.get(instanceId);
    if (!inst?.sock) throw new Error('Instância não conectada');
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

    // Simula digitação (anti-ban)
    try {
      await inst.sock.sendPresenceUpdate('composing', jid);
      const delay = Math.min(Math.max(text.length * 25, 1200), 5000);
      await new Promise(r => setTimeout(r, delay));
      await inst.sock.sendPresenceUpdate('paused', jid);
    } catch(e) {}

    const result = await inst.sock.sendMessage(jid, { text });

    // Salva mensagem enviada no banco
    try {
      const { rows } = await db.query(`
        SELECT id FROM contacts WHERE instance_id=$1 AND phone=$2
      `, [instanceId, phone]);
      if (rows.length) {
        await db.query(`
          INSERT INTO messages (instance_id, contact_id, role, content, agent)
          VALUES ($1, $2, 'assistant', $3, 'bot')
        `, [instanceId, rows[0].id, text]);
      }
    } catch(e) {}

    return result;
  }

  async reconnectAll() {
    const { rows } = await db.query(`
      SELECT id FROM wa_instances WHERE status != 'disconnected'
    `);
    for (const row of rows) {
      console.log(`🔄 Reconectando instância ${row.id}...`);
      setTimeout(() => this.connect(row.id), 2000 * row.id);
    }
  }
}

export const waManager = new WAManager();
