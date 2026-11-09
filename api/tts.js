'use strict';

/**
 * POST /api/tts
 *
 * Corpo (JSON), provider = "google" (padrão):
 *   text          string  Texto a converter (até 12.000 caracteres)
 *   languageCode  string  Ex.: "pt-BR"
 *   voiceName     string  Nome de uma voz retornada por /api/voices
 *   speakingRate  number  Velocidade (0,25 a 4,0; Chirp 3 HD: 0,25 a 2,0)
 *   pitch         number  Tom em semitons (-20 a 20; não se aplica ao Chirp 3 HD)
 *   volumeGainDb  number  Ganho de volume em dB (-96 a 16; não se aplica ao Chirp 3 HD)
 *
 * Corpo (JSON), provider = "gemini" (um trecho de até 1.200 caracteres; o navegador divide e junta):
 *   provider      "gemini"
 *   text          string  Trecho a converter
 *   languageCode  string  "pt-BR" ou "auto"
 *   voiceName     string  Uma das vozes de /api/voices?provider=gemini
 *   model         string  Um dos modelos de /api/voices?provider=gemini (geminiModels[].id)
 *   style         string  (opcional) instrução de estilo, até 200 caracteres
 *   pace          string  (opcional) "slow" | "normal" | "fast"
 *
 * Resposta: áudio MP3 (google) ou WAV (gemini), ou JSON { error: { code, message } }.
 */

const {
  LIMITS,
  AppError,
  sendError,
  googleRequest,
  modelOf,
  splitText,
  checkOrigin,
  checkPassword,
  rateLimit,
} = require('../lib/google');
const gemini = require('../lib/gemini');

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      throw new AppError(400, 'INVALID_JSON', 'O corpo da requisição não é um JSON válido.');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'INVALID_BODY', 'Corpo da requisição ausente ou inválido.');
  }
  return body;
}

function numberInRange(value, name, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new AppError(400, 'INVALID_' + name.toUpperCase(), `${label} deve ser um número entre ${min} e ${max}.`);
  }
  return n;
}

function validate(body) {
  // Texto
  if (typeof body.text !== 'string') {
    throw new AppError(400, 'TEXT_EMPTY', 'Digite ou cole um texto para converter em áudio.');
  }
  const text = body.text.replace(/\u0000/g, '').trim();
  if (!text) {
    throw new AppError(400, 'TEXT_EMPTY', 'O texto está vazio. Digite ou cole algo para converter em áudio.');
  }
  const chars = Array.from(text).length;
  if (chars > LIMITS.MAX_CHARS) {
    throw new AppError(
      413,
      'TEXT_TOO_LONG',
      `O texto tem ${chars.toLocaleString('pt-BR')} caracteres e o limite desta aplicação é ${LIMITS.MAX_CHARS.toLocaleString('pt-BR')} por geração. Divida o texto em partes.`
    );
  }

  // Idioma e voz
  const languageCode = typeof body.languageCode === 'string' ? body.languageCode.trim() : '';
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(languageCode)) {
    throw new AppError(400, 'INVALID_LANGUAGE', 'Idioma inválido ou não informado.');
  }
  const voiceName = typeof body.voiceName === 'string' ? body.voiceName.trim() : '';
  // Nomes reais têm segmentos curtos, como "pt-BR-Wavenet-A" e "pt-BR-Chirp3-HD-Kore".
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,16})+$/.test(voiceName)) {
    throw new AppError(400, 'VOICE_UNAVAILABLE', 'Voz inválida ou não selecionada.');
  }
  const model = modelOf(voiceName);
  if (!model) {
    throw new AppError(
      400,
      'VOICE_UNSUPPORTED',
      'Esta aplicação aceita apenas vozes dos modelos Standard, WaveNet, Neural2 e Chirp 3 HD.'
    );
  }

  // Controles de áudio (cada modelo tem limites próprios)
  const isChirp = model === 'chirp3hd';
  const speakingRate = numberInRange(
    body.speakingRate,
    'speakingRate',
    LIMITS.SPEED_MIN,
    isChirp ? LIMITS.SPEED_MAX_CHIRP : LIMITS.SPEED_MAX_DEFAULT,
    1,
    'A velocidade'
  );
  const pitch = numberInRange(body.pitch, 'pitch', LIMITS.PITCH_MIN, LIMITS.PITCH_MAX, 0, 'O tom');
  const volumeGainDb = numberInRange(
    body.volumeGainDb,
    'volumeGainDb',
    LIMITS.VOLUME_MIN,
    LIMITS.VOLUME_MAX,
    0,
    'O volume'
  );

  return { text, chars, languageCode, voiceName, model, speakingRate, pitch, volumeGainDb };
}

