# 🔮 CRM Tarot

CRM completo para consultas de Tarot via WhatsApp, com chatbot configurável, múltiplos números, agente de IA (Oráculo) e integração com pagamentos via Asaas/Pix.

---

## Instalação Rápida (Mac)

```bash
bash instalar-mac.sh
```

---

## Pré-requisitos

- **Node.js 18+** → [nodejs.org](https://nodejs.org)
- **Banco de dados PostgreSQL** → Crie grátis em [supabase.com](https://supabase.com)
- **Número de WhatsApp dedicado** (chip separado, não seu número pessoal)

---

## Configuração

1. Copie o arquivo de exemplo:
   ```bash
   cp .env.example .env
   ```

2. Edite o `.env` com suas credenciais:
   ```
   DATABASE_URL=postgresql://...     # Do Supabase
   ANTHROPIC_API_KEY=sk-ant-...      # Para o Agente Oráculo
   ASAAS_API_KEY=...                 # Para gerar cobranças Pix
   ```

---

## Iniciar

```bash
node index.js
```

Acesse: **http://localhost:3000**

---

## Funcionalidades

| Módulo | Descrição |
|--------|-----------|
| 📱 WhatsApp | Conecte múltiplos números via QR Code |
| 💬 Conversas | Histórico completo + envio manual |
| 🤖 Chatbot | Gatilhos configuráveis com fluxos encadeados |
| 🔮 Oráculo IA | Leitura de tarot com IA após pagamento |
| 💳 Pagamentos | Geração automática de Pix via Asaas |
| 📊 Dashboard | Métricas em tempo real |

---

## Agentes de IA

- **Lumina** (Recepção): Recebe clientes, apresenta tiragens e valores
- **Isis** (Oráculo): Realiza a leitura após pagamento confirmado
- **Remarketing**: Mensagens automáticas para leads inativos

---

## Webhook Asaas

Configure no painel do Asaas:
- **URL**: `https://seu-dominio.com/api/webhook/asaas`
- **Token**: Mesmo valor do `ASAAS_WEBHOOK_TOKEN` no `.env`

---

## Stack

- **Backend**: Node.js + Express
- **Banco**: PostgreSQL (Supabase)
- **WhatsApp**: Baileys (open source)
- **IA**: Claude (Anthropic)
- **Pagamentos**: Asaas/Pix
