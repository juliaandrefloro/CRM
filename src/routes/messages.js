import { Router }    from 'express';
import { db }        from '../db.js';
import { waManager } from '../whatsapp.js';

const router = Router();

// Lista contatos de uma instância (com última mensagem)
router.get('/:instanceId/contacts', async (req, res) => {
  const { rows } = await db.query(`
    SELECT c.*,
      (SELECT content FROM messages WHERE contact_id=c.id ORDER BY sent_at DESC LIMIT 1) AS last_message,
      (SELECT sent_at  FROM messages WHERE contact_id=c.id ORDER BY sent_at DESC LIMIT 1) AS last_at
    FROM contacts c
    WHERE c.instance_id=$1
    ORDER BY last_at DESC NULLS LAST
  `, [req.params.instanceId]);
  res.json(rows);
});

// Histórico de mensagens de um contato
router.get('/contact/:contactId', async (req, res) => {
  const { rows } = await db.query(`
    SELECT * FROM messages WHERE contact_id=$1 ORDER BY sent_at ASC
  `, [req.params.contactId]);
  res.json(rows);
});

// Detalhes de um contato
router.get('/contact/:contactId/info', async (req, res) => {
  const { rows } = await db.query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM readings WHERE contact_id=c.id) AS total_readings,
      (SELECT COUNT(*) FROM payments WHERE contact_id=c.id AND status='CONFIRMED') AS paid_sessions
    FROM contacts c WHERE c.id=$1
  `, [req.params.contactId]);
  if (!rows.length) return res.status(404).json({ error: 'Contato não encontrado' });
  res.json(rows[0]);
});

// Envia mensagem manual
router.post('/:instanceId/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone e text são obrigatórios' });
  try {
    await waManager.sendText(parseInt(req.params.instanceId), phone, text);

    // Garante que contato existe
    const { rows } = await db.query(`
      INSERT INTO contacts (instance_id, phone)
      VALUES ($1,$2) ON CONFLICT (instance_id,phone)
      DO UPDATE SET last_seen=NOW() RETURNING *
    `, [req.params.instanceId, phone]);

    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent)
       VALUES ($1,$2,'assistant',$3,'manual')`,
      [req.params.instanceId, rows[0].id, text]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
