import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import fs from 'fs';
import path from 'path';

const ai = new Anthropic();

// ─── Informações de Pagamento ──────────────────────────────────────────────────

export const PAYMENT_INFO = `
💳 *FORMAS DE PAGAMENTO*

Aceitamos:
• Pix (pagamento instantâneo)
• Transferência bancária

*Dados para Pix:*
Chave Pix: vitoriamistica@gmail.com
Titular: Julia Andrade Floro

Após o pagamento, envie o comprovante aqui mesmo nesta conversa. Assim que confirmarmos, Isis realizará sua tiragem com toda a atenção e cuidado que você merece. 🔮✨
`;

export const SPREADS = {
  '3_cards': {
    name: 'Tiragem de 3 Cartas',
    subtitle: 'Passado · Presente · Futuro',
    price: 35.00,
    description: 'Uma visão clara e direta sobre o momento que você está vivendo. Ideal para quem busca uma resposta objetiva.',
    emoji: '🌙'
  },
  'horseshoe': {
    name: 'Tiragem em Ferradura',
    subtitle: '7 cartas — visão ampla',
    price: 65.00,
    description: 'Uma análise mais completa, revelando forças internas, externas e o caminho que se abre à sua frente.',
    emoji: '🌟'
  },
  'celtic_cross': {
    name: 'Cruz Céltica',
    subtitle: '10 cartas — análise profunda',
    price: 99.00,
    description: 'A tiragem mais completa do Tarot. Para quem deseja uma leitura profunda e transformadora sobre uma situação importante da vida.',
    emoji: '🔮'
  },
  'mandala': {
    name: 'Mandala dos Arquétipos',
    subtitle: 'Sessão especial de 60 minutos',
    price: 150.00,
    description: 'Uma jornada de autoconhecimento guiada por Isis, integrando Tarot, arquétipos junguianos e orientação espiritual personalizada.',
    emoji: '✨'
  }
};

// ─── System Prompts dos Agentes ────────────────────────────────────────────────

export function buildReceptionPrompt(clientName = null) {
  const nameContext = clientName
    ? `O nome desta pessoa é ${clientName}. Use o nome dela de forma natural e acolhedora ao longo da conversa — não em toda frase, mas o suficiente para que ela se sinta vista e reconhecida.`
    : `Você ainda não sabe o nome desta pessoa. Na sua primeira mensagem, pergunte o nome dela de forma natural e acolhedora, como parte da saudação.`;

  return `
Você é Lumina, a guardiã da entrada deste espaço sagrado de autoconhecimento do CRM Tarot Vítoria Mística.
Sua função é receber cada pessoa com acolhimento genuíno, entender o que a trouxe até aqui, apresentar os serviços de Tarot e guiar o cliente até o momento do pagamento.

${nameContext}

PERSONALIDADE:
- Calorosa, empática e intuitiva, mas também profissional e organizada
- Usa linguagem acessível, com pitadas de vocabulário místico sem exageros
- Nunca é robótica. Adapta o tom ao estado emocional percebido na mensagem
- Acredita genuinamente que o tarot é uma ferramenta de autoconhecimento
- Usa emojis com moderação para dar leveza (🌙 🔮 ✨ 🙏 💜)

FLUXO DA CONVERSA:
1. Saudação calorosa — se não souber o nome, pergunte
2. Após saber o nome, pergunte sobre a área de vida (Amor, Trabalho, Espiritualidade, Saúde, Finanças)
3. Com base na área escolhida, apresente as opções de tiragem com empatia e valores
4. Quando o cliente escolher, apresente as informações de pagamento de forma clara
5. Confirme o recebimento do comprovante e informe que Isis realizará a leitura em breve

TIRAGENS DISPONÍVEIS:
🌙 Tiragem de 3 Cartas (Passado/Presente/Futuro): R$ 35,00
   → Ideal para quem busca uma resposta objetiva e direta

🌟 Tiragem em Ferradura (7 cartas, visão ampla): R$ 65,00
   → Para uma análise mais completa das forças em jogo

🔮 Cruz Céltica (10 cartas, análise profunda): R$ 99,00
   → A tiragem mais completa para situações importantes

✨ Mandala dos Arquétipos (sessão especial 60min): R$ 150,00
   → Uma jornada de autoconhecimento com Isis

DADOS DE PAGAMENTO (apresente quando o cliente escolher):
Pix: vitoriamistica@gmail.com
Titular: Julia Andrade Floro
Peça para enviar o comprovante nesta conversa.

REGRAS IMPORTANTES:
- Nunca invente informações sobre o cliente ou situações específicas de vida dele
- Nunca prometa resultados absolutos ("você VAI encontrar o amor")
- Prefira formulações abertas ("as cartas podem iluminar esse caminho")
- Se o cliente parecer em crise grave, recomende gentilmente apoio profissional
- Limite mensagens a no máximo 3 parágrafos curtos
- Quando o cliente enviar comprovante, responda com acolhimento e informe que Isis está sendo chamada para a leitura

Escreva sempre em português do Brasil. Assine como Lumina.
`;
}

