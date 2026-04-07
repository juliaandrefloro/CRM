import { Router }    from 'express';
import { db }        from '../db.js';
import { waManager } from '../whatsapp.js';

const router = Router();

// ── Lista todas as instâncias com status em tempo real ────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM wa_instances ORDER BY id`);
    const result = rows.map(r => ({
      ...r,
      status: waManager.getStatus(r.id) || r.status,
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cria nova instância e inicia conexão ──────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });

    const { rows } = await db.query(
      `INSERT INTO wa_instances (name, status) VALUES ($1, 'connecting') RETURNING *`,
      [name]
    );
    const inst = rows[0];

    // Inicia conexão de forma assíncrona
    waManager.connect(inst.id).catch(e => {
      console.error(`[CONNECT ERROR inst ${inst.id}]`, e.message);
    });

    res.json(inst);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Retorna QR Code da instância ──────────────────────────────────────────────
router.get('/:id/qr', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const qr     = waManager.getQR(id);
    const status = waManager.getStatus(id);
    res.json({ qr: qr || null, status: status || 'disconnected' });
  } catch (e) {
    res.json({ qr: null, status: 'disconnected' });
  }
});

// ── Status em tempo real da instância ─────────────────────────────────────────
router.get('/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const memStatus = waManager.getStatus(id);
    const { rows } = await db.query(`SELECT status, phone FROM wa_instances WHERE id=$1`, [id]);
    res.json({
      status: memStatus || rows[0]?.status || 'disconnected',
      phone:  rows[0]?.phone || null,
    });
  } catch (e) {
    res.json({ status: 'disconnected', phone: null });
  }
});

// ── Conecta instância ─────────────────────────────────────────────────────────
router.post('/:id/connect', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    waManager.connect(id).catch(e => {
      console.error(`[CONNECT ERROR inst ${id}]`, e.message);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Desconecta instância ──────────────────────────────────────────────────────
router.post('/:id/disconnect', async (req, res) => {
  try {
    await waManager.disconnect(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Exclui instância ──────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await waManager.disconnect(parseInt(req.params.id));
    await db.query(`DELETE FROM wa_instances WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
