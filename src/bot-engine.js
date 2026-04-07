import { db }        from './db.js';
import { waManager } from './whatsapp.js';
import {
  drawTarotCards,
  transcribeAudio,
  PAYMENT_INFO,
} from './oracle.js';

// ─── Motor de Bot Dinâmico ────────────────────────────────────────────────────
// Lê o agente ATIVO do banco a cada mensagem, sem cache em memória.
// Isso garante que trocar o agente ativo no painel surta efeito imediatamente.

class BotEngine {

  // ─── Busca o agente ativo da instância ──────────────────────────────────────
  async getActiveAgent(instanceId) {
    const { rows } = await db.query(`
      SELECT * FROM ai_agents
      WHERE instance_id = $1 AND active = TRUE
      LIMIT 1
    `, [instanceId]);
    return rows[0] || null;
  }

  // ─── Chama a IA com o provider/modelo/prompt do agente ──────────────────────
  async callAI(agent, systemPrompt, messages, maxTokens = 600) {
    const provider = agent.provider || 'anthropic';
    const model    = agent.model    || 'claude-haiku-4-5';

    if (provider === 'anthropic') {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const apiKey    = agent.api_key || process.env.ANTHROPIC_API_KEY;
      const ai        = new Anthropic({ apiKey });

      const response = await ai.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages
      });
      return response.content[0].text;

    } else if (provider === 'openai') {
      const OpenAI = (await import('openai')).default;
      const apiKey = agent.api_key || process.env.OPENAI_API_KEY;
      const ai     = new OpenAI({ apiKey });

      const allMessages = [
        { role: 'system', content: systemPrompt },
        ...messages
      ];
      const response = await ai.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: allMessages
      });
      return response.choices[0].message.content;

    } else {
      throw new Error(`Provider desconhecido: ${provider}`);
    }
  }

  // ─── Salva mensagem associada ao agente ─────────────────────────────────────
  async saveMsg(instanceId, contactId, role, content, agentId = null, agentName = 'bot') {
    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [instanceId, contactId, role, content, agentName, agentId]
    );
  }

  // ─── Handler Principal ───────────────────────────────────────────────────────
  async handle(instanceId, sock, phone, text, audioBuffer = null, mimeType = null) {

    // 1. Busca ou cria contato
    const { rows } = await db.query(`
      INSERT INTO contacts (instance_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (instance_id, phone) DO UPDATE SET last_seen = NOW()
      RETURNING *
    `, [instanceId, phone]);
    const contact = rows[0];

    // 2. Busca agente ativo
    const agent = await this.getActiveAgent(instanceId);

    // 3. Transcreve áudio se houver
    let messageText = text;
    if (audioBuffer && !text) {
      const transcription = await transcribeAudio(audioBuffer, mimeType);
      if (transcription) {
        messageText = transcription;
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

    // 4. Salva mensagem do usuário
    await this.saveMsg(instanceId, contact.id, 'user', messageText, agent?.id || null, 'user');

    // 5. Se não há agente ativo, usa fallback padrão
    if (!agent) {
      await this.handleFallback(instanceId, phone, contact, messageText);
      return;
    }

    // 6. Roteamento baseado no flow_config do agente
    try {
      const flowConfig = agent.flow_config || {};

      // Modo "oracle" — agente de leitura de tarot
      if (contact.stage === 'awaiting_question' && flowConfig.enable_oracle) {
        await this.handleOracleQuestion(instanceId, sock, contact, messageText, agent);
        return;
      }

      // Modo padrão — recepção/conversa
      await this.handleConversation(instanceId, sock, contact, messageText, agent);

    } catch(e) {
      console.error('[BOT ENGINE ERROR]', e.message);
      const agentName = agent?.name || 'Lumina';
      await waManager.sendText(instanceId, phone,
        `✨ Houve um pequeno problema aqui. Tente novamente em instantes. ${agentName} está aqui. 💜`
      );
    }
  }

  // ─── Conversa Dinâmica com o Agente ─────────────────────────────────────────
  async handleConversation(instanceId, sock, contact, text, agent) {
    const phone      = contact.phone;
    const flowConfig = agent.flow_config || {};

    // Detecta intenção (se o agente tiver fluxo de pagamento habilitado)
    let intent = 'GENERAL';
    if (flowConfig.enable_payment_flow) {
      intent = await this.detectIntent(text, agent);
    }

    // Tenta extrair nome se ainda não temos
    if (!contact.name && (intent === 'NAME_RESPONSE' || intent === 'GREETING')) {
      const extractedName = await this.extractName(text, agent);
      if (extractedName && extractedName.length > 1 && extractedName.length < 50) {
        await db.query(`UPDATE contacts SET name = $1 WHERE id = $2`, [extractedName, contact.id]);
        contact.name = extractedName;
      }
    }

    // Detecta comprovante de pagamento
    if (flowConfig.enable_payment_flow &&
        (intent === 'PAYMENT_SENT' || this.looksLikePaymentConfirmation(text))) {
      await this.handleManualPaymentConfirmation(instanceId, contact, agent);
      return;
    }

    // Busca histórico recente para contexto
    const { rows: history } = await db.query(`
      SELECT role, content FROM messages
      WHERE contact_id = $1
      ORDER BY sent_at DESC LIMIT 20
    `, [contact.id]);

    const messages = [
      ...history.reverse().map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content
      })),
      { role: 'user', content: text }
    ];

    // Monta o system prompt com contexto do contato
    const systemPrompt = this.buildSystemPrompt(agent, contact);

    // Chama a IA
    const reply = await this.callAI(agent, systemPrompt, messages, 600);

    // Atualiza estágio se necessário
    if (flowConfig.enable_payment_flow) {
      const newStage = this.determineNextStage(contact.stage, intent);
      if (newStage && newStage !== contact.stage) {
        await db.query(`UPDATE contacts SET stage = $1 WHERE id = $2`, [newStage, contact.id]);
      }
    }

    // Envia resposta
    await waManager.sendText(instanceId, phone, reply);

    // Salva resposta associada ao agente
    await this.saveMsg(instanceId, contact.id, 'assistant', reply, agent.id, agent.name.toLowerCase());

    // Se escolheu tiragem e fluxo de pagamento ativo, envia info de pagamento
    if (flowConfig.enable_payment_flow &&
        (intent === 'SPREAD_CHOICE' || this.looksLikeSpreadChoice(text))) {
      const paymentInfo = flowConfig.payment_info || PAYMENT_INFO;
      await new Promise(r => setTimeout(r, 2000));
      await waManager.sendText(instanceId, phone, paymentInfo);
      await this.saveMsg(instanceId, contact.id, 'assistant', paymentInfo, agent.id, agent.name.toLowerCase());
      await db.query(`UPDATE contacts SET stage = 'pending_payment' WHERE id = $1`, [contact.id]);
    }
  }

  // ─── Confirmação Manual de Pagamento ────────────────────────────────────────
  async handleManualPaymentConfirmation(instanceId, contact, agent) {
    const phone = contact.phone;

    await db.query(`
      INSERT INTO payments (instance_id, contact_id, amount, status, confirmed_at)
      VALUES ($1, $2, 0, 'CONFIRMED', NOW())
      ON CONFLICT DO NOTHING
    `, [instanceId, contact.id]);

    await db.query(`UPDATE contacts SET stage = 'awaiting_question' WHERE id = $1`, [contact.id]);

    const flowConfig    = agent.flow_config || {};
    const nameGreeting  = contact.name ? `, ${contact.name}` : '';
    const oracleName    = flowConfig.oracle_agent_name || 'Isis';
    const confirmMsg    = flowConfig.payment_confirm_msg ||
      `🙏 Recebi seu comprovante${nameGreeting}! Muito obrigada pela confiança.\n\n✨ *${oracleName} está sendo chamada para sua leitura.*\n\nAgora, para que as cartas possam falar com precisão, me diga:\n\n*Qual é a sua pergunta ou situação que você gostaria de iluminar com o Tarot?*\n\nPode escrever com suas próprias palavras, do jeito que sair do coração. 🔮💜`;

    await waManager.sendText(instanceId, phone, confirmMsg);
    await this.saveMsg(instanceId, contact.id, 'assistant', confirmMsg, agent.id, agent.name.toLowerCase());
  }

  // ─── Fluxo da Tiragem (Oracle) ───────────────────────────────────────────────
  async handleOracleQuestion(instanceId, sock, contact, question, agent) {
    const phone      = contact.phone;
    const flowConfig = agent.flow_config || {};
    const nameGreeting = contact.name ? ` para ${contact.name}` : '';
    const oracleName   = flowConfig.oracle_agent_name || agent.name;

    // Mensagem de suspense
    const suspenseMsg = `🔮 *${oracleName} está preparando a leitura${nameGreeting}...*\n\nAs cartas estão sendo chamadas. Respire fundo e conecte-se com sua pergunta por um momento. ✨`;
    await waManager.sendText(instanceId, phone, suspenseMsg);
    await new Promise(r => setTimeout(r, 3000));

    try {
      // Determina tipo de tiragem com base no pagamento
      const { rows: payments } = await db.query(`
        SELECT amount FROM payments
        WHERE contact_id = $1 AND status = 'CONFIRMED'
        ORDER BY confirmed_at DESC LIMIT 1
      `, [contact.id]);

      const amount     = payments[0]?.amount || 0;
      const spreadType = this.getSpreadTypeByAmount(amount);
      const cards      = drawTarotCards(spreadType);

      // Busca histórico
      const { rows: history } = await db.query(`
        SELECT role, content FROM messages
        WHERE contact_id = $1
        ORDER BY sent_at DESC LIMIT 15
      `, [contact.id]);

      const { rows: pastReadings } = await db.query(`
        SELECT question, created_at FROM readings
        WHERE contact_id = $1
        ORDER BY created_at DESC LIMIT 3
      `, [contact.id]);

      const cardsText  = cards.map(c => `• ${c.position}: **${c.card}**${c.reversed ? ' (invertida)' : ''}`).join('\n');
      const pastCtx    = pastReadings.length > 0
        ? `\n\nConsultas anteriores:\n${pastReadings.map(r => `- "${r.question}" em ${new Date(r.created_at).toLocaleDateString('pt-BR')}`).join('\n')}`
        : '';

      const messages = [
        ...history.reverse().map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
        { role: 'user', content: `Pergunta: "${question}"\n\nCartas sorteadas:\n${cardsText}${pastCtx}\n\nPor favor, faça a leitura completa.` }
      ];

      // Usa o system_prompt do agente (ou o prompt de oracle do flow_config)
      const oraclePrompt = flowConfig.oracle_system_prompt || agent.system_prompt;
      const interpretation = await this.callAI(agent, oraclePrompt, messages, 1500);

      // Salva a tiragem
      await db.query(`
        INSERT INTO readings (contact_id, question, spread_type, cards_drawn, interpretation)
        VALUES ($1, $2, $3, $4, $5)
      `, [contact.id, question, spreadType, JSON.stringify(cards), interpretation]);

      // Envia cartas sorteadas
      const cardsMsg = `🃏 *As cartas que se apresentaram para você:*\n\n${cards.map(c =>
        `• *${c.position}:* ${c.card}${c.reversed ? ' _(invertida)_' : ''}`
      ).join('\n')}`;

      await waManager.sendText(instanceId, phone, cardsMsg);
      await new Promise(r => setTimeout(r, 2000));

      // Envia leitura em partes
      const parts = this.splitIntoParts(interpretation, 400);
      for (const part of parts) {
        await waManager.sendText(instanceId, phone, part);
        await new Promise(r => setTimeout(r, 2000));
      }

      // Mensagem de encerramento
      const nameClose  = contact.name ? `, ${contact.name}` : '';
      const closingMsg = flowConfig.closing_msg ||
        `🌟 Que essa leitura ilumine seu caminho${nameClose}.\n\nSe quiser explorar outro aspecto ou agendar uma nova consulta, é só me chamar. 🙏✨`;
      await waManager.sendText(instanceId, phone, closingMsg);

      // Atualiza estágio
      await db.query(`UPDATE contacts SET stage = 'post_reading' WHERE id = $1`, [contact.id]);

      // Salva no histórico com agente associado
      await this.saveMsg(instanceId, contact.id, 'assistant', interpretation, agent.id, agent.name.toLowerCase());

    } catch(e) {
      console.error('[ORACLE ERROR]', e.message);
      await waManager.sendText(instanceId, phone,
        `✨ Houve um problema ao gerar sua leitura. ${oracleName} está se reconectando... Tente novamente em instantes. 🙏`
      );
    }
  }

  // ─── Fallback (sem agente ativo) ─────────────────────────────────────────────
  async handleFallback(instanceId, phone, contact, text) {
    const reply = `🔮 Olá! Nosso sistema está sendo configurado. Em breve estaremos prontos para atendê-lo com toda atenção que merece. 💜`;
    await waManager.sendText(instanceId, phone, reply);
    await this.saveMsg(instanceId, contact.id, 'assistant', reply, null, 'system');
  }

  // ─── Monta System Prompt com contexto do contato ────────────────────────────
  buildSystemPrompt(agent, contact) {
    let prompt = agent.system_prompt;

    // Injeta contexto do contato no prompt
    const nameCtx = contact.name
      ? `\n\n[CONTEXTO: O nome desta pessoa é ${contact.name}. Use o nome dela de forma natural e acolhedora.]`
      : `\n\n[CONTEXTO: Você ainda não sabe o nome desta pessoa. Pergunte de forma natural na primeira oportunidade.]`;

    const stageCtx = contact.stage
      ? `\n[ESTÁGIO ATUAL: ${contact.stage}]`
      : '';

    return prompt + nameCtx + stageCtx;
  }

  // ─── Detecta Intenção via IA ─────────────────────────────────────────────────
  async detectIntent(message, agent) {
    try {
      const systemPrompt = `Classifique a intenção da mensagem em UMA das categorias abaixo. Retorne APENAS a categoria, sem explicações:
- GREETING: saudação inicial (oi, olá, bom dia, etc.)
- NAME_RESPONSE: pessoa está informando seu nome
- AREA_CHOICE: escolhendo área de vida (amor, trabalho, saúde, finanças, espiritualidade)
- SPREAD_CHOICE: escolhendo tipo de tiragem ou perguntando sobre preços
- PAYMENT_SENT: enviando comprovante ou dizendo que pagou
- QUESTION_FOR_READING: fazendo pergunta para a tiragem de tarot
- GENERAL: qualquer outra mensagem`;

      const result = await this.callAI(agent, systemPrompt, [{ role: 'user', content: message }], 30);
      return result.trim();
    } catch(e) {
      return 'GENERAL';
    }
  }

  // ─── Extrai Nome via IA ──────────────────────────────────────────────────────
  async extractName(message, agent) {
    try {
      const systemPrompt = `Você é um extrator de nomes. Analise a mensagem e extraia APENAS o primeiro nome da pessoa, se ela estiver se apresentando ou respondendo a uma pergunta sobre o nome. Não retorne frases, apenas o nome ou a palavra null.`;
      const result = await this.callAI(agent, systemPrompt, [{ role: 'user', content: message }], 50);
      const extracted = result.trim();
      return extracted === 'null' ? null : extracted;
    } catch(e) {
      return null;
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
      'start':           { 'GREETING': 'collecting_name', 'NAME_RESPONSE': 'choosing_area' },
      'collecting_name': { 'NAME_RESPONSE': 'choosing_area', 'GENERAL': 'choosing_area' },
      'choosing_area':   { 'AREA_CHOICE': 'choosing_spread' },
      'choosing_spread': { 'SPREAD_CHOICE': 'pending_payment' },
      'post_reading':    { 'GREETING': 'choosing_area', 'AREA_CHOICE': 'choosing_spread' }
    };
    return transitions[currentStage]?.[intent] || null;
  }

  looksLikePaymentConfirmation(text) {
    const keywords = ['paguei', 'pago', 'comprovante', 'transferi', 'enviei', 'fiz o pix', 'realizei', 'confirmado', 'já paguei'];
    return keywords.some(k => text.toLowerCase().includes(k));
  }

  looksLikeSpreadChoice(text) {
    const keywords = ['3 cartas', 'ferradura', 'cruz céltica', 'mandala', 'r$ 35', 'r$ 65', 'r$ 99', 'r$ 150', 'quero a', 'escolho', 'quero fazer'];
    return keywords.some(k => text.toLowerCase().includes(k));
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