export function buildOraclePrompt(clientName = null) {
  const nameContext = clientName
    ? `O nome desta pessoa é ${clientName}. Use o nome dela com carinho ao longo da leitura, especialmente na abertura e na mensagem final.`
    : '';

  return `
Você é Isis, taróloga e orientadora espiritual com 20 anos de experiência.
Você integra conhecimento simbólico do Tarot de Waite, Petit Lenormand e arquétipos junguianos para oferecer leituras terapêuticas e transformadoras.

${nameContext}

FILOSOFIA DE LEITURA:
- O tarot não prevê o futuro de forma determinista; ele revela padrões energéticos e possibilidades baseadas na energia atual da pessoa
- Cada carta é um espelho da psique, não um veredicto
- Sua leitura é sempre orientada para o empoderamento, nunca para o medo
- Você considera o contexto emocional da pergunta

ESTRUTURA DA LEITURA (siga sempre esta ordem):
1. ABERTURA (1 parágrafo): Acolha a pergunta com empatia, sem julgamento. Se souber o nome, use-o aqui.
2. AS CARTAS (1 parágrafo por carta): Descreva a carta, seu simbolismo e conexão com a situação.
   Para cartas invertidas, fale em energias bloqueadas ou em transformação — nunca em "má sorte"
3. SÍNTESE (1 parágrafo): Una as cartas em uma narrativa coerente
4. MENSAGEM FINAL (1 parágrafo curto): Uma orientação prática e amorosa. Se souber o nome, use-o aqui.

CONHECIMENTO TÉCNICO:
- Arcanos Maiores: forças universais e momentos de transformação profunda
- Arcanos Menores: situações cotidianas e energias mais transitórias
- Naipes: Ouros (matéria/finanças), Copas (emoção/amor), Espadas (mente/conflito), Paus (ação/criatividade)
- Cartas invertidas: energia bloqueada ou em transição, convite à introspecção
- Arquétipos junguianos: conecte cartas a Sombra, Anima/Animus, Self quando relevante

LINGUAGEM:
- Usa "você" de forma calorosa e direta
- Usa expressões como: "as cartas sugerem", "a energia indica", "um convite para refletir"
- Evita: "destino selado", "maldição", "você vai sofrer"

ÉTICA ABSOLUTA:
- Nunca faça diagnósticos médicos ou psicológicos
- Se perceber sofrimento intenso, encaminhe para apoio profissional
- Nunca aceite perguntas invasivas sobre terceiros sem consentimento

Escreva em português do Brasil. Tom: íntimo, sábio, amoroso e esperançoso.
`;
}

export const REMARKETING_SYSTEM_PROMPT = `
Você é Lumina em modo de acompanhamento. Um cliente demonstrou interesse mas não finalizou.
Seu objetivo é reconectar com essa pessoa de forma genuína e não invasiva.

REGRAS:
- Máximo 1 mensagem por dia, máximo 3 mensagens no ciclo
- Nunca seja insistente ou pressione com urgência falsa
- A mensagem deve ter valor em si mesma (reflexão, dica, energia do dia)
- Ao final, faça um convite suave

EXEMPLO (Energia do Dia):
"🌟 Bom dia! Hoje o arcano que se apresenta é A Roda da Fortuna — um lembrete de
que os ciclos se movem, mesmo quando tudo parece parado. Quando sentir que é hora
de uma nova perspectiva, as cartas estarão aqui esperando por você. 🙏"

Sempre assine como Lumina. Nunca mencione que a pessoa "não pagou" ou "abandonou".
Escreva em português do Brasil.
`;

// ─── Sorteio de Cartas ─────────────────────────────────────────────────────────

export function drawTarotCards(spreadType = '3_cards') {
  const majorArcana = [
    'O Louco','O Mago','A Sacerdotisa','A Imperatriz','O Imperador',
    'O Hierofante','Os Amantes','O Carro','A Justiça','O Eremita',
    'A Roda da Fortuna','A Força','O Enforcado','A Morte','A Temperança',
    'O Diabo','A Torre','A Estrela','A Lua','O Sol','O Julgamento','O Mundo'
  ];
  const minorSuits = ['Ouros','Copas','Espadas','Paus'];
  const minorRanks = ['Ás','2','3','4','5','6','7','8','9','10','Valete','Cavaleiro','Rainha','Rei'];

  const deck = [...majorArcana];
  minorSuits.forEach(suit => minorRanks.forEach(rank => deck.push(`${rank} de ${suit}`)));

  const positions = {
    '3_cards':    ['Passado','Presente','Futuro'],
    'horseshoe':  ['Passado','Presente','Futuro próximo','Forças internas','Forças externas','Esperanças/medos','Desfecho'],
    'celtic_cross': ['Situação','Desafio','Raiz','Passado','Possível futuro','Futuro próximo','Você mesmo','Ambiente','Esperanças','Desfecho'],
    'mandala':    ['Eu sou','Minha sombra','Meu potencial','Meu coração','Minha mente','Minha alma','Meu caminho']
  };

  const pos = positions[spreadType] || positions['3_cards'];
  const shuffled = [...deck].sort(() => Math.random() - 0.5);

  return pos.map((position, i) => ({
    position,
    card: shuffled[i],
    reversed: Math.random() < 0.33
  }));
}

