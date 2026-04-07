import { db }        from './db.js';
import { waManager } from './whatsapp.js';
import {
  drawTarotCards,
  transcribeAudio,
  PAYMENT_INFO,
  SPREADS,
} from './oracle.js';

// ═══════════════════════════════════════════════════════════════════════════════
// MOTOR DE 3 AGENTES COM TROCA DE CONTEXTO AUTOMÁTICA
// ═══════════════════════════════════════════════════════════════════════════════
//
// Fluxo de estágios (current_stage no banco):
//
//  [greeting] ──────────────────────────────────────────────────── AGENTE 1
//  [collecting_name] ───────────────────────────────────────────── AGENTE 1
//  [choosing_area] ─────────────────────────────────────────────── AGENTE 1
//  [choosing_spread] ───────────────────────────────────────────── AGENTE 1
//       │
//       ▼ (cliente escolhe tiragem)
//  [pending_payment] ───────────────────────────────────────────── AGENTE 2
//       │
//       ▼ (pagamento confirmado)
//  [awaiting_question] ─────────────────────────────────────────── AGENTE 3
//  [delivering_reading] ────────────────────────────────────────── AGENTE 3
//       │
//       ▼ (leitura entregue)
//  [post_reading] ──────────────────────────────────────────────── AGENTE 1
//
// Cada agente tem um agent_role no banco: 'greeter' | 'seller' | 'oracle'
// O motor busca o agente correto pelo role, não pelo flag "active" global.
// ═══════════════════════════════════════════════════════════════════════════════

// Mapa de estágio → role do agente responsável
const STAGE_TO_ROLE = {
  greeting:            'greeter',
  collecting_name:     'greeter',
  choosing_area:       'greeter',
  choosing_spread:     'greeter',
  pending_payment:     'seller',
  awaiting_question:   'oracle',
  delivering_reading:  'oracle',
  post_reading:        'greeter',
};

// Estágios que pertencem ao Agente 2 (Vendas)
const SELLER_STAGES = new Set(['pending_payment']);

// Estágios que pertencem ao Agente 3 (Oracle)
const ORACLE_STAGES = new Set(['awaiting_question', 'delivering_reading']);

class BotEngine {

  // ─── Busca agente pelo role na instância ────────────────────────────────────
  async getAgentByRole(instanceId, role) {
    const { rows } = await db.query(`
      SELECT * FROM ai_agents
      WHERE instance_id = $1 AND agent_role = $2
      ORDER BY sort_order ASC, id ASC
      LIMIT 1
    `, [instanceId, role]);
    return rows[0] || null;
  }

