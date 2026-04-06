// =============================================
// Webhook Asaas — Confirmação de Pagamento Pix
// =============================================
import { Router }    from 'express';
import { db }        from '../db.js';
import { waManager } from '../whatsapp.js';

const router = Router();

// Valida token do Asaas
function validateAsaasSignature(req) {
  const token = req.headers['asaas-access-token'];
  return token === process.env.ASAAS_WEBHOOK_TOKEN;
}

router.post('/asaas', async (req, res) => {
  if (!validateAsaasSignature(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { event, payment } = req.body;

  // Responde imediatamente ao Asaas (evita timeout)
  res.status(200).json({ received: true });

  // Só processa pagamentos confirmados
  if (event !== 'PAYMENT_CONFIRMED' && event !== 'PAYMENT_RECEIVED') return;

  try {
    // Busca pagamento e dados do contato
    const { rows } = await db.query(`
      SELECT p.*, c.phone, c.name, c.instance_id, c.id as contact_id
      FROM payments p
      JOIN contacts c ON c.id = p.contact_id
      WHERE p.asaas_id = $1 AND p.status = 'PENDING'
    `, [payment.id]);

    if (!rows.length) return; // Já processado

    const record = rows[0];

    // Atualiza status
    await db.query(
      `UPDATE payments SET status='CONFIRMED', confirmed_at=NOW() WHERE asaas_id=$1`,
      [payment.id]
    );
    await db.query(
      `UPDATE contacts SET stage='awaiting_question' WHERE id=$1`,
      [record.contact_id]
    );

    // Cancela remarketing pendente
    await db.query(
      `UPDATE remarketing_jobs SET status='cancelled'
       WHERE contact_id=$1 AND status='pending'`,
      [record.contact_id]
    );

    // Notifica cliente
    const confirmMsg = `✨ Pagamento confirmado, ${record.name || 'querida alma'}!\n\nSua consulta está liberada. Agora me diga: qual é a pergunta que carrega em seu coração?\n\nSeja específica — quanto mais precisa sua pergunta, mais clara será a revelação das cartas. 🌙`;

    await waManager.sendText(record.instance_id, record.phone, confirmMsg);

    // Loga mensagem
    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent)
       VALUES ($1,$2,'assistant',$3,'reception')`,
      [record.instance_id, record.contact_id, confirmMsg]
    );

  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
  }
});

// Gera cobrança Pix via Asaas
router.post('/create-charge', async (req, res) => {
  const { instanceId, contactId, amount, description } = req.body;

  try {
    // Busca dados do contato
    const { rows } = await db.query(
      `SELECT * FROM contacts WHERE id=$1`, [contactId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Contato não encontrado' });
    const contact = rows[0];

    // Cria cobrança no Asaas
    const asaasRes = await fetch('https://api.asaas.com/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'access_token': process.env.ASAAS_API_KEY
      },
      body: JSON.stringify({
        customer: contact.asaas_customer_id || await createAsaasCustomer(contact),
        billingType: 'PIX',
        value: amount,
        dueDate: new Date(Date.now() + 24*60*60*1000).toISOString().split('T')[0],
        description: description || 'Consulta de Tarot'
      })
    });

    const charge = await asaasRes.json();

    // Salva no banco
    await db.query(`
      INSERT INTO payments (instance_id, contact_id, asaas_id, amount, pix_copy_paste)
      VALUES ($1,$2,$3,$4,$5)
    `, [instanceId, contactId, charge.id, amount, charge.pixTransaction?.payload || '']);

    // Atualiza etapa do contato
    await db.query(
      `UPDATE contacts SET stage='pending_payment' WHERE id=$1`, [contactId]
    );

    res.json({ ok: true, charge });

  } catch(e) {
    console.error('[ASAAS ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

async function createAsaasCustomer(contact) {
  const res = await fetch('https://api.asaas.com/v3/customers', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'access_token': process.env.ASAAS_API_KEY
    },
    body: JSON.stringify({
      name: contact.name || contact.phone,
      mobilePhone: contact.phone
    })
  });
  const customer = await res.json();
  await db.query(
    `UPDATE contacts SET asaas_customer_id=$1 WHERE id=$2`,
    [customer.id, contact.id]
  );
  return customer.id;
}

export default router;
