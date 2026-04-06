import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';

import instancesRouter from './src/routes/instances.js';
import chatbotRouter   from './src/routes/chatbot.js';
import messagesRouter  from './src/routes/messages.js';
import dashboardRouter from './src/routes/dashboard.js';
import webhookRouter   from './src/routes/webhook.js';
import { initDB }      from './src/db.js';
import { waManager }   from './src/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/instances', instancesRouter);
app.use('/api/chatbot',   chatbotRouter);
app.use('/api/messages',  messagesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/webhook',   webhookRouter);

// Inicializa banco e servidor
await initDB();

app.listen(PORT, () => {
  console.log(`\n🔮 CRM Tarot rodando em http://localhost:${PORT}`);
  console.log('📱 Acesse o painel e adicione um WhatsApp na aba "WhatsApp"\n');
});

// Reconecta instâncias ativas ao reiniciar
waManager.reconnectAll();