  // ─── Busca o agente correto para o estágio atual ────────────────────────────
  async getAgentForStage(instanceId, stage) {
    const role = STAGE_TO_ROLE[stage] || 'greeter';
    const agent = await this.getAgentByRole(instanceId, role);

    // Fallback: se não há agente com o role específico, usa o agente ativo
    if (!agent) {
      const { rows } = await db.query(`
        SELECT * FROM ai_agents
        WHERE instance_id = $1 AND active = TRUE
        LIMIT 1
      `, [instanceId]);
      return rows[0] || null;
    }
    return agent;
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

  // ─── Atualiza estágio do contato ────────────────────────────────────────────
  async setStage(contactId, stage, extraFields = {}) {
    const fields = { current_stage: stage, stage, ...extraFields };
    const keys   = Object.keys(fields);
    const vals   = Object.values(fields);
    const sets   = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    await db.query(
      `UPDATE contacts SET ${sets} WHERE id = $1`,
      [contactId, ...vals]
    );
  }

  // ─── Handler Principal ───────────────────────────────────────────────────────
  async handle(instanceId, sock, phone, text, audioBuffer = null, mimeType = null) {

    // 1. Busca ou cria contato
    const { rows } = await db.query(`
      INSERT INTO contacts (instance_id, phone, current_stage, stage)
      VALUES ($1, $2, 'greeting', 'greeting')
      ON CONFLICT (instance_id, phone) DO UPDATE SET last_seen = NOW()
      RETURNING *
    `, [instanceId, phone]);
    const contact = rows[0];

    // Garante que current_stage está preenchido (migração de contatos antigos)
    if (!contact.current_stage) {
      contact.current_stage = contact.stage || 'greeting';
      await db.query(
        `UPDATE contacts SET current_stage = $1 WHERE id = $2`,
        [contact.current_stage, contact.id]
      );
    }

    // 2. Busca o agente correto para o estágio atual
    const agent = await this.getAgentForStage(instanceId, contact.current_stage);

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

    // 5. Se não há agente configurado, usa fallback
    if (!agent) {
      await this.handleFallback(instanceId, phone, contact, messageText);
      return;
    }

    // 6. Roteamento baseado no current_stage
    try {
      const stage = contact.current_stage;

      console.log(`[BOT] inst=${instanceId} phone=${phone} stage=${stage} agent=${agent.name}(${agent.agent_role})`);

      // ── AGENTE 3: Entrega da Leitura ──────────────────────────────────────
      if (ORACLE_STAGES.has(stage)) {
        await this.handleOracle(instanceId, sock, contact, messageText, agent);
        return;
      }

      // ── AGENTE 2: Pagamento e Vendas ──────────────────────────────────────
      if (SELLER_STAGES.has(stage)) {
        await this.handleSeller(instanceId, sock, contact, messageText, agent);
        return;
      }

      // ── AGENTE 1: Saudação e Triagem ──────────────────────────────────────
      await this.handleGreeter(instanceId, sock, contact, messageText, agent);

    } catch(e) {
      console.error('[BOT ENGINE ERROR]', e.message, e.stack);
      const agentName = agent?.name || 'Lumina';
      await waManager.sendText(instanceId, phone,
        `✨ Houve um pequeno problema aqui. Tente novamente em instantes. ${agentName} está aqui. 💜`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTE 1 — Saudação e Triagem (Lumina)
  // Responsável pelos estágios: greeting, collecting_name, choosing_area,
  //                             choosing_spread, post_reading
  // ═══════════════════════════════════════════════════════════════════════════
  async handleGreeter(instanceId, sock, contact, text, agent) {
    const phone = contact.phone;
    const stage = contact.current_stage;

    // ── Detecta intenção ──────────────────────────────────────────────────
    const intent = await this.detectIntent(text, agent);
    console.log(`[GREETER] stage=${stage} intent=${intent}`);

    // ── Tenta extrair nome se ainda não temos ────────────────────────────
    if (!contact.name && (intent === 'NAME_RESPONSE' || stage === 'collecting_name')) {
      const extractedName = await this.extractName(text, agent);
      if (extractedName && extractedName.length > 1 && extractedName.length < 50) {
        await db.query(`UPDATE contacts SET name = $1 WHERE id = $2`, [extractedName, contact.id]);
        contact.name = extractedName;
        console.log(`[GREETER] Nome extraído: ${extractedName}`);
      }
    }

    // ── Detecta comprovante de pagamento (cliente pode enviar fora do fluxo) ──
    if (intent === 'PAYMENT_SENT' || this.looksLikePaymentConfirmation(text)) {
      // Redireciona para o Agente 2 para confirmar
      const sellerAgent = await this.getAgentByRole(instanceId, 'seller');
      await this.handleManualPaymentConfirmation(instanceId, contact, sellerAgent || agent);
      return;
    }

    // ── Detecta escolha de tiragem ────────────────────────────────────────
    if (intent === 'SPREAD_CHOICE' || this.looksLikeSpreadChoice(text)) {
      const spreadInfo = this.extractSpreadChoice(text);
      if (spreadInfo) {
        await this.setStage(contact.id, 'pending_payment', {
          chosen_spread: spreadInfo.key,
          chosen_amount: spreadInfo.price,
          pending_payment_since: new Date().toISOString()
        });
        contact.current_stage = 'pending_payment';
        contact.chosen_spread = spreadInfo.key;
        contact.chosen_amount = spreadInfo.price;

        // Passa o bastão para o Agente 2
        const sellerAgent = await this.getAgentByRole(instanceId, 'seller');
        await this.handleSeller(instanceId, sock, contact, text, sellerAgent || agent);
        return;
      }
    }

    // ── Determina próximo estágio ─────────────────────────────────────────
    const nextStage = this.getNextGreeterStage(stage, intent, contact);
    if (nextStage && nextStage !== stage) {
      await this.setStage(contact.id, nextStage);
      contact.current_stage = nextStage;
    }

    // ── Monta contexto e chama a IA ───────────────────────────────────────
    const history  = await this.getHistory(contact.id, 20);
    const messages = [
      ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
      { role: 'user', content: text }
    ];

    const systemPrompt = this.buildGreeterPrompt(agent, contact);
    const reply = await this.callAI(agent, systemPrompt, messages, 600);

    await waManager.sendText(instanceId, phone, reply);
    await this.saveMsg(instanceId, contact.id, 'assistant', reply, agent.id, agent.name.toLowerCase());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTE 2 — Pagamento e Vendas (Lumina Vendas)
  // Responsável pelo estágio: pending_payment
  // ═══════════════════════════════════════════════════════════════════════════
  async handleSeller(instanceId, sock, contact, text, agent) {
    const phone = contact.phone;

    // ── Detecta comprovante de pagamento ─────────────────────────────────
    const intent = await this.detectIntent(text, agent);
    const isPaymentConfirmation = intent === 'PAYMENT_SENT' || this.looksLikePaymentConfirmation(text);

    if (isPaymentConfirmation) {
      await this.handleManualPaymentConfirmation(instanceId, contact, agent);
      return;
    }

    // ── Busca histórico recente ───────────────────────────────────────────
    const history  = await this.getHistory(contact.id, 15);
    const messages = [
      ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
      { role: 'user', content: text }
    ];

    // ── Monta prompt do Agente 2 ──────────────────────────────────────────
    const systemPrompt = this.buildSellerPrompt(agent, contact);
    const reply = await this.callAI(agent, systemPrompt, messages, 500);

    await waManager.sendText(instanceId, phone, reply);
    await this.saveMsg(instanceId, contact.id, 'assistant', reply, agent.id, agent.name.toLowerCase());

    // ── Agenda remarketing em 30 minutos se ainda não foi agendado ────────
    await this.scheduleRemarketingIfNeeded(contact);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTE 3 — Entrega do Jogo (Isis / Oracle)
  // Responsável pelos estágios: awaiting_question, delivering_reading
  // ═══════════════════════════════════════════════════════════════════════════
  async handleOracle(instanceId, sock, contact, question, agent) {
    const phone        = contact.phone;
    const flowConfig   = agent.flow_config || {};
    const nameGreeting = contact.name ? ` para ${contact.name}` : '';
    const oracleName   = flowConfig.oracle_agent_name || agent.name;

    // ── Mensagem de suspense ──────────────────────────────────────────────
    const suspenseMsg = `🔮 *${oracleName} está preparando a leitura${nameGreeting}...*\n\nAs cartas estão sendo chamadas. Respire fundo e conecte-se com sua pergunta por um momento. ✨`;
    await waManager.sendText(instanceId, phone, suspenseMsg);
    await this.setStage(contact.id, 'delivering_reading');
    await new Promise(r => setTimeout(r, 3000));

    try {
      // ── Determina tipo de tiragem ─────────────────────────────────────
      let spreadType = contact.chosen_spread || '3_cards';
      if (!spreadType || spreadType === 'null') {
        const { rows: payments } = await db.query(`
          SELECT amount FROM payments
          WHERE contact_id = $1 AND status = 'CONFIRMED'
          ORDER BY confirmed_at DESC LIMIT 1
        `, [contact.id]);
        const amount = payments[0]?.amount || contact.chosen_amount || 0;
        spreadType = this.getSpreadTypeByAmount(amount);
      }

      // ── Sorteia as cartas ─────────────────────────────────────────────
      const cards = drawTarotCards(spreadType);
      console.log(`[ORACLE] ${oracleName} sorteia ${cards.length} cartas (${spreadType}) para ${phone}`);

      // ── Busca histórico e leituras anteriores ─────────────────────────
      const history = await this.getHistory(contact.id, 15);
      const { rows: pastReadings } = await db.query(`
        SELECT question, created_at FROM readings
        WHERE contact_id = $1
        ORDER BY created_at DESC LIMIT 3
      `, [contact.id]);

      const cardsText = cards.map(c =>
        `• ${c.position}: **${c.card}**${c.reversed ? ' (invertida)' : ''}`
      ).join('\n');

      const pastCtx = pastReadings.length > 0
        ? `\n\nConsultas anteriores desta pessoa:\n${pastReadings.map(r =>
            `- "${r.question}" em ${new Date(r.created_at).toLocaleDateString('pt-BR')}`
          ).join('\n')}`
        : '';

      const messages = [
        ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
        {
          role: 'user',
          content: `Minha pergunta para o Tarot: "${question}"\n\nCartas sorteadas:\n${cardsText}${pastCtx}`
        }
      ];

      // ── Monta prompt do Agente 3 ──────────────────────────────────────
      const oraclePrompt = this.buildOraclePrompt(agent, contact, spreadType);
      const interpretation = await this.callAI(agent, oraclePrompt, messages, 1800);

      // ── Salva a tiragem no banco ──────────────────────────────────────
      await db.query(`
        INSERT INTO readings (contact_id, question, spread_type, cards_drawn, interpretation)
        VALUES ($1, $2, $3, $4, $5)
      `, [contact.id, question, spreadType, JSON.stringify(cards), interpretation]);

      // ── Envia cartas sorteadas ────────────────────────────────────────
      const spreadLabel = SPREADS[spreadType]?.name || 'Tiragem';
      const cardsMsg = `🃏 *${spreadLabel} — As cartas que se apresentaram para você:*\n\n${cards.map(c =>
        `• *${c.position}:* ${c.card}${c.reversed ? ' _(invertida)_' : ''}`
      ).join('\n')}`;

      await waManager.sendText(instanceId, phone, cardsMsg);
      await new Promise(r => setTimeout(r, 2500));

      // ── Envia interpretação em partes ─────────────────────────────────
      const parts = this.splitIntoParts(interpretation, 450);
      for (const part of parts) {
        await waManager.sendText(instanceId, phone, part);
        await new Promise(r => setTimeout(r, 2000));
      }

      // ── Mensagem de encerramento ──────────────────────────────────────
      const nameClose  = contact.name ? `, ${contact.name}` : '';
      const closingMsg = flowConfig.closing_msg ||
        `🌟 Que essa leitura ilumine seu caminho${nameClose}.\n\nSe quiser explorar outro aspecto ou agendar uma nova consulta, é só me chamar. Estou aqui. 🙏✨`;
      await waManager.sendText(instanceId, phone, closingMsg);

      // ── Atualiza estágio para pós-leitura (volta ao Agente 1) ─────────
      await this.setStage(contact.id, 'post_reading', {
        remarketing_count: 0,
        chosen_spread: null,
        chosen_amount: null,
        pending_payment_since: null
      });

      // ── Salva interpretação no histórico ──────────────────────────────
      await this.saveMsg(instanceId, contact.id, 'assistant', interpretation, agent.id, agent.name.toLowerCase());

    } catch(e) {
      console.error('[ORACLE ERROR]', e.message, e.stack);
      await waManager.sendText(instanceId, phone,
        `✨ Houve um problema ao gerar sua leitura. ${oracleName} está se reconectando... Tente novamente em instantes. 🙏`
      );
      await this.setStage(contact.id, 'awaiting_question');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Confirmação Manual de Pagamento (transição Agente 2 → Agente 3)
  // ═══════════════════════════════════════════════════════════════════════════
  async handleManualPaymentConfirmation(instanceId, contact, agent) {
    const phone      = contact.phone;
    const flowConfig = agent?.flow_config || {};

    // Registra pagamento no banco
    await db.query(`
      INSERT INTO payments (instance_id, contact_id, amount, status, confirmed_at, spread_type)
      VALUES ($1, $2, $3, 'CONFIRMED', NOW(), $4)
      ON CONFLICT DO NOTHING
    `, [instanceId, contact.id, contact.chosen_amount || 0, contact.chosen_spread || '3_cards']);

    // Cancela jobs de remarketing pendentes
    await db.query(`
      UPDATE remarketing_jobs SET status = 'cancelled'
      WHERE contact_id = $1 AND status = 'pending'
    `, [contact.id]);

    // Avança para o Agente 3
    await this.setStage(contact.id, 'awaiting_question');

    const nameGreeting = contact.name ? `, ${contact.name}` : '';
    const oracleName   = flowConfig.oracle_agent_name || 'Isis';
    const confirmMsg   = flowConfig.payment_confirm_msg ||
      `🙏 Recebi seu comprovante${nameGreeting}! Muito obrigada pela confiança.\n\n✨ *${oracleName} está sendo chamada para sua leitura.*\n\nAgora, para que as cartas possam falar com precisão, me diga:\n\n*Qual é a sua pergunta ou situação que você gostaria de iluminar com o Tarot?*\n\nPode escrever com suas próprias palavras, do jeito que sair do coração. 🔮💜`;

    await waManager.sendText(instanceId, phone, confirmMsg);
    await this.saveMsg(instanceId, contact.id, 'assistant', confirmMsg, agent?.id || null, agent?.name?.toLowerCase() || 'seller');

    console.log(`[SELLER→ORACLE] Pagamento confirmado para ${phone}. Passando para ${oracleName}.`);
  }

  // ─── Fallback (sem agente configurado) ──────────────────────────────────────
  async handleFallback(instanceId, phone, contact, text) {
    const reply = `🔮 Olá! Nosso sistema está sendo configurado. Em breve estaremos prontos para atendê-lo com toda atenção que merece. 💜`;
    await waManager.sendText(instanceId, phone, reply);
    await this.saveMsg(instanceId, contact.id, 'assistant', reply, null, 'system');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILDERS DE PROMPT — cada agente tem seu prompt especializado
  // ═══════════════════════════════════════════════════════════════════════════

  buildGreeterPrompt(agent, contact) {
    const isReturning = contact.stage !== 'greeting' || contact.name;
    const nameCtx = contact.name
      ? `\n\n[CONTEXTO DO CLIENTE]\nNome: ${contact.name}\nEstágio atual: ${contact.current_stage}\nÉ cliente retornante: ${isReturning ? 'Sim' : 'Não'}\nSe for retornante, cumprimente com "Bem-vinda de volta, ${contact.name}!" de forma calorosa.`
      : `\n\n[CONTEXTO DO CLIENTE]\nNome: ainda não informado\nEstágio atual: ${contact.current_stage}\nPrimeiro contato: Sim\nPergunte o nome de forma natural na primeira oportunidade.`;

    const stageInstructions = {
      greeting:        '\n[INSTRUÇÃO]: É o primeiro contato. Dê boas-vindas calorosas e pergunte o nome.',
      collecting_name: '\n[INSTRUÇÃO]: Aguardando o nome. Se a pessoa já disse o nome, confirme e pergunte sobre a área de vida.',
      choosing_area:   '\n[INSTRUÇÃO]: Já temos o nome. Pergunte sobre a área de vida (Amor, Trabalho, Espiritualidade, Saúde, Finanças).',
      choosing_spread: '\n[INSTRUÇÃO]: Já sabemos a área de vida. Apresente as tiragens disponíveis com empatia e valores.',
      post_reading:    '\n[INSTRUÇÃO]: Leitura concluída. Pergunte se a pessoa quer explorar outro aspecto ou agendar nova consulta.',
    };

    return agent.system_prompt + nameCtx + (stageInstructions[contact.current_stage] || '');
  }

  buildSellerPrompt(agent, contact) {
    const spreadInfo = contact.chosen_spread ? SPREADS[contact.chosen_spread] : null;
    const spreadCtx  = spreadInfo
      ? `\n\n[TIRAGEM ESCOLHIDA]\nTipo: ${spreadInfo.name}\nValor: R$ ${spreadInfo.price.toFixed(2)}\nDescrição: ${spreadInfo.description}`
      : '';

    const nameCtx = contact.name
      ? `\n\n[CLIENTE]\nNome: ${contact.name}`
      : '';

    // Se o agente tem prompt customizado, usa ele; senão usa o prompt padrão de vendas
    const basePrompt = agent.system_prompt || this.defaultSellerPrompt();

    return basePrompt + nameCtx + spreadCtx +
      `\n\n[INSTRUÇÃO CRÍTICA]: O cliente escolheu a tiragem. Seu objetivo ÚNICO agora é confirmar o pagamento.
Envie os dados do Pix de forma clara. Se o cliente disser que pagou ou enviar comprovante, confirme e diga que Isis realizará a leitura.
Não fale sobre outras tiragens. Não mude de assunto. Foque apenas em fechar o pagamento.`;
  }

  buildOraclePrompt(agent, contact, spreadType) {
    const nameCtx = contact.name
      ? `\n\n[CLIENTE]\nNome: ${contact.name}\nUse o nome com carinho na abertura e na mensagem final.`
      : '';

    const spreadInfo = SPREADS[spreadType];
    const spreadCtx  = spreadInfo
      ? `\n\n[TIRAGEM]\nTipo: ${spreadInfo.name} (${spreadInfo.subtitle})\nDescrição: ${spreadInfo.description}`
      : '';

    return agent.system_prompt + nameCtx + spreadCtx +
      `\n\n[INSTRUÇÃO]: O cliente enviou a pergunta e as cartas já foram sorteadas (estão na mensagem do usuário).
Realize a leitura completa seguindo a estrutura: Abertura → Análise de cada carta → Síntese → Mensagem final.
Seja profunda, técnica e mística. Esta é a entrega do serviço pelo qual o cliente pagou.`;
  }

  defaultSellerPrompt() {
    return `Você é a responsável pelo processo de pagamento do CRM Tarot Vitória Mística.
Sua função é garantir que o cliente finalize o pagamento de forma simples e segura.

PERSONALIDADE:
- Profissional, acolhedora e direta
- Transmite confiança e segurança no processo
- Usa emojis com moderação (💳 🔮 ✨ 🙏)

DADOS DE PAGAMENTO:
Pix: vitoriamistica@gmail.com
Titular: Julia Andrade Floro

INSTRUÇÕES:
1. Confirme a tiragem escolhida e o valor
2. Envie os dados do Pix de forma clara
3. Peça para enviar o comprovante nesta conversa
4. Se o cliente tiver dúvidas sobre o pagamento, esclareça com paciência
5. Quando receber o comprovante, confirme e informe que Isis realizará a leitura

Escreva em português do Brasil. Seja direta e eficiente.`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REMARKETING — Agendamento e Envio (30 minutos sem pagamento)
  // ═══════════════════════════════════════════════════════════════════════════

  async scheduleRemarketingIfNeeded(contact) {
    // Só agenda se não há job pendente e o contador < 3
    if (contact.remarketing_count >= 3) return;

    const { rows: existing } = await db.query(`
      SELECT id FROM remarketing_jobs
      WHERE contact_id = $1 AND status = 'pending'
      LIMIT 1
    `, [contact.id]);

    if (existing.length > 0) return; // já tem job pendente

    // Agenda para 30 minutos a partir de agora
    const scheduledAt = new Date(Date.now() + 30 * 60 * 1000);
    await db.query(`
      INSERT INTO remarketing_jobs (contact_id, scheduled_at, message_type, status)
      VALUES ($1, $2, 'payment_reminder', 'pending')
    `, [contact.id, scheduledAt]);

    console.log(`[REMARKETING] Agendado para ${contact.phone} em ${scheduledAt.toISOString()}`);
  }

  // Processa jobs de remarketing pendentes (chamado pelo cron)
  async processRemarketingJobs(instanceId) {
    const { rows: jobs } = await db.query(`
      SELECT rj.*, c.phone, c.name, c.current_stage, c.remarketing_count,
             c.chosen_spread, c.instance_id
      FROM remarketing_jobs rj
      JOIN contacts c ON c.id = rj.contact_id
      WHERE rj.status = 'pending'
        AND rj.scheduled_at <= NOW()
        AND c.current_stage = 'pending_payment'
        AND c.instance_id = $1
      LIMIT 20
    `, [instanceId]);

    for (const job of jobs) {
      try {
        await this.sendRemarketingMessage(instanceId, job);
        await db.query(`
          UPDATE remarketing_jobs SET status = 'sent', sent_at = NOW() WHERE id = $1
        `, [job.id]);
        await db.query(`
          UPDATE contacts SET
            remarketing_count = remarketing_count + 1,
            last_remarketing_at = NOW()
          WHERE id = $1
        `, [job.contact_id]);
        console.log(`[REMARKETING] Enviado para ${job.phone} (tentativa ${job.remarketing_count + 1})`);
      } catch(e) {
        console.error(`[REMARKETING ERROR] ${job.phone}:`, e.message);
        await db.query(`UPDATE remarketing_jobs SET status = 'failed' WHERE id = $1`, [job.id]);
      }
    }
  }

  async sendRemarketingMessage(instanceId, job) {
    const phone        = job.phone;
    const name         = job.name;
    const count        = job.remarketing_count || 0;
    const spreadInfo   = job.chosen_spread ? SPREADS[job.chosen_spread] : null;
    const spreadName   = spreadInfo?.name || 'sua tiragem';
    const spreadPrice  = spreadInfo ? `R$ ${spreadInfo.price.toFixed(2)}` : '';

    // Busca o agente vendedor para gerar a mensagem
    const sellerAgent = await this.getAgentByRole(instanceId, 'seller');

    const nameGreeting = name ? `, ${name}` : '';

    // Mensagens progressivas de remarketing
    const templates = [
      // 1ª mensagem: lembrete gentil (30 min)
      `🌙 Olá${nameGreeting}! Notei que você ainda não finalizou ${spreadName ? `a ${spreadName}` : 'sua consulta de Tarot'}.\n\nAs cartas ainda estão esperando por você. ✨\n\nSempre que estiver pronta, é só enviar o comprovante do Pix para vitoriamistica@gmail.com${spreadPrice ? ` (${spreadPrice})` : ''} e Isis realizará sua leitura com todo cuidado. 🔮💜`,

      // 2ª mensagem: valor + urgência suave (se não pagou após 1h)
      `🔮 ${name || 'Olá'}! Ainda estou aqui, reservando um espaço especial para você.\n\nO Tarot tem uma mensagem importante esperando para ser revelada. Muitas vezes, o momento em que hesitamos é exatamente quando mais precisamos de clareza. 🌟\n\nSe tiver alguma dúvida sobre o processo ou o pagamento, pode me perguntar. Estou aqui para ajudar. 💜`,

      // 3ª mensagem: encerramento com abertura (última tentativa)
      `✨ ${name || 'Querida'}! Esta será minha última mensagem para não ser invasiva.\n\nSaiba que as cartas estarão aqui sempre que você sentir que é o momento certo. Não existe pressa no caminho espiritual. 🙏\n\nQuando quiser retomar, é só me chamar. Lumina estará aqui. 💜🌙`
    ];

    const message = templates[Math.min(count, templates.length - 1)];

    await waManager.sendText(instanceId, phone, message);

    // Salva no histórico
    const contact = { id: job.contact_id, phone };
    const { rows } = await db.query(`SELECT id FROM contacts WHERE id = $1`, [job.contact_id]);
    if (rows.length > 0) {
      await this.saveMsg(instanceId, job.contact_id, 'assistant', message,
        sellerAgent?.id || null, sellerAgent?.name?.toLowerCase() || 'remarketing');
    }

    // Agenda próxima mensagem se ainda não atingiu o limite
    if (count + 1 < 3) {
      const nextAt = new Date(Date.now() + 60 * 60 * 1000); // +1 hora
      await db.query(`
        INSERT INTO remarketing_jobs (contact_id, scheduled_at, message_type, status)
        VALUES ($1, $2, 'payment_reminder', 'pending')
      `, [job.contact_id, nextAt]);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  async getHistory(contactId, limit = 20) {
    const { rows } = await db.query(`
      SELECT role, content FROM messages
      WHERE contact_id = $1
      ORDER BY sent_at DESC LIMIT $2
    `, [contactId, limit]);
    return rows.reverse();
  }

  async detectIntent(message, agent) {
    try {
      const systemPrompt = `Classifique a intenção da mensagem em UMA das categorias abaixo. Retorne APENAS a categoria, sem explicações:
- GREETING: saudação inicial (oi, olá, bom dia, etc.)
- NAME_RESPONSE: pessoa está informando seu nome
- AREA_CHOICE: escolhendo área de vida (amor, trabalho, saúde, finanças, espiritualidade)
- SPREAD_CHOICE: escolhendo tipo de tiragem ou perguntando sobre preços/valores
- PAYMENT_SENT: enviando comprovante ou dizendo que pagou/fez o pix/transferiu
- QUESTION_FOR_READING: fazendo pergunta para a tiragem de tarot
- GENERAL: qualquer outra mensagem`;

      const result = await this.callAI(agent, systemPrompt, [{ role: 'user', content: message }], 30);
      return result.trim().toUpperCase().replace(/[^A-Z_]/g, '');
    } catch(e) {
      return 'GENERAL';
    }
  }

  async extractName(message, agent) {
    try {
      const systemPrompt = `Você é um extrator de nomes. Analise a mensagem e extraia APENAS o primeiro nome da pessoa, se ela estiver se apresentando ou respondendo a uma pergunta sobre o nome. Não retorne frases, apenas o nome ou a palavra null.`;
      const result = await this.callAI(agent, systemPrompt, [{ role: 'user', content: message }], 50);
      const extracted = result.trim().replace(/[^a-zA-ZÀ-ÿ\s]/g, '').trim();
      return extracted.toLowerCase() === 'null' || extracted.length < 2 ? null : extracted;
    } catch(e) {
      return null;
    }
  }

  extractSpreadChoice(text) {
    const lower = text.toLowerCase();
    // Detecta por palavras-chave
    if (lower.includes('mandala') || lower.includes('150') || lower.includes('60 min'))
      return { key: 'mandala', price: 150 };
    if (lower.includes('cruz') || lower.includes('céltica') || lower.includes('99'))
      return { key: 'celtic_cross', price: 99 };
    if (lower.includes('ferradura') || lower.includes('65') || lower.includes('7 cartas'))
      return { key: 'horseshoe', price: 65 };
    if (lower.includes('3 cartas') || lower.includes('35') || lower.includes('passado'))
      return { key: '3_cards', price: 35 };
    return null;
  }

  getNextGreeterStage(currentStage, intent, contact) {
    // Se já tem nome, pula a etapa de coleta
    if (currentStage === 'greeting' && contact.name) return 'choosing_area';

    const transitions = {
      greeting:        { GREETING: 'collecting_name', NAME_RESPONSE: 'choosing_area', AREA_CHOICE: 'choosing_spread' },
      collecting_name: { NAME_RESPONSE: 'choosing_area', GENERAL: 'choosing_area' },
      choosing_area:   { AREA_CHOICE: 'choosing_spread', GENERAL: 'choosing_spread' },
      choosing_spread: { SPREAD_CHOICE: 'pending_payment' },
      post_reading:    { GREETING: 'choosing_area', AREA_CHOICE: 'choosing_spread', SPREAD_CHOICE: 'pending_payment' }
    };
    return transitions[currentStage]?.[intent] || null;
  }

  getSpreadTypeByAmount(amount) {
    if (amount >= 150) return 'mandala';
    if (amount >= 99)  return 'celtic_cross';
    if (amount >= 65)  return 'horseshoe';
    return '3_cards';
  }

  looksLikePaymentConfirmation(text) {
    const keywords = ['paguei', 'pago', 'comprovante', 'transferi', 'enviei', 'fiz o pix',
                      'realizei', 'confirmado', 'já paguei', 'efetuei', 'fiz a transferência',
                      'mandei o pix', 'pixei', 'fiz o pagamento'];
    return keywords.some(k => text.toLowerCase().includes(k));
  }

  looksLikeSpreadChoice(text) {
    const keywords = ['3 cartas', 'ferradura', 'cruz céltica', 'mandala', 'r$ 35', 'r$ 65',
                      'r$ 99', 'r$ 150', 'quero a', 'escolho', 'quero fazer', 'quero o',
                      'me interessa', 'vou querer', 'quero contratar'];
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
    return parts.length > 0 ? parts : [text];
  }
}

export const botEngine = new BotEngine();
