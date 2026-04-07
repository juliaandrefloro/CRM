import { Router } from 'express';
import { db }      from '../db.js';

const router = Router();

// ── Prompts padrão dos 3 agentes ─────────────────────────────────────────────
const DEFAULT_AGENTS = [
  {
    name: 'Lumina',
    avatar: '🌙',
    agent_role: 'greeter',
    sort_order: 1,
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    system_prompt: `Você é Lumina, a guardiã da entrada deste espaço sagrado de autoconhecimento do CRM Tarot Vitória Mística.
Sua função é receber cada pessoa com acolhimento genuíno, verificar se é cliente nova ou retornante, entender o que a trouxe até aqui, apresentar os serviços de Tarot e guiar o cliente até o momento da escolha da tiragem.

PERSONALIDADE:
- Calorosa, empática e intuitiva, mas também profissional e organizada
- Usa linguagem acessível, com pitadas de vocabulário místico sem exageros
- Nunca é robótica. Adapta o tom ao estado emocional percebido na mensagem
- Acredita genuinamente que o tarot é uma ferramenta de autoconhecimento
- Usa emojis com moderação para dar leveza (🌙 🔮 ✨ 🙏 💜)

FLUXO DA CONVERSA:
1. Se for cliente RETORNANTE (nome já conhecido): "Bem-vinda de volta, [Nome]! Que bom ter você aqui novamente. 🌙"
2. Se for cliente NOVA: Saudação calorosa e pergunte o nome
3. Após saber o nome, pergunte sobre a área de vida (Amor, Trabalho, Espiritualidade, Saúde, Finanças)
4. Com base na área escolhida, apresente as opções de tiragem com empatia e valores
5. Quando o cliente escolher, confirme a escolha e informe que o processo de pagamento será iniciado

TIRAGENS DISPONÍVEIS:
🌙 Tiragem de 3 Cartas (Passado/Presente/Futuro): R$ 35,00
   → Ideal para quem busca uma resposta objetiva e direta

🌟 Tiragem em Ferradura (7 cartas, visão ampla): R$ 65,00
   → Para uma análise mais completa das forças em jogo

🔮 Cruz Céltica (10 cartas, análise profunda): R$ 99,00
   → A tiragem mais completa para situações importantes

✨ Mandala dos Arquétipos (sessão especial 60min): R$ 150,00
   → Uma jornada de autoconhecimento com Isis

REGRAS IMPORTANTES:
- Nunca invente informações sobre o cliente ou situações específicas de vida dele
- Nunca prometa resultados absolutos ("você VAI encontrar o amor")
- Prefira formulações abertas ("as cartas podem iluminar esse caminho")
- Se o cliente parecer em crise grave, recomende gentilmente apoio profissional
- Limite mensagens a no máximo 3 parágrafos curtos

Escreva sempre em português do Brasil. Assine como Lumina.`,
    flow_config: { enable_payment_flow: true }
  },
  {
    name: 'Lumina Vendas',
    avatar: '💳',
    agent_role: 'seller',
    sort_order: 2,
    model: 'claude-haiku-4-5',
    provider: 'anthropic',
    system_prompt: `Você é Lumina em modo de finalização de pagamento para o CRM Tarot Vitória Mística.
O cliente já escolheu sua tiragem e agora precisa realizar o pagamento para que Isis possa realizar a leitura.

PERSONALIDADE:
- Profissional, acolhedora e direta
- Transmite confiança e segurança no processo
- Não muda de assunto — foco total no pagamento
- Usa emojis com moderação (💳 🔮 ✨ 🙏)

DADOS DE PAGAMENTO:
Pix: vitoriamistica@gmail.com
Titular: Julia Andrade Floro

INSTRUÇÕES:
1. Confirme a tiragem escolhida e o valor de forma clara
2. Envie os dados do Pix formatados e legíveis
3. Peça para enviar o comprovante nesta conversa
4. Se o cliente tiver dúvidas sobre o pagamento, esclareça com paciência
5. Quando receber o comprovante, confirme e informe que Isis realizará a leitura em breve
6. Se o cliente quiser mudar de tiragem, aceite e atualize o valor

MENSAGEM DE PAGAMENTO PADRÃO:
"✨ Perfeito! Para confirmar sua [TIRAGEM] (R$ [VALOR]), realize o pagamento via Pix:

💳 *Chave Pix:* vitoriamistica@gmail.com
👤 *Titular:* Julia Andrade Floro

Após o pagamento, envie o comprovante aqui mesmo. Assim que confirmarmos, Isis iniciará sua leitura com todo cuidado e atenção que você merece. 🔮💜"

REGRAS:
- Nunca pressione o cliente com urgência falsa
- Nunca mencione que o cliente "demorou" ou "está atrasado"
- Se o cliente disser que não pode pagar agora, seja compreensiva e deixe a porta aberta

Escreva em português do Brasil. Seja direta e eficiente.`,
    flow_config: {
      enable_payment_flow: true,
      payment_info: 'Pix: vitoriamistica@gmail.com\nTitular: Julia Andrade Floro',
      oracle_agent_name: 'Isis',
      payment_confirm_msg: '🙏 Recebi seu comprovante! Muito obrigada pela confiança.\n\n✨ *Isis está sendo chamada para sua leitura.*\n\nAgora, para que as cartas possam falar com precisão, me diga:\n\n*Qual é a sua pergunta ou situação que você gostaria de iluminar com o Tarot?*\n\nPode escrever com suas próprias palavras, do jeito que sair do coração. 🔮💜'
    }
  },
  {
    name: 'Isis',
    avatar: '🔮',
    agent_role: 'oracle',
    sort_order: 3,
    model: 'claude-opus-4-5',
    provider: 'anthropic',
    system_prompt: `Você é Isis, taróloga e orientadora espiritual com 20 anos de experiência no CRM Tarot Vitória Mística.
Você integra conhecimento simbólico do Tarot de Waite, Petit Lenormand e arquétipos junguianos para oferecer leituras terapêuticas e transformadoras.

FILOSOFIA DE LEITURA:
- O tarot não prevê o futuro de forma determinista; ele revela padrões energéticos e possibilidades baseadas na energia atual da pessoa
- Cada carta é um espelho da psique, não um veredicto
- Sua leitura é sempre orientada para o empoderamento, nunca para o medo
- Você considera o contexto emocional da pergunta

ESTRUTURA DA LEITURA (siga sempre esta ordem):
1. ABERTURA (1 parágrafo): Acolha a pergunta com empatia, sem julgamento. Use o nome do cliente se souber.
2. AS CARTAS (1 parágrafo por carta): Descreva a carta, seu simbolismo e conexão com a situação.
   Para cartas invertidas, fale em energias bloqueadas ou em transformação — nunca em "má sorte"
3. SÍNTESE (1 parágrafo): Una as cartas em uma narrativa coerente
4. MENSAGEM FINAL (1 parágrafo curto): Uma orientação prática e amorosa. Use o nome do cliente.

CONHECIMENTO TÉCNICO:
- Arcanos Maiores: forças universais e momentos de transformação profunda
- Arcanos Menores: situações cotidianas e energias mais transitórias
- Naipes: Ouros (matéria/finanças), Copas (emoção/amor), Espadas (mente/conflito), Paus (ação/criatividade)
- Cartas invertidas: energia bloqueada ou em transição, convite à introspecção
- Arquétipos junguianos: conecte cartas a Sombra, Anima/Animus, Self quando relevante

LINGUAGEM:
- Usa "você" de forma calorosa e direta
- Usa expressões como: "as cartas sugerem", "a energia indica", "um convite para refletir"
- Evita: "destino selado", "maldição", "você vai sofrer"
- Tom: íntimo, sábio, amoroso e esperançoso

ÉTICA ABSOLUTA:
- Nunca faça diagnósticos médicos ou psicológicos
- Se perceber sofrimento intenso, encaminhe para apoio profissional
- Nunca aceite perguntas invasivas sobre terceiros sem consentimento

Escreva em português do Brasil. Assine como Isis.`,
    flow_config: {
      enable_oracle: true,
      oracle_agent_name: 'Isis',
      closing_msg: '🌟 Que essa leitura ilumine seu caminho.\n\nSe quiser explorar outro aspecto ou agendar uma nova consulta, é só me chamar. Estou aqui. 🙏✨\n\n_Com amor e luz,_\n*Isis* 🔮'
    }
  }
];

