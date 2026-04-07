/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ROTAS — Fábrica de Agentes Dinâmica
 *  ─────────────────────────────────────────────────────────────────────────
 *  /api/fabrica/:instanceId/agentes       — CRUD de agentes_config
 *  /api/fabrica/:instanceId/remarketing   — CRUD de remarketing_templates
 *  /api/fabrica/:instanceId/desempenho    — Dashboard de desempenho em tempo real
 *  /api/fabrica/:instanceId/relatorio     — Relatório semanal
 *  /api/fabrica/:instanceId/funil         — Funil de clientes por status_atendimento
 *  /api/fabrica/:instanceId/seed          — Cria os 3 agentes padrão (estrutura vazia)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { Router } from 'express';
import { db } from '../db.js';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
// AGENTES_CONFIG — CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/fabrica/:instanceId/agentes — lista todos os agentes
router.get('/:instanceId/agentes', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, slug, nome, avatar, system_prompt, model, provider,
              temperature, max_tokens, ativo, ordem, created_at, updated_at,
              CASE WHEN api_key IS NOT NULL AND api_key != '' THEN true ELSE false END as tem_api_key
       FROM agentes_config
       WHERE instance_id = $1
       ORDER BY ordem ASC, id ASC`,
      [req.params.instanceId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/fabrica/:instanceId/agentes/:slug — busca um agente pelo slug
router.get('/:instanceId/agentes/:slug', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM agentes_config WHERE instance_id=$1 AND slug=$2 LIMIT 1`,
      [req.params.instanceId, req.params.slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });
    // Não retorna api_key em texto claro — apenas indica se existe
    const agente = { ...rows[0], api_key: rows[0].api_key ? '***CONFIGURADA***' : null };
    res.json(agente);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fabrica/:instanceId/agentes — cria ou atualiza (upsert por slug)
