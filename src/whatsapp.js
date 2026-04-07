import BaileysModule, {
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  makeWASocket as makeWASocketNamed,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import { db } from './db.js';
import { botEngine } from './bot-engine.js';
import { usePostgresAuthState, deleteAuthState } from './postgres-auth-state.js';
import pino from 'pino';

// ── Compatível com qualquer versão do Baileys ─────────────────────────────────
const makeWASocket = makeWASocketNamed
  || BaileysModule?.makeWASocket
  || BaileysModule?.default?.makeWASocket
  || BaileysModule?.default
  || BaileysModule;

// Logger com nível warn para ver erros importantes mas não spam
const logger = pino({ level: 'warn' });

// ── Buffer de logs para endpoint de debug ─────────────────────────────────────
const LOG_BUFFER = [];
const MAX_LOG_LINES = 200;

function addLog(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.join(' ')}`;
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length > MAX_LOG_LINES) LOG_BUFFER.shift();
  if (level === 'ERROR') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function getDebugLogs() {
  return [...LOG_BUFFER];
}

// ── Versão do WhatsApp Web ────────────────────────────────────────────────────
let WA_VERSION = [2, 3000, 1035194821]; // versão atualizada

async function getWAVersion() {
  try {
    const { version, isLatest } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);
    addLog('INFO', `Versão WhatsApp: ${version} | Mais recente: ${isLatest}`);
    WA_VERSION = version;
    return version;
  } catch (e) {
    addLog('WARN', `fetchLatestBaileysVersion falhou (${e.message}), usando versão fixa: ${WA_VERSION}`);
    return WA_VERSION;
  }
}

// ─── Salva mensagem no banco ──────────────────────────────────────────────────
async function saveMessage(instanceId, phone, role, content, agent = 'bot') {
  try {
    if (!content || !phone) return;

    const { rows: cRows } = await db.query(`
      INSERT INTO contacts (instance_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (instance_id, phone) DO UPDATE SET last_seen = NOW()
      RETURNING id
    `, [instanceId, phone]);

    const contactId = cRows[0]?.id;
    if (!contactId) return;

    await db.query(`
      INSERT INTO messages (instance_id, contact_id, role, content, agent)
      VALUES ($1, $2, $3, $4, $5)
    `, [instanceId, contactId, role, content, agent]);
  } catch (e) {
    addLog('ERROR', '[SAVE MSG]', e.message);
  }
}

class WAManager {
  constructor() {
    // Map: instanceId → { sock, qr, status, qrTimestamp, reconnectTimer }
    this.instances = new Map();
  }

  async connect(instanceId) {
    // Evita conexões duplicadas
    const existing = this.instances.get(instanceId);
    if (existing && (existing.status === 'connected' || existing.status === 'connecting')) {
      addLog('INFO', `[CONNECT] Instância ${instanceId} já está ${existing.status}, ignorando`);
      return existing.sock;
    }

    // Cancela timer de reconexão pendente
    if (existing?.reconnectTimer) {
      clearTimeout(existing.reconnectTimer);
    }

    addLog('INFO', `[CONNECT] Iniciando conexão para instância ${instanceId}`);

    // Marca como conectando
    this.instances.set(instanceId, {
      sock: null, qr: null, status: 'connecting', qrTimestamp: null, reconnectTimer: null
    });

    try {
      await db.query(`UPDATE wa_instances SET status='connecting' WHERE id=$1`, [instanceId]);
    } catch (e) {
      addLog('WARN', `[CONNECT] Erro ao atualizar status no banco: ${e.message}`);
    }

    // ── Carrega estado de auth do PostgreSQL ──────────────────────────────
    let state, saveCreds;
    try {
      ({ state, saveCreds } = await usePostgresAuthState(instanceId));
      addLog('INFO', `[AUTH] Estado carregado para instância ${instanceId}`);
    } catch (e) {
      addLog('ERROR', `[AUTH] Erro ao carregar estado para instância ${instanceId}: ${e.message}`);
      this.instances.delete(instanceId);
      return null;
    }

    // ── Obtém versão do WhatsApp ──────────────────────────────────────────
    const version = await getWAVersion();
    addLog('INFO', `[CONNECT] Usando versão WA: ${version}`);

    // ── Cria socket Baileys ───────────────────────────────────────────────
    let sock;
    try {
      sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        browser: ['CRM Tarot', 'Chrome', '120.0.0'],
        printQRInTerminal: true, // Imprime QR no terminal para debug
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        retryRequestDelayMs: 3000,
        maxMsgRetryCount: 3,
        syncFullHistory: true,
        getMessage: async () => undefined,
      });
      addLog('INFO', `[CONNECT] Socket criado para instância ${instanceId}`);
    } catch (e) {
      addLog('ERROR', `[CONNECT] Erro ao criar socket para instância ${instanceId}: ${e.message}`);
      addLog('ERROR', `[CONNECT] Stack: ${e.stack}`);
      this.instances.delete(instanceId);
      return null;
    }

    const inst = this.instances.get(instanceId);
    if (inst) inst.sock = sock;

    // ── Salva credenciais ao atualizar ────────────────────────────────────
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        addLog('INFO', `[CREDS] Credenciais salvas para instância ${instanceId}`);
      } catch (e) {
        addLog('ERROR', `[CREDS] Erro ao salvar: ${e.message}`);
      }
    });

    // ── Eventos de conexão ────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      const inst = this.instances.get(instanceId);

      addLog('INFO', `[CONN UPDATE] inst=${instanceId} connection=${connection || 'null'} qr=${qr ? 'SIM' : 'NÃO'} statusCode=${lastDisconnect?.error?.output?.statusCode || 'N/A'}`);

      // QR Code gerado
      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr, { width: 300 });
          if (inst) {
            inst.qr          = qrDataUrl;
            inst.status      = 'qr_ready';
            inst.qrTimestamp = Date.now();
          }
          await db.query(`UPDATE wa_instances SET status='qr_ready' WHERE id=$1`, [instanceId]);
          addLog('INFO', `📱 QR Code gerado para instância ${instanceId} (${qrDataUrl.length} bytes)`);
        } catch (e) {
          addLog('ERROR', `[QR] Erro ao gerar QR: ${e.message}`);
        }
      }

      // Conectado com sucesso
      if (connection === 'open') {
        const info  = sock.user;
        const phone = info?.id?.split(':')[0] || info?.id?.split('@')[0] || '';
        if (inst) {
          inst.status = 'connected';
          inst.qr     = null;
          inst.qrTimestamp = null;
        }
        try {
          await db.query(
            `UPDATE wa_instances SET status='connected', phone=$1 WHERE id=$2`,
            [phone, instanceId]
          );
        } catch (e) {
          addLog('WARN', `[CONN] Erro ao atualizar status connected: ${e.message}`);
        }
        addLog('INFO', `✅ Instância ${instanceId} conectada — ${phone}`);
      }

      // Desconectado
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason     = lastDisconnect?.error?.message || 'desconhecido';

        const isLoggedOut = statusCode === DisconnectReason.loggedOut
                         || statusCode === 401
                         || statusCode === 403;

        const isReplacedByAnotherDevice = statusCode === DisconnectReason.multideviceMismatch
                                       || statusCode === 440;

        addLog('WARN', `⚠️ Instância ${instanceId} desconectada — código: ${statusCode}, motivo: ${reason}`);

        if (inst) inst.status = 'disconnected';
        try {
          await db.query(`UPDATE wa_instances SET status='disconnected' WHERE id=$1`, [instanceId]);
        } catch (e) {}

        if (isLoggedOut || isReplacedByAnotherDevice) {
          // Sessão inválida — limpa tudo e aguarda reconexão manual
          addLog('ERROR', `❌ Instância ${instanceId} deslogada permanentemente — limpando sessão`);
          this.instances.delete(instanceId);
          try { await deleteAuthState(instanceId); } catch (e) {}
        } else {
          // Erro temporário — reconecta após delay
          const delay = 15_000; // 15 segundos
          addLog('INFO', `🔄 Reconectando instância ${instanceId} em ${delay/1000}s...`);
          this.instances.delete(instanceId);
          const timer = setTimeout(() => this.connect(instanceId), delay);
          // Guarda referência para poder cancelar se necessário
          this.instances.set(instanceId, {
            sock: null, qr: null, status: 'disconnected',
            qrTimestamp: null, reconnectTimer: timer
          });
        }
      }
    });

    // ── Recebe mensagens (novas e históricas) ─────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = mensagem nova em tempo real
      // 'append' = mensagens históricas do syncFullHistory
      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        if (!msg.message) continue;

        const jid   = msg.key.remoteJid || '';
        const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        if (!phone || jid.endsWith('@g.us')) continue; // ignora grupos

        const msgContent = msg.message;
        const isFromMe   = msg.key.fromMe;

        // ── Extrai conteúdo ──────────────────────────────────────────────
        const text = msgContent.conversation
                  || msgContent.extendedTextMessage?.text
                  || msgContent.imageMessage?.caption
                  || msgContent.videoMessage?.caption
                  || msgContent.documentMessage?.caption
                  || '';

        const isAudio = !!(msgContent.audioMessage || msgContent.pttMessage);
        const isImage = !!msgContent.imageMessage;
        const isVideo = !!msgContent.videoMessage;

        const displayContent = text
          || (isAudio ? '[Áudio 🎙️]' : isImage ? '[Imagem 🖼️]' : isVideo ? '[Vídeo 🎥]' : '[Mídia]');

        // ── Salva no banco ───────────────────────────────────────────────
        const role  = isFromMe ? 'assistant' : 'user';
        const agent = isFromMe ? 'bot' : 'whatsapp';
        await saveMessage(instanceId, phone, role, displayContent, agent);

        // ── Processa com bot (apenas mensagens novas e recebidas) ────────
        if (type === 'notify' && !isFromMe) {
          if (text) {
            try {
              await botEngine.handle(instanceId, sock, phone, text);
            } catch (e) {
              addLog('ERROR', `[BOT TEXT] ${e.message}`);
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
            } catch (e) {
              addLog('ERROR', `[BOT AUDIO] ${e.message}`);
              try {
                await this.sendText(instanceId, phone,
                  `🙏 Recebi seu áudio, mas tive dificuldade em processá-lo. Poderia escrever sua mensagem? Estou aqui para ajudar. 💜`
                );
              } catch (e2) {}
            }
          }
        }
      }
    });

    return sock;
  }

  async disconnect(instanceId) {
    const inst = this.instances.get(instanceId);
    if (inst?.reconnectTimer) clearTimeout(inst.reconnectTimer);
    if (inst?.sock) {
      try { await inst.sock.logout(); } catch (e) {}
      try { inst.sock.end(); } catch (e) {}
    }
    this.instances.delete(instanceId);
    try {
      await db.query(`UPDATE wa_instances SET status='disconnected' WHERE id=$1`, [instanceId]);
      await deleteAuthState(instanceId);
    } catch (e) {}
  }

  getQR(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst?.qr) return null;
    // QR Code expira em 60 segundos
    if (inst.qrTimestamp && Date.now() - inst.qrTimestamp > 60_000) {
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
    } catch (e) {}

    const result = await inst.sock.sendMessage(jid, { text });
    await saveMessage(instanceId, phone, 'assistant', text, 'bot');
    return result;
  }

  async reconnectAll() {
    try {
      // Reconecta TODAS as instâncias existentes (não só as não-desconectadas)
      const { rows } = await db.query(`SELECT id FROM wa_instances ORDER BY id`);
      addLog('INFO', `[RECONNECT ALL] ${rows.length} instância(s) encontrada(s)`);
      for (const row of rows) {
        const delay = 3000 + (row.id * 2000);
        addLog('INFO', `🔄 Reconectando instância ${row.id} em ${delay/1000}s...`);
        setTimeout(() => this.connect(row.id), delay);
      }
    } catch (e) {
      addLog('ERROR', `[RECONNECT ALL] ${e.message}`);
    }
  }
}

export const waManager = new WAManager();