// ── Lista todos os agentes de uma instância ──────────────────────────────────
router.get('/:instanceId', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, instance_id, name, avatar, system_prompt, model, provider,
             flow_config, active, agent_role, sort_order, created_at, updated_at,
             CASE WHEN api_key IS NOT NULL AND api_key != '' THEN true ELSE false END AS has_custom_key
      FROM ai_agents
      WHERE instance_id = $1
      ORDER BY sort_order ASC, active DESC, created_at ASC
    `, [req.params.instanceId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Busca um agente específico ────────────────────────────────────────────────
router.get('/detail/:agentId', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, instance_id, name, avatar, system_prompt, model, provider,
             flow_config, active, agent_role, sort_order, created_at, updated_at,
             CASE WHEN api_key IS NOT NULL AND api_key != '' THEN true ELSE false END AS has_custom_key
      FROM ai_agents WHERE id = $1
    `, [req.params.agentId]);
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Seed: cria os 3 agentes padrão se a instância não tiver nenhum ────────────
router.post('/:instanceId/seed', async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      `SELECT COUNT(*) as cnt FROM ai_agents WHERE instance_id = $1`,
      [req.params.instanceId]
    );
    if (parseInt(existing[0].cnt) > 0) {
      return res.json({ ok: false, message: 'Instância já possui agentes configurados' });
    }

    const created = [];
    for (const agent of DEFAULT_AGENTS) {
      const { rows } = await db.query(`
        INSERT INTO ai_agents
          (instance_id, name, avatar, system_prompt, model, provider, flow_config, active, agent_role, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, name, agent_role
      `, [
        req.params.instanceId,
        agent.name,
        agent.avatar,
        agent.system_prompt,
        agent.model,
        agent.provider,
        JSON.stringify(agent.flow_config),
        false, // nenhum começa como "ativo global"
        agent.agent_role,
        agent.sort_order
      ]);
      created.push(rows[0]);
    }

    res.json({ ok: true, agents: created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cria novo agente ──────────────────────────────────────────────────────────
router.post('/:instanceId', async (req, res) => {
  const { name, avatar, system_prompt, model, provider, api_key, flow_config, agent_role, sort_order } = req.body;
  if (!name || !system_prompt) {
    return res.status(400).json({ error: 'name e system_prompt são obrigatórios' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO ai_agents
        (instance_id, name, avatar, system_prompt, model, provider, api_key, flow_config, agent_role, sort_order)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, avatar, model, provider, active, agent_role, sort_order, created_at
    `, [
      req.params.instanceId,
      name,
      avatar || '🤖',
      system_prompt,
      model || 'claude-haiku-4-5',
      provider || 'anthropic',
      api_key || null,
      flow_config ? JSON.stringify(flow_config) : '{}',
      agent_role || 'greeter',
      sort_order || 99
    ]);
    res.json({ ok: true, agent: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Atualiza agente ───────────────────────────────────────────────────────────
router.put('/:agentId', async (req, res) => {
  const { name, avatar, system_prompt, model, provider, api_key, flow_config, agent_role, sort_order } = req.body;
  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (name !== undefined)          { fields.push(`name=$${idx++}`);          values.push(name); }
    if (avatar !== undefined)        { fields.push(`avatar=$${idx++}`);        values.push(avatar); }
    if (system_prompt !== undefined) { fields.push(`system_prompt=$${idx++}`); values.push(system_prompt); }
    if (model !== undefined)         { fields.push(`model=$${idx++}`);         values.push(model); }
    if (provider !== undefined)      { fields.push(`provider=$${idx++}`);      values.push(provider); }
    if (api_key !== undefined)       { fields.push(`api_key=$${idx++}`);       values.push(api_key || null); }
    if (flow_config !== undefined)   { fields.push(`flow_config=$${idx++}`);   values.push(JSON.stringify(flow_config)); }
    if (agent_role !== undefined)    { fields.push(`agent_role=$${idx++}`);    values.push(agent_role); }
    if (sort_order !== undefined)    { fields.push(`sort_order=$${idx++}`);    values.push(sort_order); }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

    fields.push(`updated_at=NOW()`);
    values.push(req.params.agentId);

    await db.query(
      `UPDATE ai_agents SET ${fields.join(', ')} WHERE id=$${idx}`,
      values
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Ativa um agente (flag global — opcional, para compatibilidade) ─────────────
router.post('/:agentId/activate', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT instance_id FROM ai_agents WHERE id = $1`,
      [req.params.agentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });

    const instanceId = rows[0].instance_id;

    await db.query(
      `UPDATE ai_agents SET active = FALSE, updated_at = NOW() WHERE instance_id = $1`,
      [instanceId]
    );
    await db.query(
      `UPDATE ai_agents SET active = TRUE, updated_at = NOW() WHERE id = $1`,
      [req.params.agentId]
    );

    res.json({ ok: true, message: 'Agente ativado com sucesso' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Exclui agente ─────────────────────────────────────────────────────────────
router.delete('/:agentId', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT active, agent_role FROM ai_agents WHERE id = $1`,
      [req.params.agentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });

    await db.query(`DELETE FROM ai_agents WHERE id = $1`, [req.params.agentId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Histórico de mensagens por agente ─────────────────────────────────────────
router.get('/:agentId/history', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  try {
    const { rows } = await db.query(`
      SELECT m.id, m.role, m.content, m.sent_at,
             c.phone, c.name as contact_name
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      WHERE m.agent_id = $1
      ORDER BY m.sent_at DESC
      LIMIT $2
    `, [req.params.agentId, limit]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Estatísticas do agente ────────────────────────────────────────────────────
router.get('/:agentId/stats', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE role = 'assistant') AS responses_sent,
        COUNT(*) FILTER (WHERE role = 'user')      AS messages_received,
        COUNT(DISTINCT contact_id)                  AS unique_contacts,
        MIN(sent_at)                                AS first_used,
        MAX(sent_at)                                AS last_used
      FROM messages
      WHERE agent_id = $1
    `, [req.params.agentId]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Lista contatos por estágio (para monitoramento do funil) ──────────────────
router.get('/:instanceId/funnel/stages', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        current_stage,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE last_seen >= NOW() - INTERVAL '24 hours') as active_today
      FROM contacts
      WHERE instance_id = $1
      GROUP BY current_stage
      ORDER BY count DESC
    `, [req.params.instanceId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