function buildPayload(chunkText, p) {
  const audioConfig = { audioEncoding: 'MP3', speakingRate: p.speakingRate };
  // Segundo a documentação do Google, o Chirp 3 HD não oferece tom nem ganho de volume.
  if (p.model !== 'chirp3hd') {
    audioConfig.pitch = p.pitch;
    audioConfig.volumeGainDb = p.volumeGainDb;
  }
  return {
    input: { text: chunkText },
    voice: { languageCode: p.languageCode, name: p.voiceName },
    audioConfig,
  };
}

async function handleGemini(body, res) {
  if (!(process.env.GEMINI_API_KEY || '').trim()) {
    throw new AppError(
      500,
      'CONFIG_MISSING',
      'A variável de ambiente GEMINI_API_KEY não está configurada no servidor. Crie uma chave gratuita em https://aistudio.google.com/apikey, cadastre-a na Vercel e faça um novo deploy.'
    );
  }

  const text = typeof body.text === 'string' ? body.text.replace(/\u0000/g, '').trim() : '';
  if (!text) throw new AppError(400, 'TEXT_EMPTY', 'O texto está vazio. Digite ou cole algo para converter em áudio.');
  const chars = Array.from(text).length;
  if (chars > gemini.MAX_REQUEST_CHARS) {
    throw new AppError(
      413,
      'TEXT_TOO_LONG',
      `Cada requisição ao Gemini aceita até ${gemini.MAX_REQUEST_CHARS} caracteres (o aplicativo divide o texto automaticamente). Recebido: ${chars}.`
    );
  }

  const voiceName = typeof body.voiceName === 'string' ? body.voiceName : '';
  if (!gemini.VOICES.includes(voiceName)) {
    throw new AppError(400, 'VOICE_UNAVAILABLE', 'Voz inválida. Escolha uma das vozes da lista.');
  }
  const model = typeof body.model === 'string' ? body.model : '';
  if (!gemini.MODELS.some((m) => m.id === model)) {
    throw new AppError(400, 'MODEL_UNAVAILABLE', 'Modelo inválido. Escolha um dos modelos da lista.');
  }
  const languageCode = body.languageCode === 'auto' ? 'auto' : 'pt-BR';
  const pace = body.pace === undefined || body.pace === '' ? 'normal' : body.pace;
  if (!gemini.PACES.includes(pace)) {
    throw new AppError(400, 'INVALID_PACE', 'Ritmo inválido. Use slow, normal ou fast.');
  }
  let style = typeof body.style === 'string' ? body.style.replace(/[\r\n]+/g, ' ').trim() : '';
  if (Array.from(style).length > 200) {
    throw new AppError(400, 'INVALID_STYLE', 'A instrução de estilo pode ter no máximo 200 caracteres.');
  }

  const wav = await gemini.synthesize({ text, voiceName, model, languageCode, style, pace });

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(wav.length));
  res.setHeader('X-Characters', String(chars));
  res.setHeader('X-Chunks', '1');
  res.setHeader('X-Model', model);
  res.status(200).send(wav);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Use o método POST neste endereço.');
    }
    checkOrigin(req);
    const body = parseBody(req);
    const provider = body.provider === undefined || body.provider === '' ? 'google' : body.provider;
    if (provider !== 'google' && provider !== 'gemini') {
      throw new AppError(400, 'INVALID_PROVIDER', 'Provedor inválido. Use google ou gemini.');
    }
    // Gemini: o navegador envia uma requisição por trecho, então o limite por minuto é maior.
    rateLimit(req, provider === 'gemini' ? 'tts-gemini' : 'tts', provider === 'gemini' ? 30 : 10);
    checkPassword(req);

    if (provider === 'gemini') {
      await handleGemini(body, res);
      return;
    }

    const params = validate(body);
    const chunks = splitText(params.text, LIMITS.CHUNK_BYTES);

    const buffers = [];
    for (const chunk of chunks) {
      const data = await googleRequest('POST', '/text:synthesize', buildPayload(chunk, params));
      if (!data || !data.audioContent) {
        throw new AppError(502, 'EMPTY_AUDIO', 'O Google respondeu sem conteúdo de áudio. Tente novamente.');
      }
      buffers.push(Buffer.from(data.audioContent, 'base64'));
    }

    const audio = Buffer.concat(buffers);
    if (audio.length > LIMITS.MAX_AUDIO_BYTES) {
      throw new AppError(
        413,
        'AUDIO_TOO_LARGE',
        'O áudio gerado passou do limite de 4,5 MB de resposta da Vercel. Divida o texto em partes menores.'
      );
    }

    const ignored = params.model === 'chirp3hd' ? 'pitch,volumeGainDb' : '';
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('X-Characters', String(params.chars));
    res.setHeader('X-Chunks', String(chunks.length));
    res.setHeader('X-Model', params.model);
    if (ignored) res.setHeader('X-Ignored-Params', ignored);
    res.status(200).send(audio);
  } catch (err) {
    sendError(res, err);
  }
};
