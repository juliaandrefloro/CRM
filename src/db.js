import pg from 'pg';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function initDB() {
  await db.query(`
    -- Instâncias WhatsApp
    CREATE TABLE IF NOT EXISTS wa_instances (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(80) NOT NULL,
      phone       VARCHAR(20),
      status      VARCHAR(20) DEFAULT 'disconnected',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Contatos (clientes que enviaram mensagem)
    CREATE TABLE IF NOT EXISTS contacts (
      id          SERIAL PRIMARY KEY,
      instance_id INTEGER REFERENCES wa_instances(id) ON DELETE CASCADE,
      phone       VARCHAR(20) NOT NULL,
      name        VARCHAR(120),
      stage       VARCHAR(40) DEFAULT 'start',
      area_of_life VARCHAR(30),
      last_seen   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(instance_id, phone)
    );

    -- Histórico de mensagens
    CREATE TABLE IF NOT EXISTS messages (
      id          BIGSERIAL PRIMARY KEY,
      instance_id INTEGER REFERENCES wa_instances(id) ON DELETE CASCADE,
      contact_id  INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      role        VARCHAR(10) NOT NULL,
      content     TEXT NOT NULL,
      agent       VARCHAR(20) DEFAULT 'bot',
      sent_at     TIMESTAMPTZ DEFAULT NOW()
    );

    -- Fluxos do chatbot (gatilho → resposta)
    CREATE TABLE IF NOT EXISTS bot_flows (
      id          SERIAL PRIMARY KEY,
      instance_id INTEGER REFERENCES wa_instances(id) ON DELETE CASCADE,
      trigger     VARCHAR(200) NOT NULL,
      response    TEXT NOT NULL,
      next_stage  VARCHAR(40),
      active      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Pagamentos via Asaas/Pix
    CREATE TABLE IF NOT EXISTS payments (
      id              SERIAL PRIMARY KEY,
      instance_id     INTEGER REFERENCES wa_instances(id) ON DELETE CASCADE,
      contact_id      INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      asaas_id        VARCHAR(60) UNIQUE,
      amount          NUMERIC(10,2) NOT NULL,
      pix_qr_code     TEXT,
      pix_copy_paste  TEXT,
      status          VARCHAR(20) DEFAULT 'PENDING',
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at    TIMESTAMPTZ
    );

    -- Tiragens realizadas
    CREATE TABLE IF NOT EXISTS readings (
      id              SERIAL PRIMARY KEY,
      contact_id      INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      payment_id      INTEGER REFERENCES payments(id),
      question        TEXT NOT NULL,
      spread_type     VARCHAR(30) DEFAULT '3_cards',
      cards_drawn     JSONB,
      interpretation  TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- Agentes de IA (Fábrica de Agentes)
    CREATE TABLE IF NOT EXISTS ai_agents (
      id              SERIAL PRIMARY KEY,
      instance_id     INTEGER REFERENCES wa_instances(id) ON DELETE CASCADE,
      name            VARCHAR(80)  NOT NULL,
      avatar          VARCHAR(10)  DEFAULT '🤖',
      system_prompt   TEXT         NOT NULL,
      model           VARCHAR(60)  DEFAULT 'claude-haiku-4-5',
      provider        VARCHAR(20)  DEFAULT 'anthropic',
      api_key         TEXT,
      flow_config     JSONB        DEFAULT '{}',
      active          BOOLEAN      DEFAULT FALSE,
      created_at      TIMESTAMPTZ  DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  DEFAULT NOW()
    );

    -- Jobs de remarketing
    CREATE TABLE IF NOT EXISTS remarketing_jobs (
      id            SERIAL PRIMARY KEY,
      contact_id    INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
      scheduled_at  TIMESTAMPTZ NOT NULL,
      sent_at       TIMESTAMPTZ,
      message_type  VARCHAR(30) DEFAULT 'energy_of_day',
      status        VARCHAR(20) DEFAULT 'pending'
    );

    -- Sessões WhatsApp (persistência entre deploys)
    CREATE TABLE IF NOT EXISTS wa_sessions (
      instance_id  INTEGER PRIMARY KEY REFERENCES wa_instances(id) ON DELETE CASCADE,
      session_data JSONB NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );

    -- Índices de performance
    CREATE INDEX IF NOT EXISTS idx_messages_contact   ON messages(contact_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone     ON contacts(instance_id, phone);
    CREATE INDEX IF NOT EXISTS idx_payments_asaas     ON payments(asaas_id);
    CREATE INDEX IF NOT EXISTS idx_remarketing_sched  ON remarketing_jobs(scheduled_at, status);
  `);
  // Migrações seguras (ADD COLUMN IF NOT EXISTS)
  await db.query(`
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(60);
    ALTER TABLE contacts ADD COLUMN IF NOT EXISTS preferred_spread VARCHAR(30);
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS spread_type VARCHAR(30);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES ai_agents(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agents_instance ON ai_agents(instance_id, active);
  `);

  console.log('✅ Banco de dados pronto');
}
