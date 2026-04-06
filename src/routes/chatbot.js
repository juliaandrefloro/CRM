import { Router } from 'express';
import { db }     from '../db.js';

const router = Router();

// Lista fluxos de uma instância
router.get('/:instanceId/flows', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM bot_flows WHERE instance_id=$1 ORDER BY id`,
    [req.params.instanceId]
  );
  res.json(rows);
});

// Cria novo fluxo
router.post('/:instanceId/flows', async (req, res) => {
  const { trigger, response, next_stage } = req.body;
  if (!trigger || !response) return res.status(400).json({ error: 'Gatilho e resposta são obrigatórios' });
  const { rows } = await db.query(
    `INSERT INTO bot_flows (instance_id, trigger, response, next_stage)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.instanceId, trigger, response, next_stage || null]
  );
  res.json(rows[0]);
});

// Atualiza fluxo
router.put('/flows/:id', async (req, res) => {
  const { trigger, response, next_stage, active } = req.body;
  const { rows } = await db.query(
    `UPDATE bot_flows SET trigger=$1, response=$2, next_stage=$3, active=$4
     WHERE id=$5 RETURNING *`,
    [trigger, response, next_stage || null, active !== false, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Fluxo não encontrado' });
  res.json(rows[0]);
});

// Exclui fluxo
router.delete('/flows/:id', async (req, res) => {
  await db.query(`DELETE FROM bot_flows WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

export default router;
