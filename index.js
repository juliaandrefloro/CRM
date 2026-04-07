import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { fileURLToPath } from 'url';
import path from 'path';

import instancesRouter from './src/routes/instances.js';
import chatbotRouter   from './src/routes/chatbot.js';
import messagesRouter  from './src/routes/messages.js';
import dashboardRouter from './src/routes/dashboard.js';
import webhookRouter   from './src/routes/webhook.js';
import agentsRouter    from './src/routes/agents.js';
import { initDB }      from './src/db.js';
import { waManager }   from './src/whatsapp.js';
import { requireAuth, loginHandler, logoutHandler } from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (Railway usa proxy reverso) ──────────────────────────────────
app.set('trust proxy', 1);

// ── Sessão ──────────────────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || 'crm-tarot-secret-2026-xK9mP';

app.use(session({
  name: 'crm.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,       // Railway sempre usa HTTPS
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
  },
}));

// ── Middlewares gerais ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Autenticação ─────────────────────────────────────────────────────────────
// Rotas públicas de auth (antes do requireAuth)
app.post('/api/auth/login',  loginHandler);
app.get('/api/auth/logout',  logoutHandler);

// Serve a página de login (arquivo estático público)
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Middleware de proteção — bloqueia tudo que não for público
app.use(requireAuth);

// ── Arquivos estáticos (só acessíveis após login) ────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Rotas da API ─────────────────────────────────────────────────────────────
app.use('/api/instances', instancesRouter);
app.use('/api/chatbot',   chatbotRouter);
app.use('/api/messages',  messagesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/webhook',   webhookRouter);
app.use('/api/agents',    agentsRouter);

// ── Inicialização ─────────────────────────────────────────────────────────────
await initDB();

app.listen(PORT, () => {
  console.log(`\n🔮 CRM Tarot rodando em http://localhost:${PORT}`);
  console.log('🔐 Painel protegido por autenticação\n');
});

// Reconecta instâncias ativas ao reiniciar
waManager.reconnectAll();
