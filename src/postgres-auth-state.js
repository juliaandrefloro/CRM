/**
 * usePostgresAuthState — v2 (TEXT storage)
 * ─────────────────────────────────────────────────────────────────────────────
 * Persiste credenciais e chaves do Baileys no PostgreSQL usando colunas TEXT.
 *
 * Por que TEXT e não JSONB?
 * O Baileys serializa Buffers com BufferJSON.replacer, produzindo strings como:
 *   {"type":"Buffer","data":[1,2,3]}
 * Se armazenado como JSONB, o PostgreSQL converte para objeto nativo e o
 * BufferJSON.reviver não consegue reconstruir os Buffers corretamente,
 * causando falha silenciosa na autenticação e loop de QR Code.
 *
 * Tabelas:
 *   wa_auth_creds_v2  — credenciais principais (TEXT)
 *   wa_auth_keys_v2   — chaves Signal Protocol (TEXT)
 */

import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { db } from './db.js';

// ─── Garante que as tabelas existem ──────────────────────────────────────────
export async function ensureAuthTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_auth_creds_v2 (
      instance_id  INTEGER PRIMARY KEY,
      creds_text   TEXT    NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wa_auth_keys_v2 (
      instance_id  INTEGER NOT NULL,
      key_type     TEXT    NOT NULL,
      key_id       TEXT    NOT NULL,
      key_text     TEXT    NOT NULL,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (instance_id, key_type, key_id)
    );

    CREATE INDEX IF NOT EXISTS idx_wa_auth_keys_v2_inst
      ON wa_auth_keys_v2(instance_id, key_type);
  `);
}

// ─── Serialização / Deserialização ───────────────────────────────────────────
function serialize(obj) {
  return JSON.stringify(obj, BufferJSON.replacer);
}

function deserialize(str) {
  if (!str || str === 'null') return null;
  try {
    return JSON.parse(str, BufferJSON.reviver);
  } catch (e) {
    console.error('[AUTH DESERIALIZE ERROR]', e.message);
    return null;
  }
}

// ─── Implementação principal ──────────────────────────────────────────────────
export async function usePostgresAuthState(instanceId) {
  await ensureAuthTables();

  // ── Lê credenciais do banco ──────────────────────────────────────────────
  async function readCreds() {
    try {
      const { rows } = await db.query(
        `SELECT creds_text FROM wa_auth_creds_v2 WHERE instance_id = $1`,
        [instanceId]
      );
      if (!rows.length || !rows[0].creds_text) {
        console.log(`[AUTH] Nenhuma credencial salva para instância ${instanceId} — iniciando nova sessão`);
        return initAuthCreds();
      }
      const parsed = deserialize(rows[0].creds_text);
      if (!parsed) {
        console.log(`[AUTH] Credencial inválida para instância ${instanceId} — iniciando nova sessão`);
        return initAuthCreds();
      }
      console.log(`[AUTH] Credenciais carregadas do banco para instância ${instanceId}`);
      return parsed;
    } catch (e) {
      console.error(`[AUTH READ ERROR] instância ${instanceId}:`, e.message);
      return initAuthCreds();
    }
  }

  // ── Salva credenciais no banco ───────────────────────────────────────────
  async function writeCreds(creds) {
    try {
      const text = serialize(creds);
      await db.query(`
        INSERT INTO wa_auth_creds_v2 (instance_id, creds_text, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (instance_id) DO UPDATE
          SET creds_text = $2, updated_at = NOW()
      `, [instanceId, text]);
    } catch (e) {
      console.error(`[AUTH WRITE ERROR] instância ${instanceId}:`, e.message);
    }
  }

  // ── Implementação de SignalKeyStore ──────────────────────────────────────
  const keys = {
    async get(type, ids) {
      if (!ids?.length) return {};
      try {
        const placeholders = ids.map((_, i) => `$${i + 3}`).join(', ');
        const { rows } = await db.query(`
          SELECT key_id, key_text
          FROM wa_auth_keys_v2
          WHERE instance_id = $1 AND key_type = $2 AND key_id IN (${placeholders})
        `, [instanceId, type, ...ids]);

        const result = {};
        for (const row of rows) {
          const val = deserialize(row.key_text);
          if (val !== null) {
            result[row.key_id] = val;
          }
        }
        return result;
      } catch (e) {
        console.error(`[AUTH KEYS GET ERROR] tipo=${type}:`, e.message);
        return {};
      }
    },

    async set(data) {
      if (!data || !Object.keys(data).length) return;

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        for (const [type, keyMap] of Object.entries(data)) {
          if (!keyMap) continue;
          for (const [id, value] of Object.entries(keyMap)) {
            if (value === null || value === undefined) {
              await client.query(`
                DELETE FROM wa_auth_keys_v2
                WHERE instance_id=$1 AND key_type=$2 AND key_id=$3
              `, [instanceId, type, id]);
            } else {
              const text = serialize(value);
              await client.query(`
                INSERT INTO wa_auth_keys_v2 (instance_id, key_type, key_id, key_text, updated_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (instance_id, key_type, key_id) DO UPDATE
                  SET key_text = $4, updated_at = NOW()
              `, [instanceId, type, id, text]);
            }
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.error('[AUTH KEYS SET ERROR]', e.message);
        throw e;
      } finally {
        client.release();
      }
    },

    async clear() {
      await db.query(
        `DELETE FROM wa_auth_keys_v2 WHERE instance_id = $1`,
        [instanceId]
      );
    }
  };

  // ── Carrega estado inicial ───────────────────────────────────────────────
  const creds = await readCreds();
  const state = { creds, keys };

  // ── saveCreds: chamado pelo Baileys em creds.update ──────────────────────
  const saveCreds = async () => {
    await writeCreds(state.creds);
  };

  return { state, saveCreds };
}

// ─── Remove sessão do banco (logout) ─────────────────────────────────────────
export async function deleteAuthState(instanceId) {
  await db.query(`DELETE FROM wa_auth_creds_v2 WHERE instance_id = $1`, [instanceId]);
  await db.query(`DELETE FROM wa_auth_keys_v2  WHERE instance_id = $1`, [instanceId]);
}
