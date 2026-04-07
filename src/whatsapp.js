import BaileysModule, {
  DisconnectReason,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  makeWASocket as makeWASocketNamed,
  fetchLatestBaileysVersion,
  proto
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

// Logger silencioso — apenas erros críticos
const logger = pino({ level: 'silent' });

// ── Buffer de logs para endpoint de debug ─────────────────────────────────────
const LOG_BUFFER = [];
const MAX_LOG_LINES = 300;

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

// ─── Busca mensagem do banco para descriptografar retransmissões ──────────────
// Isso resolve o erro "Aguardando Mensagem" causado por mensagens sem cache local
async function getMessageFromStore(instanceId, key) {
  try {
    if (!key?.remoteJid || !key?.id) return undefined;
    const phone = key.remoteJid.replace('@s.whatsapp.net', '').replace('@g.us', '');
    const { rows } = await db.query(`
      SELECT m.content, m.role
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      WHERE c.instance_id = $1 AND c.phone = $2
      ORDER BY m.id DESC
      LIMIT 1
    `, [instanceId, phone]);
    if (!rows.length) return undefined;
    // Retorna estrutura mínima para o Baileys conseguir descriptografar
    return proto?.Message?.fromObject?.({ conversation: rows[0].content }) || undefined;
  } catch (e) {
    return undefined;
  }
}

class WAManager {
  constructor() {
    // Map: instanceId → { sock, qr, status, qrTimestamp, reconnectTimer, processedMsgIds }
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

    // Marca como conectando — inclui Set para deduplicação de mensagens
    this.instances.set(instanceId, {
      sock: null, qr: null, status: 'connecting',
      qrTimestamp: null, reconnectTimer: null,
      processedMsgIds: new Set()  // ← trava anti-duplicação
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
        printQRInTerminal: false,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5,
        syncFullHistory: true,
        // ── CORREÇÃO CRÍTICA: getMessage implementado ──────────────────────
        // Permite ao Baileys descriptografar mensagens retransmitidas
        // que não estão no cache local (resolve "Aguardando Mensagem")
        getMessage: async (key) => getMessageFromStore(instanceId, key),
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

    // ── Salva credenciais ao atualizar (com debounce de 500ms) ───────────
    // Evita salvar em loop quando múltiplos eventos chegam juntos
    let credsDebounceTimer = null;
    sock.ev.on('creds.update', () => {
      if (credsDebounceTimer) clearTimeout(credsDebounceTimer);
      credsDebounceTimer = setTimeout(async () => {
        try {
          await saveCreds();
          addLog('INFO', `[CREDS] Credenciais salvas para instância ${instanceId}`);
        } catch (e) {
          addLog('ERROR', `[CREDS] Erro ao salvar: ${e.message}`);
        }
      }, 500);
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
          // Limpa IDs processados ao reconectar (evita falsos positivos)
          inst.processedMsgIds = new Set();
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
          // Erro temporário — reconecta após delay progressivo
          const delay = 15_000;
          addLog('INFO', `🔄 Reconectando instância ${instanceId} em ${delay/1000}s...`);
          this.instances.delete(instanceId);
          const timer = setTimeout(() => this.connect(instanceId), delay);
          this.instances.set(instanceId, {
            sock: null, qr: null, status: 'disconnected',
            qrTimestamp: null, reconnectTimer: timer,
            processedMsgIds: new Set()
          });
        }
      }
    });

    // ── Recebe mensagens (novas e históricas) ─────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = mensagem nova em tempo real
      // 'append' = mensagens históricas do syncFullHistory
      if (type !== 'notify' && type !== 'append') return;

      addLog('INFO', `[MSGS] Recebidas ${messages.length} mensagem(ns) — tipo: ${type}`);

      const inst = this.instances.get(instanceId);

      for (const msg of messages) {
        if (!msg.message) continue;

        // ── CORREÇÃO: Deduplicação por ID de mensagem ────────────────────
        // Impede que o bot responda duas vezes à mesma mensagem
        // (ocorre quando o WhatsApp retransmite ou o servidor reinicia)
        const msgId = msg.key?.id;
        if (msgId) {
          if (inst?.processedMsgIds?.has(msgId)) {
            addLog('INFO', `[DEDUP] Mensagem ${msgId} já processada, ignorando`);
            continue;
          }
          inst?.processedMsgIds?.add(msgId);
          // Limita o Set a 1000 IDs para não vazar memória
          if (inst?.processedMsgIds?.size > 1000) {
            const oldest = [...inst.processedMsgIds].slice(0, 200);
            oldest.forEach(id => inst.processedMsgIds.delete(id));
          }
        }

        // Ignora mensagens de protocolo interno do WhatsApp
        if (msg.message.protocolMessage) continue;
        if (msg.message.reactionMessage) continue;
        if (msg.message.pollUpdateMessage) continue;

        const jid   = msg.key.remoteJid || '';
        const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
        if (!phone || jid.endsWith('@g.us')) continue; // ignora grupos
        if (jid === 'status@broadcast') continue; // ignora status

        const msgContent = msg.message;
        const isFromMe   = msg.key.fromMe === true;

        // ── Extrai conteúdo ──────────────────────────────────────────────
        const innerMsg = msgContent.ephemeralMessage?.message
                      || msgContent.viewOnceMessage?.message
                      || msgContent.viewOnceMessageV2?.message?.viewOnceMessage?.message
                      || msgContent;

        const text = innerMsg.conversation
                  || innerMsg.extendedTextMessage?.text
                  || innerMsg.imageMessage?.caption
                  || innerMsg.videoMessage?.caption
                  || innerMsg.documentMessage?.caption
                  || innerMsg.buttonsResponseMessage?.selectedDisplayText
                  || innerMsg.listResponseMessage?.title
                  || innerMsg.templateButtonReplyMessage?.selectedDisplayText
                  || '';

        const isAudio   = !!(innerMsg.audioMessage || innerMsg.pttMessage);
        const isImage   = !!innerMsg.imageMessage;
        const isVideo   = !!innerMsg.videoMessage;
        const isDoc     = !!innerMsg.documentMessage;
        const isSticker = !!innerMsg.stickerMessage;

        const displayContent = text
          || (isAudio   ? '[Áudio 🎙️]'
            : isImage   ? '[Imagem 🖼️]'
            : isVideo   ? '[Vídeo 🎥]'
            : isDoc     ? '[Documento 📄]'
            : isSticker ? '[Sticker 🎭]'
            : '[Mídia]');

        // ── Salva no banco ───────────────────────────────────────────────
        const role  = isFromMe ? 'assistant' : 'user';
        const agent = isFromMe ? 'bot' : 'whatsapp';
        await saveMessage(instanceId, phone, role, displayContent, agent);

        if (type === 'notify') {
          addLog('INFO', `[MSG ${type}] ${phone} | ${role} | ${displayContent.substring(0, 60)}`);
        }

        // ── CORREÇÃO: markRead automático ────────────────────────────────
        // Marca mensagens recebidas como lidas para manter sincronia de criptografia
        // Isso resolve o erro "Aguardando Mensagem" no WhatsApp do cliente
        if (type === 'notify' && !isFromMe) {
          try {
            await sock.readMessages([msg.key]);
          } catch (e) {
            // Silencioso — markRead não é crítico
          }
        }

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
              const mimeType = innerMsg.audioMessage?.mimetype
                            || innerMsg.pttMessage?.mimetype
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

    // ── Lida com atualizações de chaves de sinal ──────────────────────────
    // Necessário para manter a criptografia E2E sincronizada
    sock.ev.on('messaging-history.set', ({ messages: histMsgs, isLatest }) => {
      addLog('INFO', `[HISTORY] ${histMsgs?.length || 0} mensagens históricas | isLatest: ${isLatest}`);
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

  async sendAudio(instanceId, phone, audioBuffer, mimeType = 'audio/ogg; codecs=opus') {
    const inst = this.instances.get(instanceId);
    if (!inst?.sock) throw new Error('Instância não conectada');
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

    const result = await inst.sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: mimeType,
      ptt: true, // envia como mensagem de voz (PTT)
    });
    await saveMessage(instanceId, phone, 'assistant', '[Áudio 🎙️]', 'bot');
    return result;
  }

  async reconnectAll() {
    try {
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
