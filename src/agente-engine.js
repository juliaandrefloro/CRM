/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AGENTE ENGINE v4 — Fábrica de Agentes Dinâmica
 *  ─────────────────────────────────────────────────────────────────────────
 *  Motor de bot 100% dinâmico baseado na tabela `agentes_config`.
 *  Nenhuma frase, prompt ou configuração está fixada neste código.
 *  Tudo é editável pelo painel administrativo sem deploy.
 *
 *  State Machine por `status_atendimento` (coluna em `contacts`):
 *    'saudacao'  → Agente com slug='saudacao'
 *    'pagamento' → Agente com slug='pagamento'
 *    'entrega'   → Agente com slug='entrega'
 *
 *  Transições automáticas:
 *    saudacao  → pagamento  (cliente escolhe tiragem)
 *    pagamento → entrega    (comprovante recebido)
 *    entrega   → saudacao   (leitura concluída)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { db } from './db.js';

// ─── Baralho de Tarot completo (78 cartas) ────────────────────────────────────
const TAROT_CARDS = [
  'O Louco','O Mago','A Sacerdotisa','A Imperatriz','O Imperador',
  'O Hierofante','Os Enamorados','O Carro','A Força','O Eremita',
  'A Roda da Fortuna','A Justiça','O Enforcado','A Morte','A Temperança',
  'O Diabo','A Torre','A Estrela','A Lua','O Sol','O Julgamento','O Mundo',
  'Ás de Paus','2 de Paus','3 de Paus','4 de Paus','5 de Paus','6 de Paus',
  '7 de Paus','8 de Paus','9 de Paus','10 de Paus','Valete de Paus',
  'Cavaleiro de Paus','Rainha de Paus','Rei de Paus',
  'Ás de Copas','2 de Copas','3 de Copas','4 de Copas','5 de Copas','6 de Copas',
  '7 de Copas','8 de Copas','9 de Copas','10 de Copas','Valete de Copas',
  'Cavaleiro de Copas','Rainha de Copas','Rei de Copas',
  'Ás de Espadas','2 de Espadas','3 de Espadas','4 de Espadas','5 de Espadas',
  '6 de Espadas','7 de Espadas','8 de Espadas','9 de Espadas','10 de Espadas',
  'Valete de Espadas','Cavaleiro de Espadas','Rainha de Espadas','Rei de Espadas',
  'Ás de Ouros','2 de Ouros','3 de Ouros','4 de Ouros','5 de Ouros','6 de Ouros',
  '7 de Ouros','8 de Ouros','9 de Ouros','10 de Ouros','Valete de Ouros',
  'Cavaleiro de Ouros','Rainha de Ouros','Rei de Ouros',
];

const SPREAD_POSITIONS = {
  '3_cards':     ['Passado', 'Presente', 'Futuro'],
  'horseshoe':   ['Passado','Presente','Futuro próximo','Conselho','Influências externas','Esperanças/Medos','Resultado'],
  'celtic_cross': ['Situação atual','Desafio','Passado distante','Passado recente','Melhor resultado','Futuro próximo','Você mesmo','Ambiente','Esperanças/Medos','Resultado final'],
  'mandala':     ['Centro (você agora)','Desafio principal','Raiz do problema','Passado recente','Passado distante','Futuro próximo','Futuro distante','Ambiente','Esperanças','Medos','Resultado','Conselho final'],
};

// ─── Classe principal ─────────────────────────────────────────────────────────
class AgenteEngine {

