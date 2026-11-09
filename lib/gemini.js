'use strict';

/**
 * Provedor Gemini (chave do Google AI Studio).
 * Usa a Interactions API documentada em https://ai.google.dev/gemini-api/docs/speech-generation
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 * O áudio volta em WAV (24 kHz, 16 bits, mono). Este módulo o normaliza para um WAV
 * canônico de cabeçalho com 44 bytes, que o navegador usa para juntar as partes.
 */

const { AppError } = require('./google');

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Máximo de caracteres por chamada ao Gemini. Motivo: a Vercel limita a resposta a 4,5 MB e o WAV
// ocupa ~48 KB por segundo de áudio (≈ 90 s por resposta). O navegador envia partes de ~900 caracteres.
const MAX_REQUEST_CHARS = 1200;
const MAX_RESPONSE_BYTES = Math.floor(4.4 * 1024 * 1024);

// Modelos de voz listados na documentação oficial. "free": origem da informação sobre a faixa gratuita.
const MODELS = [
  {
    id: 'gemini-3.8-flash-tts',
    label: 'Gemini 3.8 Flash TTS',
    tag: 'Mais recente',
    detail: 'Gratuito segundo fontes de terceiros; confirme em aistudio.google.com/rate-limit',
  },
  {
    id: 'gemini-3.8-flash-lite-tts',
    label: 'Gemini 3.8 Flash-Lite TTS',
    tag: 'Mais leve',
    detail: 'Gratuito segundo fontes de terceiros; confirme em aistudio.google.com/rate-limit',
  },
  {
    id: 'gemini-3.1-flash-tts-preview',
    label: 'Gemini 3.1 Flash TTS (Preview)',
    tag: 'Preview',
    detail: 'Gratuito (confirmado na página oficial de preços)',
  },
  {
    id: 'gemini-2.5-flash-preview-tts',
    label: 'Gemini 2.5 Flash TTS (Preview)',
    tag: 'Preview',
    detail: 'Gratuito (confirmado na página oficial de preços)',
  },
];

// As 30 vozes pré-definidas listadas na documentação oficial do Gemini TTS.
// A documentação não informa o gênero de cada voz; por isso o app não exibe gênero para o Gemini.
const VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

const PACES = ['slow', 'normal', 'fast'];

