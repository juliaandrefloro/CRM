// ─────────────────────────────────────────────
//  Autenticação simples por sessão (cookie 7d)
// ─────────────────────────────────────────────
import bcrypt from 'bcryptjs';

// Credenciais do painel (hash gerado em tempo de carregamento)
const ADMIN_EMAIL = 'julia_andre2009@hotmail.com';
const ADMIN_HASH  = bcrypt.hashSync('Julia123', 10);

/**
 * Middleware: bloqueia rotas protegidas se não estiver logado.
 * Rotas públicas: GET /login, POST /api/auth/login, GET /api/auth/logout
 */
export function requireAuth(req, res, next) {
  const publicPaths = [
    '/login',
    '/api/auth/login',
    '/api/auth/logout',
  ];

  if (publicPaths.includes(req.path)) return next();

  // Permite acesso ao webhook do WhatsApp sem autenticação
  if (req.path.startsWith('/api/webhook')) return next();

  if (req.session && req.session.authenticated) return next();

  // Requisições de API retornam 401 JSON
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  // Requisições de página redirecionam para /login
  return res.redirect('/login');
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
export async function loginHandler(req, res) {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  const emailOk    = email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
  const passwordOk = bcrypt.compareSync(password, ADMIN_HASH);

  if (!emailOk || !passwordOk) {
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }

  req.session.authenticated = true;
  req.session.email = email.trim().toLowerCase();

  return res.json({ ok: true });
}

/**
 * GET /api/auth/logout
 */
export function logoutHandler(req, res) {
  req.session.destroy(() => {
    res.clearCookie('crm.sid');
    res.redirect('/login');
  });
}