  // ═══════════════════════════════════════════════════════════════════════════
  // PONTO DE ENTRADA
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Processa mensagem e retorna array de textos para enviar.
   * @param {number} instanceId
   * @param {string} phone
   * @param {string} text
   * @param {object|null} media - { type, buffer, mimeType }
   * @returns {Promise<string[]>}
   */
  async handle(instanceId, phone, text, media = null) {
    try {
      // 1. Upsert do contato
      const contact = await this.upsertContact(instanceId, phone);

      // 2. Determina o status atual
      const status = contact.status_atendimento || 'saudacao';

      // 3. Busca o agente configurado para este status
      const agente = await this.getAgente(instanceId, status);

      // 4. Salva mensagem do usuário
      await this.saveMsg(instanceId, contact.id, 'user', text, status);

      // 5. Roteamento pela state machine
      let respostas = [];
      switch (status) {
        case 'saudacao':
          respostas = await this.handleSaudacao(instanceId, contact, text, agente);
          break;
        case 'pagamento':
          respostas = await this.handlePagamento(instanceId, contact, text, media, agente);
          break;
        case 'entrega':
          respostas = await this.handleEntrega(instanceId, contact, text, agente);
          break;
        default:
          await this.setStatus(contact.id, 'saudacao');
          respostas = await this.handleSaudacao(instanceId, contact, text, agente);
      }

      // 6. Salva respostas do bot
      for (const r of respostas) {
        await this.saveMsg(instanceId, contact.id, 'assistant', r, status);
      }

      // 7. Atualiza métricas
      await this.updatePerf(instanceId, status, 'received');

      return respostas;
    } catch (err) {
      console.error('[AGENTE ENGINE ERROR]', err.message);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTE 1 — SAUDAÇÃO E TRIAGEM
  // ═══════════════════════════════════════════════════════════════════════════
  async handleSaudacao(instanceId, contact, text, agente) {
    if (!agente) return this.fallback(contact.name);

    // Detecta escolha de tiragem → transiciona para pagamento
    const spread = this.detectSpread(text);
    if (spread) {
      await db.query(
        `UPDATE contacts SET
           status_atendimento='pagamento', current_stage='pending_payment',
           chosen_spread=$1, chosen_amount=$2, pending_payment_since=NOW()
         WHERE id=$3`,
        [spread.key, spread.price, contact.id]
      );
      await this.updatePerf(instanceId, 'saudacao', 'conversion');
      await this.scheduleRemarketing(instanceId, contact.id);

      // Passa para Agente 2
      const agenteVendas = await this.getAgente(instanceId, 'pagamento');
      const updated = { ...contact, status_atendimento: 'pagamento', chosen_spread: spread.key, chosen_amount: spread.price };
      return this.handlePagamento(instanceId, updated, text, null, agenteVendas);
    }

    // Chama a IA
    const history = await this.getHistory(contact.id, 15);
    const ctx = this.buildCtx(contact, text);
    const resp = await this.callIA(agente, history, ctx);
    const { clean, transition } = this.parseTransition(resp);
    if (transition === 'pagamento') await this.setStatus(contact.id, 'pagamento');
    return this.split(clean);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTE 2 — PAGAMENTO E VENDAS
  // ═══════════════════════════════════════════════════════════════════════════
  async handlePagamento(instanceId, contact, text, media, agente) {
    if (!agente) return this.fallback(contact.name);

    // Detecta comprovante (imagem ou texto)
    const isPago = (media?.type === 'image') || this.detectPagamento(text);
    if (isPago) {
      await db.query(
        `UPDATE contacts SET
           status_atendimento='entrega', current_stage='awaiting_question',
           pending_payment_since=NULL
         WHERE id=$1`,
        [contact.id]
      );
      await db.query(
        `UPDATE remarketing_jobs SET status='cancelled'
         WHERE contact_id=$1 AND status='pending'`,
        [contact.id]
      );
      await this.updatePerf(instanceId, 'pagamento', 'conversion');

      // Passa para Agente 3
      const agenteOracle = await this.getAgente(instanceId, 'entrega');
      const updated = { ...contact, status_atendimento: 'entrega', current_stage: 'awaiting_question' };
      return this.handleEntrega(instanceId, updated, text, agenteOracle);
    }

    // Chama a IA
    const history = await this.getHistory(contact.id, 10);
    const ctx = this.buildCtx(contact, text);
    const resp = await this.callIA(agente, history, ctx);
    const { clean } = this.parseTransition(resp);
    return this.split(clean);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGENTE 3 — ENTREGA DO JOGO
  // ═══════════════════════════════════════════════════════════════════════════
  async handleEntrega(instanceId, contact, text, agente) {
    if (!agente) return this.fallback(contact.name);

    const stage = contact.current_stage || 'awaiting_question';

    if (stage === 'awaiting_question') {
      // A mensagem atual É a pergunta para o Tarot
      await db.query(
        `UPDATE contacts SET current_stage='delivering_reading' WHERE id=$1`,
        [contact.id]
      );

      // Sorteia cartas
      const spreadType = contact.chosen_spread || '3_cards';
      const cards = this.drawCards(spreadType);
      const cardsText = cards.map(c =>
        `• ${c.position}: **${c.card}**${c.reversed ? ' (invertida)' : ''}`
      ).join('\n');

      // Salva a tiragem
      await db.query(
        `INSERT INTO readings (contact_id, question, spread_type, cards_drawn)
         VALUES ($1, $2, $3, $4)`,
        [contact.id, text, spreadType, JSON.stringify(cards)]
      );

      // Chama a IA com as cartas
      const history = await this.getHistory(contact.id, 10);
      const ctx = `Pergunta da consulta: "${text}"\n\nCartas sorteadas:\n${cardsText}\n\nRealize a leitura completa.`;
      const resp = await this.callIA(agente, history, ctx, 1500);
      const { clean } = this.parseTransition(resp);

      // Após leitura, volta para saudacao
      await db.query(
        `UPDATE contacts SET current_stage='post_reading', status_atendimento='saudacao' WHERE id=$1`,
        [contact.id]
      );
      await this.updatePerf(instanceId, 'entrega', 'conversion');

      return this.split(clean);
    }

    // Pós-leitura: conversa livre
    const history = await this.getHistory(contact.id, 15);
    const ctx = this.buildCtx(contact, text);
    const resp = await this.callIA(agente, history, ctx);
    const { clean, transition } = this.parseTransition(resp);
    if (transition === 'saudacao') await this.setStatus(contact.id, 'saudacao');
    return this.split(clean);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTEGRAÇÃO DINÂMICA COM IA — lê tudo de agentes_config
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Busca agente pelo slug (status_atendimento) na tabela agentes_config.
   * Totalmente dinâmico — sem hardcode.
   */
  async getAgente(instanceId, slug) {
    try {
      const { rows } = await db.query(
        `SELECT * FROM agentes_config WHERE instance_id=$1 AND slug=$2 AND ativo=TRUE LIMIT 1`,
        [instanceId, slug]
      );
      return rows[0] || null;
    } catch (e) {
      console.error('[GET AGENTE ERROR]', e.message);
      return null;
    }
  }

  /**
   * Chama a API de IA usando as configurações do agente.
   * Suporta Anthropic e OpenAI — provider lido do banco.
   */
  async callIA(agente, history, userMessage, maxTokens = null) {
    const model       = agente.model       || 'claude-haiku-4-5';
    const provider    = agente.provider    || 'anthropic';
    const apiKey      = agente.api_key     || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
    const temperature = parseFloat(agente.temperature) || 0.7;
    const tokens      = maxTokens || parseInt(agente.max_tokens) || 800;
    const systemPrompt = agente.system_prompt || 'Você é um assistente prestativo. Responda em português do Brasil.';

    const messages = [
      ...history.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
      { role: 'user', content: userMessage }
    ];

    console.log(`[CALL IA] agente=${agente.slug} model=${model} provider=${provider} tokens=${tokens}`);

    if (provider === 'openai') {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey });
      const resp = await client.chat.completions.create({
        model, max_tokens: tokens, temperature,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
      });
      return resp.choices[0].message.content;
    } else {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model, max_tokens: tokens, temperature, system: systemPrompt, messages,
      });
      return resp.content[0].text;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REMARKETING — templates editáveis pelo painel
  // ═══════════════════════════════════════════════════════════════════════════

  async scheduleRemarketing(instanceId, contactId) {
    try {
      // Cancela jobs anteriores
      await db.query(
        `UPDATE remarketing_jobs SET status='cancelled' WHERE contact_id=$1 AND status='pending'`,
        [contactId]
      );

      // Busca templates ativos
      const { rows: templates } = await db.query(
        `SELECT * FROM remarketing_templates WHERE instance_id=$1 AND ativo=TRUE ORDER BY ordem ASC`,
        [instanceId]
      );

      if (templates.length === 0) {
        // Fallback: 1 job em 30 min
        const at = new Date(Date.now() + 30 * 60 * 1000);
        await db.query(
          `INSERT INTO remarketing_jobs (contact_id, scheduled_at, message_type, status)
           VALUES ($1, $2, 'lembrete_padrao', 'pending')`,
          [contactId, at]
        );
        return;
      }

      for (const tpl of templates) {
        const at = new Date(Date.now() + tpl.delay_minutos * 60 * 1000);
        await db.query(
          `INSERT INTO remarketing_jobs (contact_id, scheduled_at, message_type, status)
           VALUES ($1, $2, $3, 'pending')`,
          [contactId, at, tpl.slug]
        );
      }
    } catch (e) {
      console.error('[SCHEDULE REMARKETING ERROR]', e.message);
    }
  }

  async processRemarketingJobs(instanceId) {
    try {
      const { rows: jobs } = await db.query(`
        SELECT rj.*, c.phone, c.name, c.status_atendimento, c.chosen_spread, c.chosen_amount
        FROM remarketing_jobs rj
        JOIN contacts c ON c.id = rj.contact_id
        WHERE c.instance_id = $1
          AND rj.status = 'pending'
          AND rj.scheduled_at <= NOW()
          AND c.status_atendimento = 'pagamento'
        ORDER BY rj.scheduled_at ASC
        LIMIT 20
      `, [instanceId]);

      for (const job of jobs) {
        let mensagem = null;

        // Busca template pelo slug
        if (job.message_type) {
          const { rows: tpls } = await db.query(
            `SELECT mensagem FROM remarketing_templates WHERE instance_id=$1 AND slug=$2 LIMIT 1`,
            [instanceId, job.message_type]
          );
          if (tpls.length) mensagem = tpls[0].mensagem;
        }

        // Substitui variáveis no template
        if (mensagem) {
          mensagem = mensagem
            .replace(/\{nome\}/gi, job.name || 'querida')
            .replace(/\{tiragem\}/gi, job.chosen_spread || 'tiragem')
            .replace(/\{valor\}/gi, job.chosen_amount ? `R$ ${parseFloat(job.chosen_amount).toFixed(2)}` : '');
        } else {
          mensagem = `Olá${job.name ? ', ' + job.name : ''}! 🌙 Sua consulta de Tarot ainda está reservada. Quando quiser prosseguir, é só me avisar. 💜`;
        }

        // Envia via WhatsApp
        const { waManager } = await import('./whatsapp.js');
        const sock = waManager.getSock(instanceId);
        if (sock) {
          const jid = job.phone.includes('@') ? job.phone : `${job.phone}@s.whatsapp.net`;
          await sock.sendMessage(jid, { text: mensagem });
          await this.saveMsg(instanceId, job.contact_id, 'assistant', mensagem, 'pagamento');
        }

        await db.query(
          `UPDATE remarketing_jobs SET status='sent', sent_at=NOW() WHERE id=$1`,
          [job.id]
        );
      }
    } catch (e) {
      console.error('[REMARKETING JOBS ERROR]', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  async upsertContact(instanceId, phone) {
    const { rows } = await db.query(`
      INSERT INTO contacts (instance_id, phone, last_seen, status_atendimento, current_stage)
      VALUES ($1, $2, NOW(), 'saudacao', 'greeting')
      ON CONFLICT (instance_id, phone) DO UPDATE SET last_seen = NOW()
      RETURNING *
    `, [instanceId, phone]);
    return rows[0];
  }

  async setStatus(contactId, status) {
    await db.query(
      `UPDATE contacts SET status_atendimento=$1 WHERE id=$2`,
      [status, contactId]
    );
  }

  async saveMsg(instanceId, contactId, role, content, agenteSlug = 'bot') {
    try {
      await db.query(
        `INSERT INTO messages (instance_id, contact_id, role, content, agent, sent_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [instanceId, contactId, role, content, agenteSlug]
      );
    } catch (e) {
      console.error('[SAVE MSG ERROR]', e.message);
    }
  }

  async getHistory(contactId, limit = 15) {
    const { rows } = await db.query(`
      SELECT role, content FROM messages
      WHERE contact_id = $1
      ORDER BY sent_at DESC LIMIT $2
    `, [contactId, limit]);
    return rows.reverse();
  }

  async updatePerf(instanceId, slug, tipo) {
    try {
      const col = tipo === 'conversion' ? 'conversoes'
                : tipo === 'sent'       ? 'mensagens_enviadas'
                : 'mensagens_recebidas';
      await db.query(`
        INSERT INTO agent_performance (agente_slug, instance_id, data, ${col})
        VALUES ($1, $2, CURRENT_DATE, 1)
        ON CONFLICT (agente_slug, instance_id, data)
        DO UPDATE SET ${col} = agent_performance.${col} + 1
      `, [slug, instanceId]);
    } catch (e) { /* silencioso */ }
  }

  buildCtx(contact, text) {
    const parts = [`Mensagem: "${text}"`];
    if (contact.name) parts.push(`Nome do cliente: ${contact.name}`);
    if (contact.chosen_spread) parts.push(`Tiragem escolhida: ${contact.chosen_spread}`);
    if (contact.chosen_amount) parts.push(`Valor: R$ ${parseFloat(contact.chosen_amount).toFixed(2)}`);
    if (contact.area_of_life) parts.push(`Área de vida: ${contact.area_of_life}`);
    return parts.join('\n');
  }

  parseTransition(text) {
    const m = text.match(/\[\[TRANSICAO:(\w+)\]\]/i);
    if (m) return { clean: text.replace(m[0], '').trim(), transition: m[1] };
    return { clean: text, transition: null };
  }

  detectSpread(text) {
    const t = text.toLowerCase();
    if (t.includes('mandala') || t.includes('150'))           return { key: 'mandala',      price: 150 };
    if (t.includes('cruz') || t.includes('céltica') || t.includes('99')) return { key: 'celtic_cross', price: 99 };
    if (t.includes('ferradura') || t.includes('65'))          return { key: 'horseshoe',    price: 65 };
    if (t.includes('3 cartas') || t.includes('35'))           return { key: '3_cards',      price: 35 };
    return null;
  }

  detectPagamento(text) {
    const kw = ['paguei','pago','comprovante','transferi','enviei','fiz o pix',
                'realizei','confirmado','já paguei','efetuei','mandei o pix','pixei'];
    return kw.some(k => text.toLowerCase().includes(k));
  }

  drawCards(spreadType = '3_cards') {
    const positions = SPREAD_POSITIONS[spreadType] || SPREAD_POSITIONS['3_cards'];
    const deck = [...TAROT_CARDS];
    return positions.map(position => {
      const idx = Math.floor(Math.random() * deck.length);
      const card = deck.splice(idx, 1)[0];
      return { position, card, reversed: Math.random() > 0.65 };
    });
  }

  split(text, max = 1500) {
    if (!text || text.length <= max) return [text || ''];
    const sentences = text.split(/(?<=[.!?])\s+/);
    const parts = [];
    let cur = '';
    for (const s of sentences) {
      if ((cur + s).length > max) { if (cur) parts.push(cur.trim()); cur = s; }
      else cur += (cur ? ' ' : '') + s;
    }
    if (cur) parts.push(cur.trim());
    return parts.length ? parts : [text];
  }

  fallback(name) {
    return [`Olá${name ? ', ' + name : ''}! 🌙 Estou me preparando para atendê-la. Por favor, tente novamente em instantes. 💜`];
  }
}

export const agenteEngine = new AgenteEngine();