function providerList() {
  const googleOk = Boolean((process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON || '').trim());
  const geminiOk = Boolean((process.env.GEMINI_API_KEY || '').trim());
  return [
    {
      id: 'google',
      label: 'Google Cloud TTS',
      available: googleOk,
      hint: 'Standard, WaveNet, Neural2 e Chirp 3 HD · MP3 · exige faturamento (cota gratuita mensal)',
      missing: 'Configure GOOGLE_TTS_SERVICE_ACCOUNT_JSON',
    },
    {
      id: 'gemini',
      label: 'Gemini (AI Studio)',
      available: geminiOk,
      hint: 'Vozes Gemini · WAV · chave gratuita do AI Studio, sem cartão',
      missing: 'Configure GEMINI_API_KEY',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* WAV                                                                 */
/* ------------------------------------------------------------------ */

function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'fmt ' && start + 16 <= buf.length) {
      fmt = { channels: buf.readUInt16LE(start + 2), sampleRate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      if (size === 0xffffffff || start + size > buf.length) size = buf.length - start;
      data = buf.subarray(start, start + size);
      break;
    }
    off = start + size + (size % 2);
  }
  if (!fmt || !data) return null;
  return { pcm: data, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits };
}

function makeWav(pcm, opts) {
  const o = Object.assign({ sampleRate: 24000, channels: 1, bits: 16 }, opts || {});
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(o.channels, 22);
  h.writeUInt32LE(o.sampleRate, 24);
  h.writeUInt32LE((o.sampleRate * o.channels * o.bits) / 8, 28);
  h.writeUInt16LE((o.channels * o.bits) / 8, 32);
  h.writeUInt16LE(o.bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Converte o que o Gemini devolveu (WAV com qualquer cabeçalho ou PCM cru) em WAV canônico. */
function normalizeAudio(buf) {
  const parsed = parseWav(buf);
  if (parsed) return makeWav(parsed.pcm, parsed);
  return makeWav(buf); // PCM cru: 24 kHz, 16 bits, mono (padrão documentado)
}

function findAudioData(node, depth) {
  const d = depth || 0;
  if (!node || typeof node !== 'object' || d > 10) return null;
  if (node.inlineData && typeof node.inlineData.data === 'string') return node.inlineData.data;
  if (node.type === 'audio' && typeof node.data === 'string') return node.data;
  const children = Array.isArray(node) ? node : Object.values(node);
  for (const c of children) {
    const r = findAudioData(c, d + 1);
    if (r) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Erros                                                               */
/* ------------------------------------------------------------------ */

function translateGeminiError(status, data, rawText) {
  const gErr = data && typeof data.error === 'object' && data.error ? data.error : null;
  const msg = (gErr && gErr.message) || (typeof rawText === 'string' ? rawText.slice(0, 300) : '') || '';
  const gStatus = (gErr && gErr.status) || '';
  const lower = `${msg} ${gStatus}`.toLowerCase();
  const tail = msg ? ` Detalhe do Google: "${String(msg).slice(0, 400)}"` : '';

  if (/api key not valid|api_key_invalid|api key expired|invalid api key/.test(lower) || status === 401) {
    return new AppError(
      500, 'GEMINI_AUTH',
      'O Google recusou a chave GEMINI_API_KEY (inválida, expirada ou apagada). Crie outra em https://aistudio.google.com/apikey, atualize a variável na Vercel e faça um novo deploy.' + tail
    );
  }
  if (status === 429 || gStatus === 'RESOURCE_EXHAUSTED' || /quota|rate limit|resource_exhausted/.test(lower)) {
    return new AppError(
      429, 'GEMINI_QUOTA',
      'O limite gratuito do Gemini API foi atingido (por minuto ou por dia, definido no seu projeto). Espere um pouco e tente de novo; o limite diário reinicia à meia-noite do horário do Pacífico. Veja seus limites em https://aistudio.google.com/rate-limit.' + tail,
      { 'Retry-After': '30' }
    );
  }
  if (status === 403 || gStatus === 'PERMISSION_DENIED') {
    return new AppError(
      403, 'GEMINI_PERMISSION',
      'O Google negou o acesso. Possíveis causas: a chave tem restrições, o projeto não pode usar este modelo ou o recurso não está liberado para o seu país.' + tail
    );
  }
  if (status === 404 || gStatus === 'NOT_FOUND') {
    return new AppError(404, 'MODEL_UNAVAILABLE', 'Este modelo ou voz não está disponível para a sua chave. Escolha outro modelo.' + tail);
  }
  if (/prohibited_content|blocked|safety/.test(lower)) {
    return new AppError(
      400, 'GEMINI_BLOCKED',
      'O Gemini recusou este trecho (conteúdo bloqueado ou pedido considerado ambíguo). Reescreva o trecho ou remova instruções de estilo.' + tail
    );
  }
  if (status === 400 || gStatus === 'INVALID_ARGUMENT') {
    return new AppError(400, 'INVALID_REQUEST', 'O Google recusou a solicitação.' + tail);
  }
  if (status >= 500) {
    return new AppError(503, 'GEMINI_UNAVAILABLE', 'O Gemini está indisponível ou instável no momento. Tente novamente em instantes.' + tail);
  }
  return new AppError(502, 'GEMINI_ERROR', `Erro inesperado ao falar com o Gemini (código ${status}).` + tail);
}

function networkError(e) {
  const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return new AppError(
    502, 'NETWORK',
    timeout
      ? 'O Gemini demorou demais para responder. Tente novamente com um texto menor.'
      : 'Não foi possível se comunicar com o Gemini (falha de rede). Tente novamente em instantes.'
  );
}

/* ------------------------------------------------------------------ */
/* Chamada à API                                                       */
/* ------------------------------------------------------------------ */

// O formato do campo "input" aparece de duas formas na documentação do Google (lista de itens
// ou texto simples). Tentamos o formato atual e, se o Google recusar o pedido, o formato alternativo.
const FORMATS = [
  {
    headers: {},
    body: (model, prompt, voice) => ({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text: prompt }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }),
  },
  {
    headers: { 'Api-Revision': '2026-05-20' },
    body: (model, prompt, voice) => ({
      model,
      input: prompt,
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }),
  },
];
let preferredFormat = 0;

async function post(format, model, prompt, voice) {
  const key = String(process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'x-goog-api-key': key }, format.headers),
      body: JSON.stringify(format.body(model, prompt, voice)),
      signal: AbortSignal.timeout(52000),
    });
  } catch (e) {
    throw networkError(e);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  if (!res.ok) throw translateGeminiError(res.status, data, raw);
  return data;
}

function buildPrompt({ text, languageCode, style, pace }) {
  const parts = ['Read the following transcript aloud'];
  if (languageCode === 'pt-BR') parts.push('in natural Brazilian Portuguese');
  else parts.push('in the language it is written in');
  if (pace === 'slow') parts.push('at a slow, relaxed pace');
  if (pace === 'fast') parts.push('at a brisk pace');
  let preamble = parts.join(', ') + '.';
  if (style) preamble += ` Style: ${style}.`;
  preamble += ' Speak only the transcript; do not read these instructions aloud.';
  return `${preamble}\n\nTRANSCRIPT:\n${text}`;
}

/** Gera o áudio de UM trecho. Retorna um Buffer WAV canônico. */
async function synthesize(params) {
  const prompt = buildPrompt(params);
  let lastErr = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let data;
      const order = preferredFormat === 0 ? [0, 1] : [1, 0];
      let firstErr = null;
      for (const idx of order) {
        try {
          data = await post(FORMATS[idx], params.model, prompt, params.voiceName);
          preferredFormat = idx;
          firstErr = null;
          break;
        } catch (e) {
          if (e instanceof AppError && e.status === 400 && e.code === 'INVALID_REQUEST' && idx === order[0]) {
            firstErr = e; // tenta o formato alternativo
            continue;
          }
          throw firstErr || e;
        }
      }
      if (!data) throw firstErr;

      const b64 = findAudioData(data);
      if (!b64) {
        // A documentação avisa que o modelo às vezes devolve texto no lugar de áudio: tentar de novo.
        throw new AppError(502, 'EMPTY_AUDIO', 'O Gemini respondeu sem áudio (às vezes ele devolve texto em vez de voz). Tente novamente.');
      }
      const wav = normalizeAudio(Buffer.from(b64, 'base64'));
      if (wav.length > MAX_RESPONSE_BYTES) {
        throw new AppError(413, 'AUDIO_TOO_LARGE', 'O áudio deste trecho passou do limite de 4,5 MB da Vercel. Use partes menores.');
      }
      return wav;
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof AppError && (e.code === 'EMPTY_AUDIO' || e.code === 'GEMINI_UNAVAILABLE');
      if (!retryable) throw e;
    }
  }
  throw lastErr;
}

module.exports = {
  MODELS,
  VOICES,
  PACES,
  MAX_REQUEST_CHARS,
  providerList,
  synthesize,
  buildPrompt,
  parseWav,
  makeWav,
};
