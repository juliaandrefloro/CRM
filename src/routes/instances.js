import { Router }    from 'express';
import { db }        from '../db.js';
import { waManager } from '../whatsapp.js';

const router = Router();

// Lista todas as instâncias
router.get('/', async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM wa_instances ORDER BY id`);
  const result = rows.map(r => ({
    ...r,
    status: waManager.getStatus(r.id) || r.status
  }));
  res.json(result);
});

// Cria nova instância e já inicia conexão
router.post('/', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
  const { rows } = await db.query(
    `INSERT INTO wa_instances (name) VALUES ($1) RETURNING *`, [name]
  );
  const inst = rows[0];
  waManager.connect(inst.id);
  res.json(inst);
});

// Retorna QR Code da instância
router.get('/:id/qr', (req, res) => {
  const qr = waManager.getQR(parseInt(req.params.id));
  res.json({ qr: qr || null });
});

// Conecta instância
router.post('/:id/connect', async (req, res) => {
  waManager.connect(parseInt(req.params.id));
  res.json({ ok: true });
});

// Desconecta instância
router.post('/:id/disconnect', async (req, res) => {
  await waManager.disconnect(parseInt(req.params.id));
  res.json({ ok: true });
});

// Exclui instância
router.delete('/:id', async (req, res) => {
  await waManager.disconnect(parseInt(req.params.id));
  await db.query(`DELETE FROM wa_instances WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

export default router;