// ─── Transcrição de Áudio ──────────────────────────────────────────────────────

export async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  try {
    // Determina extensão correta
    const ext = mimeType.includes('ogg') ? 'ogg'
              : mimeType.includes('mp4') ? 'mp4'
              : mimeType.includes('mpeg') || mimeType.includes('mp3') ? 'mp3'
              : 'ogg';

    const tmpPath = `/tmp/audio_${Date.now()}.${ext}`;
    fs.writeFileSync(tmpPath, audioBuffer);

    // Usa a API Whisper via OpenAI SDK (compatível com Anthropic key via proxy)
    // Aqui usamos o endpoint OpenAI diretamente
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY });

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'pt',
      response_format: 'text'
    });

    // Limpa arquivo temporário
    try { fs.unlinkSync(tmpPath); } catch(e) {}

    return transcription || '';
  } catch(e) {
    console.error('[AUDIO TRANSCRIPTION ERROR]', e.message);
    return null;
  }
}

// ─── Gera Resposta de Recepção com IA (Lumina) ────────────────────────────────

export async function generateReceptionResponse(contact, userMessage) {
  // Busca histórico recente
  const { rows: history } = await db.query(`
    SELECT role, content FROM messages
    WHERE contact_id = $1
    ORDER BY sent_at DESC LIMIT 20
  `, [contact.id]);

  const messages = [
    ...history.reverse().map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    })),
    { role: 'user', content: userMessage }
  ];

  const response = await ai.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600,
    system: buildReceptionPrompt(contact.name),
    messages
  });

  return response.content[0].text;
}

// ─── Extrai Nome da Resposta do Cliente ───────────────────────────────────────

export async function extractNameFromMessage(message) {
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 50,
      system: `Você é um extrator de nomes. Analise a mensagem e extraia APENAS o primeiro nome da pessoa, se ela estiver se apresentando ou respondendo a uma pergunta sobre seu nome. 
      Retorne SOMENTE o nome (ex: "Maria") ou "null" se não houver nome claro na mensagem.
      Não retorne frases, apenas o nome ou a palavra null.`,
      messages: [{ role: 'user', content: message }]
    });
    const extracted = response.content[0].text.trim();
    return extracted === 'null' ? null : extracted;
  } catch(e) {
    return null;
  }
}

// ─── Detecta Intenção do Cliente ──────────────────────────────────────────────

export async function detectIntent(message) {
  try {
    const response = await ai.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 30,
      system: `Classifique a intenção da mensagem em UMA das categorias abaixo. Retorne APENAS a categoria, sem explicações:
- GREETING: saudação inicial (oi, olá, bom dia, etc.)
- NAME_RESPONSE: pessoa está informando seu nome
- AREA_CHOICE: escolhendo área de vida (amor, trabalho, saúde, finanças, espiritualidade)
- SPREAD_CHOICE: escolhendo tipo de tiragem ou perguntando sobre preços
- PAYMENT_SENT: enviando comprovante ou dizendo que pagou
- QUESTION_FOR_READING: fazendo pergunta para a tiragem de tarot
- GENERAL: qualquer outra mensagem`,
      messages: [{ role: 'user', content: message }]
    });
    return response.content[0].text.trim();
  } catch(e) {
    return 'GENERAL';
  }
}

// ─── Gera Leitura com IA (Isis) ───────────────────────────────────────────────

export async function generateOracleReading(contact, question, spreadType = '3_cards') {
  const cards = drawTarotCards(spreadType);

  // Busca histórico recente do contato
  const { rows: history } = await db.query(`
    SELECT role, content FROM messages
    WHERE contact_id = $1
    ORDER BY sent_at DESC LIMIT 15
  `, [contact.id]);

  // Busca tiragens anteriores para contexto contínuo
  const { rows: pastReadings } = await db.query(`
    SELECT question, cards_drawn, created_at FROM readings
    WHERE contact_id = $1
    ORDER BY created_at DESC LIMIT 3
  `, [contact.id]);

  const cardsText = cards.map(c =>
    `• ${c.position}: **${c.card}**${c.reversed ? ' (invertida)' : ''}`
  ).join('\n');

  const pastContext = pastReadings.length > 0
    ? `\n\nConsultas anteriores desta pessoa:\n${pastReadings.map(r =>
        `- "${r.question}" em ${new Date(r.created_at).toLocaleDateString('pt-BR')}`
      ).join('\n')}`
    : '';

  const messages = [
    ...history.reverse().map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    {
      role: 'user',
      content: `Pergunta da consulta: "${question}"\n\nCartas sorteadas:\n${cardsText}${pastContext}\n\nPor favor, faça a leitura completa.`
    }
  ];

  const response = await ai.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1500,
    system: buildOraclePrompt(contact.name),
    messages
  });

  return {
    interpretation: response.content[0].text,
    cards
  };
}
