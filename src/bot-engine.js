import { db }        from './db.js';
import { waManager } from './whatsapp.js';
import { generateOracleReading } from './oracle.js';

class BotEngine {
  async handle(instanceId, sock, phone, text) {
    // Busca ou cria contato
    const { rows } = await db.query(`
      INSERT INTO contacts (instance_id, phone)
      VALUES ($1, $2)
      ON CONFLICT (instance_id, phone) DO UPDATE SET last_seen = NOW()
      RETURNING *
    `, [instanceId, phone]);
    const contact = rows[0];

    // Salva mensagem recebida
    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent)
       VALUES ($1, $2, 'user', $3, 'user')`,
      [instanceId, contact.id, text]
    );

    // Verifica se está aguardando pergunta para tiragem (pós-pagamento)
    if (contact.stage === 'awaiting_question') {
      await this.handleOracleQuestion(instanceId, sock, contact, text);
      return;
    }

    // Busca fluxo correspondente no banco
    // Prioridade: gatilho exato > wildcard (*)
    const { rows: flows } = await db.query(`
      SELECT * FROM bot_flows
      WHERE instance_id = $1 AND active = TRUE
        AND (
          LOWER(trigger) = LOWER($2)
          OR trigger = '*'
        )
      ORDER BY
        CASE WHEN LOWER(trigger) = LOWER($2) THEN 0 ELSE 1 END,
        id ASC
      LIMIT 1
    `, [instanceId, text.trim()]);

    if (!flows.length) return; // Sem resposta configurada = silêncio

    const flow = flows[0];
    const reply = flow.response;

    // Atualiza etapa do contato
    if (flow.next_stage) {
      await db.query(
        `UPDATE contacts SET stage=$1 WHERE id=$2`,
        [flow.next_stage, contact.id]
      );
    }

    // Envia resposta
    await waManager.sendText(instanceId, phone, reply);

    // Salva resposta no log
    await db.query(
      `INSERT INTO messages (instance_id, contact_id, role, content, agent)
       VALUES ($1, $2, 'assistant', $3, 'bot')`,
      [instanceId, contact.id, reply]
    );
  }

  async handleOracleQuestion(instanceId, sock, contact, question) {
    const phone = contact.phone;

    // Mensagem de suspense
    const suspenseMsg = `🔮 As cartas estão sendo chamadas para você...\n\nRespirem juntas por um momento. Permita que sua energia se conecte com a pergunta.`;
    await waManager.sendText(instanceId, phone, suspenseMsg);
    await new Promise(r => setTimeout(r, 3000));

    try {
      // Gera leitura com IA
      const { interpretation, cards } = await generateOracleReading(contact, question);

      // Salva a tiragem
      await db.query(`
        INSERT INTO readings (contact_id, question, spread_type, cards_drawn, interpretation)
        VALUES ($1, $2, '3_cards', $3, $4)
      `, [contact.id, question, JSON.stringify(cards), interpretation]);

      // Envia em partes para parecer humano
      const parts = this.splitIntoParts(interpretation, 350);
      for (const part of parts) {
        await waManager.sendText(instanceId, phone, part);
        await new Promise(r => setTimeout(r, 1500));
      }

      // Mensagem de encerramento
      const closingMsg = `🌟 Que essa leitura ilumine seu caminho.\n\nSe quiser explorar outro aspecto da sua vida ou agendar uma nova consulta, é só me chamar. Que a sabedoria do oráculo te guie. 🙏✨`;
      await waManager.sendText(instanceId, phone, closingMsg);

      // Atualiza etapa
      await db.query(`UPDATE contacts SET stage='post_reading' WHERE id=$1`, [contact.id]);

      // Salva mensagens no log
      await db.query(
        `INSERT INTO messages (instance_id, contact_id, role, content, agent)
         VALUES ($1, $2, 'assistant', $3, 'oracle')`,
        [contact.instance_id, contact.id, interpretation]
      );

    } catch(e) {
      console.error('[ORACLE ERROR]', e.message);
      await waManager.sendText(instanceId, phone, '✨ Houve um problema ao gerar sua leitura. Tente novamente em instantes.');
    }
  }

  splitIntoParts(text, maxLength) {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const parts = [];
    let current = '';
    for (const s of sentences) {
      if ((current + s).length > maxLength) {
        if (current) parts.push(current.trim());
        current = s;
      } else {
        current += (current ? ' ' : '') + s;
      }
    }
    if (current) parts.push(current.trim());
    return parts;
  }
}

export const botEngine = new BotEngine();
