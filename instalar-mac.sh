#!/bin/bash
# =============================================
# CRM Tarot — Script de Instalação para Mac
# =============================================
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "🔮 CRM Tarot — Instalando dependências..."
echo ""

# Verifica Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js não encontrado."
  echo "   Instale em: https://nodejs.org (versão LTS)"
  exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js v${NODE_VER} detectado. Precisa da versão 18+."
  echo "   Atualize em: https://nodejs.org"
  exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v) encontrado${NC}"

# Instala dependências
echo ""
echo "📦 Instalando pacotes npm..."
npm install

# Cria .env se não existir
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo -e "${YELLOW}⚠️  Arquivo .env criado a partir do .env.example${NC}"
  echo -e "${YELLOW}   Por favor, configure o DATABASE_URL antes de iniciar!${NC}"
fi

# Cria pasta de sessões WhatsApp
mkdir -p sessions

echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Instalação concluída!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${CYAN}Próximos passos:${NC}"
echo ""
echo "  1. Configure o banco de dados no arquivo .env"
echo "     → Crie uma conta grátis em https://supabase.com"
echo "     → Copie a Connection String e cole no DATABASE_URL"
echo ""
echo "  2. Inicie o servidor:"
echo "     node index.js"
echo ""
echo "  3. Acesse: http://localhost:3000"
echo "     → Vá em 📱 WhatsApp → Adicionar WhatsApp"
echo "     → Escaneie o QR Code com o chip dedicado"
echo ""
echo "🔮 Pronto para consultar as cartas!"
echo ""
