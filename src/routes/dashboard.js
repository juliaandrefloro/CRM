import { Router } from 'express';
import { db }     from '../db.js';
import { waManager } from '../whatsapp.js';

const router = Router();

router.get('/', async (req, res) => {
  const [instances, contacts, msgs, today, revenue, readings] = await Promise.all([
    db.query(`SELECT id, name, status FROM wa_instances`),
    db.query(`SELECT COUNT(*) FROM contacts`),
    db.query(`SELECT COUNT(*) FROM messages`),
    db.query(`SELECT COUNT(*) FROM messages WHERE sent_at > NOW() - INTERVAL '24h' AND role='user'`),
    db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE status='CONFIRMED' AND confirmed_at > NOW() - INTERVAL '30 days'`),
    db.query(`SELECT COUNT(*) FROM readings WHERE created_at > NOW() - INTERVAL '30 days'`),
  ]);

  const connectedInstances = instances.rows.map(i => ({
    ...i,
    status: waManager.getStatus(i.id) || i.status
  }));

  res.json({
    connected:      connectedInstances.filter(i => i.status === 'connected').length,
    instances:      connectedInstances,
    totalContacts:  parseInt(contacts.rows[0].count),
    totalMessages:  parseInt(msgs.rows[0].count),
    messagesToday:  parseInt(today.rows[0].count),
    revenueMonth:   parseFloat(revenue.rows[0].total),
    readingsMonth:  parseInt(readings.rows[0].count),
  });
});

export default router;