router.post('/:instanceId/agentes', async (req, res) => {
  const {
    slug, nome, avatar, system_prompt, api_key,
    model, provider, temperature, max_tokens, ativo, ordem
  } = req.body;

  if (!slug || !nome) {
    return res.status(400).json({ error: 'slug e nome são obrigatórios' });
  }

  try {
    const { rows } = await db.query(`
      INSERT INTO agentes_config
        (instance_id, slug, nome, avatar, system_prompt, api_key, model, provider,
         temperature, max_tokens, ativo, ordem, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (instance_id, slug) DO UPDATE SET
        nome          = EXCLUDED.nome,
        avatar        = EXCLUDED.avatar,
        system_prompt = EXCLUDED.system_prompt,
        api_key       = COALESCE(NULLIF(EXCLUDED.api_key,'***CONFIGURADA***'), agentes_config.api_key),
        model         = EXCLUDED.model,
        provider      = EXCLUDED.provider,
        temperature   = EXCLUDED.temperature,
        max_tokens    = EXCLUDED.max_tokens,
        ativo         = EXCLUDED.ativo,
        ordem         = EXCLUDED.ordem,
        updated_at    = NOW()
      RETURNING id, slug, nome, avatar, model, provider, ativo, ordem, created_at
    `, [
      req.params.instanceId, slug, nome,
      avatar || '🤖', system_prompt || '',
      (api_key && api_key !== '***CONFIGURADA***') ? api_key : null,
      model || 'claude-haiku-4-5', provider || 'anthropic',
      temperature || 0.70, max_tokens || 800,
      ativo !== false, ordem || 0
    ]);
    res.json({ ok: true, agente: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/fabrica/:instanceId/agentes/:slug — atualiza campos específicos
router.put('/:instanceId/agentes/:slug', async (req, res) => {
  const allowed = ['nome','avatar','system_prompt','api_key','model','provider',
                   'temperature','max_tokens','ativo','ordem'];
  const fields = [];
  const values = [];
  let idx = 1;

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'api_key' && req.body[key] === '***CONFIGURADA***') continue;
      fields.push(`${key}=$${idx++}`);
      values.push(req.body[key] === '' && key === 'api_key' ? null : req.body[key]);
    }
  }

  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.instanceId, req.params.slug);

  try {
    await db.query(
      `UPDATE agentes_config SET ${fields.join(',')}
       WHERE instance_id=$${idx} AND slug=$${idx+1}`,
      values
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/fabrica/:instanceId/agentes/:slug — exclui agente
router.delete('/:instanceId/agentes/:slug', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM agentes_config WHERE instance_id=$1 AND slug=$2`,
      [req.params.instanceId, req.params.slug]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fabrica/:instanceId/seed — cria os 3 agentes padrão (estrutura vazia)
router.post('/:instanceId/seed', async (req, res) => {
  const instanceId = req.params.instanceId;
  const agentes = [
    {
      slug: 'saudacao', nome: 'Agente 1 — Saudação', avatar: '🌙',
      model: 'claude-haiku-4-5', provider: 'anthropic', ordem: 1,
      system_prompt: ''  // Usuário preenche pelo painel
    },
    {
      slug: 'pagamento', nome: 'Agente 2 — Pagamento', avatar: '💳',
      model: 'claude-haiku-4-5', provider: 'anthropic', ordem: 2,
      system_prompt: ''
    },
    {
      slug: 'entrega', nome: 'Agente 3 — Entrega', avatar: '🔮',
      model: 'claude-opus-4-5', provider: 'anthropic', ordem: 3,
      system_prompt: ''
    },
  ];

  try {
    for (const a of agentes) {
      await db.query(`
        INSERT INTO agentes_config
          (instance_id, slug, nome, avatar, system_prompt, model, provider, ordem, ativo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
        ON CONFLICT (instance_id, slug) DO NOTHING
      `, [instanceId, a.slug, a.nome, a.avatar, a.system_prompt, a.model, a.provider, a.ordem]);
    }
    res.json({ ok: true, message: '3 agentes criados com sucesso' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REMARKETING_TEMPLATES — CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/fabrica/:instanceId/remarketing — lista templates
router.get('/:instanceId/remarketing', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM remarketing_templates WHERE instance_id=$1 ORDER BY ordem ASC`,
      [req.params.instanceId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fabrica/:instanceId/remarketing — cria ou atualiza template
router.post('/:instanceId/remarketing', async (req, res) => {
  const { slug, nome, mensagem, delay_minutos, ativo, ordem } = req.body;
  if (!slug || !nome || !mensagem) {
    return res.status(400).json({ error: 'slug, nome e mensagem são obrigatórios' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO remarketing_templates
        (instance_id, slug, nome, mensagem, delay_minutos, ativo, ordem, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (instance_id, slug) DO UPDATE SET
        nome          = EXCLUDED.nome,
        mensagem      = EXCLUDED.mensagem,
        delay_minutos = EXCLUDED.delay_minutos,
        ativo         = EXCLUDED.ativo,
        ordem         = EXCLUDED.ordem,
        updated_at    = NOW()
      RETURNING *
    `, [req.params.instanceId, slug, nome, mensagem,
        delay_minutos || 30, ativo !== false, ordem || 0]);
    res.json({ ok: true, template: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/fabrica/:instanceId/remarketing/:slug — atualiza template
router.put('/:instanceId/remarketing/:slug', async (req, res) => {
  const allowed = ['nome','mensagem','delay_minutos','ativo','ordem'];
  const fields = [];
  const values = [];
  let idx = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${idx++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  fields.push(`updated_at=NOW()`);
  values.push(req.params.instanceId, req.params.slug);
  try {
    await db.query(
      `UPDATE remarketing_templates SET ${fields.join(',')} WHERE instance_id=$${idx} AND slug=$${idx+1}`,
      values
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/fabrica/:instanceId/remarketing/:slug
router.delete('/:instanceId/remarketing/:slug', async (req, res) => {
  try {
    await db.query(
      `DELETE FROM remarketing_templates WHERE instance_id=$1 AND slug=$2`,
      [req.params.instanceId, req.params.slug]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fabrica/:instanceId/remarketing/seed — cria templates padrão
router.post('/:instanceId/remarketing/seed', async (req, res) => {
  const instanceId = req.params.instanceId;
  const templates = [
    {
      slug: 'lembrete_30min', nome: 'Lembrete 30 minutos', delay_minutos: 30, ordem: 1,
      mensagem: 'Olá, {nome}! 🌙 Sua consulta de Tarot ainda está reservada.\n\nSua tiragem: {tiragem} — {valor}\n\nQuando quiser prosseguir com o pagamento, é só me avisar. 💜'
    },
    {
      slug: 'lembrete_1h', nome: 'Lembrete 1 hora', delay_minutos: 60, ordem: 2,
      mensagem: '✨ {nome}, as cartas estão esperando por você.\n\nSua consulta de {tiragem} ({valor}) continua reservada. O universo tem uma mensagem especial para você hoje. 🔮\n\nGostaria de prosseguir?'
    },
    {
      slug: 'lembrete_2h', nome: 'Último lembrete (2 horas)', delay_minutos: 120, ordem: 3,
      mensagem: '💜 {nome}, deixo a porta aberta para quando você se sentir pronta.\n\nSua consulta de Tarot ({tiragem}) estará disponível sempre que precisar. Estarei aqui. 🌙'
    },
  ];
  try {
    for (const t of templates) {
      await db.query(`
        INSERT INTO remarketing_templates
          (instance_id, slug, nome, mensagem, delay_minutos, ativo, ordem)
        VALUES ($1,$2,$3,$4,$5,TRUE,$6)
        ON CONFLICT (instance_id, slug) DO NOTHING
      `, [instanceId, t.slug, t.nome, t.mensagem, t.delay_minutos, t.ordem]);
    }
    res.json({ ok: true, message: '3 templates de remarketing criados' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DESEMPENHO — Dashboard em tempo real
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/fabrica/:instanceId/desempenho — métricas por agente (hoje e 7 dias)
router.get('/:instanceId/desempenho', async (req, res) => {
  const instanceId = req.params.instanceId;
  try {
    // Métricas de hoje
    const { rows: hoje } = await db.query(`
      SELECT
        agente_slug,
        SUM(mensagens_enviadas)   AS enviadas,
        SUM(mensagens_recebidas)  AS recebidas,
        SUM(conversoes)           AS conversoes
      FROM agent_performance
      WHERE instance_id=$1 AND data = CURRENT_DATE
      GROUP BY agente_slug
    `, [instanceId]);

    // Métricas dos últimos 7 dias
    const { rows: semana } = await db.query(`
      SELECT
        agente_slug,
        data,
        SUM(mensagens_enviadas)   AS enviadas,
        SUM(mensagens_recebidas)  AS recebidas,
        SUM(conversoes)           AS conversoes
      FROM agent_performance
      WHERE instance_id=$1 AND data >= CURRENT_DATE - INTERVAL '6 days'
      GROUP BY agente_slug, data
      ORDER BY data ASC
    `, [instanceId]);

    // Funil de clientes por status_atendimento
    const { rows: funil } = await db.query(`
      SELECT
        status_atendimento,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE last_seen >= NOW() - INTERVAL '24 hours') AS ativos_hoje
      FROM contacts
      WHERE instance_id=$1
      GROUP BY status_atendimento
      ORDER BY total DESC
    `, [instanceId]);

    // Total de conversas hoje
    const { rows: totais } = await db.query(`
      SELECT
        COUNT(DISTINCT contact_id) FILTER (WHERE sent_at >= CURRENT_DATE) AS conversas_hoje,
        COUNT(*) FILTER (WHERE sent_at >= CURRENT_DATE AND role='assistant') AS respostas_hoje,
        COUNT(DISTINCT contact_id) FILTER (WHERE sent_at >= CURRENT_DATE - INTERVAL '6 days') AS conversas_semana
      FROM messages
      WHERE instance_id=$1
    `, [instanceId]);

    res.json({
      hoje,
      semana,
      funil,
      totais: totais[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RELATÓRIO SEMANAL
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/fabrica/:instanceId/relatorio — relatório semanal completo
router.get('/:instanceId/relatorio', async (req, res) => {
  const instanceId = req.params.instanceId;
  const semanas = parseInt(req.query.semanas) || 1;

  try {
    const dataInicio = new Date();
    dataInicio.setDate(dataInicio.getDate() - (semanas * 7));

    // 1. Resumo geral
    const { rows: resumo } = await db.query(`
      SELECT
        COUNT(DISTINCT c.id)                                              AS total_clientes,
        COUNT(DISTINCT c.id) FILTER (WHERE c.created_at >= $2)           AS novos_clientes,
        COUNT(DISTINCT m.contact_id) FILTER (WHERE m.sent_at >= $2)      AS clientes_ativos,
        COUNT(*) FILTER (WHERE m.role='assistant' AND m.sent_at >= $2)   AS total_respostas,
        COUNT(DISTINCT r.id) FILTER (WHERE r.created_at >= $2)           AS tiragens_realizadas,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status='CONFIRMED' AND p.created_at >= $2), 0) AS faturamento
      FROM contacts c
      LEFT JOIN messages m ON m.contact_id = c.id AND m.instance_id = $1
      LEFT JOIN readings r ON r.contact_id = c.id
      LEFT JOIN payments p ON p.contact_id = c.id AND p.instance_id = $1
      WHERE c.instance_id = $1
    `, [instanceId, dataInicio]);

    // 2. Desempenho por agente
    const { rows: porAgente } = await db.query(`
      SELECT
        ap.agente_slug,
        ac.nome AS nome_agente,
        ac.avatar,
        SUM(ap.mensagens_enviadas)  AS enviadas,
        SUM(ap.mensagens_recebidas) AS recebidas,
        SUM(ap.conversoes)          AS conversoes,
        ROUND(
          CASE WHEN SUM(ap.mensagens_recebidas) > 0
          THEN SUM(ap.conversoes)::numeric / SUM(ap.mensagens_recebidas) * 100
          ELSE 0 END, 1
        ) AS taxa_conversao
      FROM agent_performance ap
      LEFT JOIN agentes_config ac ON ac.instance_id=ap.instance_id AND ac.slug=ap.agente_slug
      WHERE ap.instance_id=$1 AND ap.data >= $2
      GROUP BY ap.agente_slug, ac.nome, ac.avatar
      ORDER BY conversoes DESC
    `, [instanceId, dataInicio]);

    // 3. Funil de conversão
    const { rows: funil } = await db.query(`
      SELECT
        status_atendimento AS etapa,
        COUNT(*) AS total
      FROM contacts
      WHERE instance_id=$1
      GROUP BY status_atendimento
      ORDER BY total DESC
    `, [instanceId]);

    // 4. Remarketing — taxa de efetividade
    const { rows: remarketing } = await db.query(`
      SELECT
        message_type AS template,
        COUNT(*) FILTER (WHERE status='sent')      AS enviados,
        COUNT(*) FILTER (WHERE status='pending')   AS pendentes,
        COUNT(*) FILTER (WHERE status='cancelled') AS cancelados
      FROM remarketing_jobs rj
      JOIN contacts c ON c.id = rj.contact_id
      WHERE c.instance_id=$1 AND rj.created_at >= $2
      GROUP BY message_type
      ORDER BY enviados DESC
    `, [instanceId, dataInicio]);

    // 5. Top contatos (mais ativos)
    const { rows: topContatos } = await db.query(`
      SELECT
        c.phone, c.name, c.status_atendimento,
        COUNT(m.id) AS total_msgs,
        MAX(m.sent_at) AS ultima_msg
      FROM contacts c
      JOIN messages m ON m.contact_id = c.id
      WHERE c.instance_id=$1 AND m.sent_at >= $2
      GROUP BY c.id, c.phone, c.name, c.status_atendimento
      ORDER BY total_msgs DESC
      LIMIT 10
    `, [instanceId, dataInicio]);

    // 6. Evolução diária (últimos 7 dias)
    const { rows: evolucao } = await db.query(`
      SELECT
        DATE(m.sent_at) AS data,
        COUNT(DISTINCT m.contact_id) AS conversas,
        COUNT(*) FILTER (WHERE m.role='assistant') AS respostas
      FROM messages m
      JOIN contacts c ON c.id = m.contact_id
      WHERE c.instance_id=$1 AND m.sent_at >= $2
      GROUP BY DATE(m.sent_at)
      ORDER BY data ASC
    `, [instanceId, dataInicio]);

    res.json({
      periodo: {
        inicio: dataInicio.toISOString().split('T')[0],
        fim: new Date().toISOString().split('T')[0],
        semanas,
      },
      resumo: resumo[0],
      por_agente: porAgente,
      funil,
      remarketing,
      top_contatos: topContatos,
      evolucao_diaria: evolucao,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FUNIL — Clientes por status_atendimento
// ═══════════════════════════════════════════════════════════════════════════

router.get('/:instanceId/funil', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        status_atendimento AS etapa,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE last_seen >= NOW() - INTERVAL '1 hour')  AS ativos_1h,
        COUNT(*) FILTER (WHERE last_seen >= NOW() - INTERVAL '24 hours') AS ativos_24h,
        COUNT(*) FILTER (WHERE last_seen >= NOW() - INTERVAL '7 days')  AS ativos_7d
      FROM contacts
      WHERE instance_id=$1
      GROUP BY status_atendimento
      ORDER BY total DESC
    `, [req.params.instanceId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
