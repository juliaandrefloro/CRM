import { Router } from 'express';
import { db }      from '../db.js';

const router = Router();

// ── Lista todos os agentes de uma instância ──────────────────────────────────
router.get('/:instanceId', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, instance_id, name, avatar, system_prompt, model, provider,
             flow_config, active, created_at, updated_at,
             -- Oculta a chave de API por segurança (retorna apenas se existe)
             CASE WHEN api_key IS NOT NULL AND api_key != '' THEN true ELSE false END AS has_custom_key
      FROM ai_agents
      WHERE instance_id = $1
      ORDER BY active DESC, created_at ASC
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
             flow_config, active, created_at, updated_at,
             CASE WHEN api_key IS NOT NULL AND api_key != '' THEN true ELSE false END AS has_custom_key
      FROM ai_agents WHERE id = $1
    `, [req.params.agentId]);
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cria novo agente ──────────────────────────────────────────────────────────
router.post('/:instanceId', async (req, res) => {
  const { name, avatar, system_prompt, model, provider, api_key, flow_config } = req.body;
  if (!name || !system_prompt) {
    return res.status(400).json({ error: 'name e system_prompt são obrigatórios' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO ai_agents (instance_id, name, avatar, system_prompt, model, provider, api_key, flow_config)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, avatar, model, provider, active, created_at
    `, [
      req.params.instanceId,
      name,
      avatar || '🤖',
      system_prompt,
      model || 'claude-haiku-4-5',
      provider || 'anthropic',
      api_key || null,
      flow_config ? JSON.stringify(flow_config) : '{}'
    ]);
    res.json({ ok: true, agent: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Atualiza agente ───────────────────────────────────────────────────────────
router.put('/:agentId', async (req, res) => {
  const { name, avatar, system_prompt, model, provider, api_key, flow_config } = req.body;
  try {
    // Monta campos dinâmicos para não sobrescrever api_key se não enviada
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

// ── Ativa um agente (desativa todos os outros da mesma instância) ─────────────
router.post('/:agentId/activate', async (req, res) => {
  try {
    // Busca a instância do agente
    const { rows } = await db.query(
      `SELECT instance_id FROM ai_agents WHERE id = $1`,
      [req.params.agentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });

    const instanceId = rows[0].instance_id;

    // Desativa todos da instância e ativa o escolhido
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

// ── Desativa agente ───────────────────────────────────────────────────────────
router.post('/:agentId/deactivate', async (req, res) => {
  try {
    await db.query(
      `UPDATE ai_agents SET active = FALSE, updated_at = NOW() WHERE id = $1`,
      [req.params.agentId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Exclui agente ─────────────────────────────────────────────────────────────
router.delete('/:agentId', async (req, res) => {
  try {
    // Verifica se é o agente ativo
    const { rows } = await db.query(
      `SELECT active FROM ai_agents WHERE id = $1`,
      [req.params.agentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Agente não encontrado' });
    if (rows[0].active) {
      return res.status(400).json({ error: 'Não é possível excluir o agente ativo. Ative outro agente primeiro.' });
    }

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

export default router;
