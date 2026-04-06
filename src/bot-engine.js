import { db } from './db.js';
import { waManager } from './whatsapp.js';
import {
  generateOracleReading,
  generateReceptionResponse,
  extractNameFromMessage,
  detectIntent,
  transcribeAudio,
  PAYMENT_INFO,
  SPREADS
} from './oracle.js';

// ─── Estágios do Fluxo ────────────────────────────────────────────────────────
// start            → primeiro contato
// collecting_name  → aguardando nome
// choosing_area    → escolhendo área de vida
// choosing_spread  → escolhendo tiragem
// pending_payment  → aguardando pagamento
// awaiting_question → pagamento confirmado, aguardando pergunta
// post_reading     → leitura realizada

class BotEngine {

  // ─── Handler Principal ──────────────────────────────────────────────────────

  async handle(instanceId, sock, phone, text, audioBuffer = null, mimeType = null) {
    // 1. Busca ou cria contato
    const { rows } = await db.query(`
      INSERT INTO contacts (instance_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (instance_id, phone) DO UPDATE SET last_seen = NOW()
      RETURNING *
    `, [instanceId, phone]);
    const contact = rows[0];

    // 2. Transcreve áudio se houver
    let messageText = text;
    let isAudio = false;

    if (audioBuffer && !text) {
      isAudio = true;
      const transcription = await transcribeAudio(audioBuffer, mimeType);
      if (transcription) {
        messageText = transcription;
        // Notifica que o áudio foi entendido
        await waManager.sendText(instanceId, phone,
          `🎙️ _Ouvi seu áudio:_ "${transcription}"`
        );
        await new Promise(r => setTimeout(r, 1000));
      } else {
        await waManager.sendText(instanceId, phone,
          `🙏 Recebi seu áudio, mas tive dificuldade em entendê-lo. Poderia escrever sua mensagem? Estou aqui para ajudar. 💜`
        );
        return;
      }
    }

    if (!messageText) return;

    // 3. Salva mensagem recebida
    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent)
       VALUES ($1, $2, 'user', $3, 'user')`,
      [instanceId, contact.id, messageText]
    );

    // 4. Roteamento por estágio
    try {
      if (contact.stage === 'awaiting_question') {
        await this.handleOracleQuestion(instanceId, sock, contact, messageText);
        return;
      }

      await this.handleReception(instanceId, sock, contact, messageText);

    } catch(e) {
      console.error('[BOT ENGINE ERROR]', e.message);
      await waManager.sendText(instanceId, phone,
        `✨ Houve um pequeno problema aqui. Tente novamente em instantes. Lumina está aqui. 💜`
      );
    }
  }

  // ─── Fluxo de Recepção (Lumina) ─────────────────────────────────────────────

  async handleReception(instanceId, sock, contact, text) {
    const phone = contact.phone;

    // Detecta intenção para ações especiais
    const intent = await detectIntent(text);

    // Tenta extrair nome se ainda não temos
    if (!contact.name && (intent === 'NAME_RESPONSE' || intent === 'GREETING')) {
      const extractedName = await extractNameFromMessage(text);
      if (extractedName && extractedName.length > 1 && extractedName.length < 50) {
        await db.query(
          `UPDATE contacts SET name = $1 WHERE id = $2`,
          [extractedName, contact.id]
        );
        contact.name = extractedName; // Atualiza objeto local
      }
    }

    // Detecta envio de comprovante de pagamento
    if (intent === 'PAYMENT_SENT' || this.looksLikePaymentConfirmation(text)) {
      await this.handleManualPaymentConfirmation(instanceId, contact);
      return;
    }

    // Gera resposta via IA (Lumina)
    const reply = await generateReceptionResponse(contact, text);

    // Atualiza estágio com base na intenção
    const newStage = this.determineNextStage(contact.stage, intent);
    if (newStage && newStage !== contact.stage) {
      await db.query(
        `UPDATE contacts SET stage = $1 WHERE id = $2`,
        [newStage, contact.id]
      );
    }

    // Envia resposta
    await waManager.sendText(instanceId, phone, reply);

    // Salva resposta no log
    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent)
       VALUES ($1, $2, 'assistant', $3, 'lumina')`,
      [instanceId, contact.id, reply]
    );

    // Se escolheu tiragem, envia informações de pagamento em seguida
    if (intent === 'SPREAD_CHOICE' || this.looksLikeSpreadChoice(text)) {
      await new Promise(r => setTimeout(r, 2000));
      await waManager.sendText(instanceId, phone, PAYMENT_INFO);
      await db.query(
        `INSERT INTO messages (instance_id, contact_id, role, content, agent)
         VALUES ($1, $2, 'assistant', $3, 'lumina')`,
        [instanceId, contact.id, PAYMENT_INFO]
      );
      await db.query(
        `UPDATE contacts SET stage = 'pending_payment' WHERE id = $1`,
        [contact.id]
      );
    }
  }

  // ─── Confirmação Manual de Pagamento (via comprovante) ──────────────────────

  async handleManualPaymentConfirmation(instanceId, contact) {
    const phone = contact.phone;

    // Registra pagamento manual no banco
    await db.query(`
      INSERT INTO payments (instance_id, contact_id, amount, status, confirmed_at)
      VALUES ($1, $2, 0, 'CONFIRMED', NOW())
      ON CONFLICT DO NOTHING
    `, [instanceId, contact.id]);

    // Atualiza estágio
    await db.query(
      `UPDATE contacts SET stage = 'awaiting_question' WHERE id = $1`,
      [contact.id]
    );

    const nameGreeting = contact.name ? `, ${contact.name}` : '';
    const confirmMsg = `🙏 Recebi seu comprovante${nameGreeting}! Muito obrigada pela confiança.

✨ *Isis está sendo chamada para sua leitura.*

Agora, para que as cartas possam falar com precisão sobre o que você precisa ouvir, me diga:

*Qual é a sua pergunta ou situação que você gostaria de iluminar com o Tarot?*

Pode escrever com suas próprias palavras, do jeito que sair do coração. 🔮💜`;

    await waManager.sendText(instanceId, phone, confirmMsg);

    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent)
       VALUES ($1, $2, 'assistant', $3, 'lumina')`,
      [instanceId, contact.id, confirmMsg]
    );
  }

  // ─── Fluxo da Tiragem (Isis) ─────────────────────────────────────────────────

  async handleOracleQuestion(instanceId, sock, contact, question) {
    const phone = contact.phone;
    const nameGreeting = contact.name ? ` para ${contact.name}` : '';

    // Mensagem de suspense
    const suspenseMsg = `🔮 *Isis está preparando a leitura${nameGreeting}...*\n\nAs cartas estão sendo chamadas. Respire fundo e conecte-se com sua pergunta por um momento. ✨`;
    await waManager.sendText(instanceId, phone, suspenseMsg);
    await new Promise(r => setTimeout(r, 3000));

    try {
      // Determina tipo de tiragem com base no pagamento confirmado
      const { rows: payments } = await db.query(`
        SELECT amount FROM payments
        WHERE contact_id = $1 AND status = 'CONFIRMED'
        ORDER BY confirmed_at DESC LIMIT 1
      `, [contact.id]);

      const amount = payments[0]?.amount || 0;
      const spreadType = this.getSpreadTypeByAmount(amount);

      // Gera leitura com IA
      const { interpretation, cards } = await generateOracleReading(contact, question, spreadType);

      // Salva a tiragem
      await db.query(`
        INSERT INTO readings (contact_id, question, spread_type, cards_drawn, interpretation)
        VALUES ($1, $2, $3, $4, $5)
      `, [contact.id, question, spreadType, JSON.stringify(cards), interpretation]);

      // Envia as cartas sorteadas primeiro
      const cardsMsg = `🃏 *As cartas que se apresentaram para você:*\n\n${cards.map(c =>
        `• *${c.position}:* ${c.card}${c.reversed ? ' _(invertida)_' : ''}`
      ).join('\n')}`;

      await waManager.sendText(instanceId, phone, cardsMsg);
      await new Promise(r => setTimeout(r, 2000));

      // Envia a leitura em partes para parecer humano
      const parts = this.splitIntoParts(interpretation, 400);
      for (const part of parts) {
        await waManager.sendText(instanceId, phone, part);
        await new Promise(r => setTimeout(r, 2000));
      }

      // Mensagem de encerramento
      const nameClose = contact.name ? `, ${contact.name}` : '';
      const closingMsg = `🌟 Que essa leitura ilumine seu caminho${nameClose}.\n\nSe quiser explorar outro aspecto da sua vida ou agendar uma nova consulta, é só me chamar. Lumina e Isis estarão aqui esperando por você. 🙏✨`;
      await waManager.sendText(instanceId, phone, closingMsg);

      // Atualiza estágio
      await db.query(`UPDATE contacts SET stage = 'post_reading' WHERE id = $1`, [contact.id]);

      // Salva mensagens no log
      await db.query(
        `INSERT INTO messages (instance_id, contact_id, role, content, agent)
         VALUES ($1, $2, 'assistant', $3, 'isis')`,
        [instanceId, contact.id, interpretation]
      );

    } catch(e) {
      console.error('[ORACLE ERROR]', e.message);
      await waManager.sendText(instanceId, phone,
        `✨ Houve um problema ao gerar sua leitura. Isis está se reconectando... Tente novamente em instantes. 🙏`
      );
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  getSpreadTypeByAmount(amount) {
    if (amount >= 150) return 'mandala';
    if (amount >= 99)  return 'celtic_cross';
    if (amount >= 65)  return 'horseshoe';
    return '3_cards';
  }

  determineNextStage(currentStage, intent) {
    const transitions = {
      'start':          { 'GREETING': 'collecting_name', 'NAME_RESPONSE': 'choosing_area' },
      'collecting_name':{ 'NAME_RESPONSE': 'choosing_area', 'GENERAL': 'choosing_area' },
      'choosing_area':  { 'AREA_CHOICE': 'choosing_spread' },
      'choosing_spread':{ 'SPREAD_CHOICE': 'pending_payment' },
      'post_reading':   { 'GREETING': 'choosing_area', 'AREA_CHOICE': 'choosing_spread' }
    };
    return transitions[currentStage]?.[intent] || null;
  }

  looksLikePaymentConfirmation(text) {
    const keywords = ['paguei', 'pago', 'comprovante', 'transferi', 'enviei', 'fiz o pix', 'realizei', 'confirmado', 'já paguei'];
    const lower = text.toLowerCase();
    return keywords.some(k => lower.includes(k));
  }

  looksLikeSpreadChoice(text) {
    const keywords = ['3 cartas', 'ferradura', 'cruz céltica', 'mandala', 'r$ 35', 'r$ 65', 'r$ 99', 'r$ 150', 'quero a', 'escolho', 'quero fazer'];
    const lower = text.toLowerCase();
    return keywords.some(k => lower.includes(k));
  }

  splitIntoParts(text, maxLength) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const parts = [];
    let current = '';
    for (const s of sentences) {
      if ((current + s).length > maxLength) {
        if (current) parts.push(current.trim());
        current = s;
      } else {
        current += (current ? ' ' : '') + s;
      }
    }
    if (current) parts.push(current.trim());
    return parts;
  }
}

export const botEngine = new BotEngine();
