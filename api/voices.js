'use strict';

/**
 * GET /api/voices?provider=google|gemini&languageCode=pt-BR
 *
 * google: consulta a lista REAL de vozes do Google Cloud (voices.list) e devolve apenas os modelos
 *         Standard, WaveNet, Neural2 e Chirp 3 HD.
 * gemini: devolve as 30 vozes listadas na documentação oficial do Gemini TTS (não há endpoint de listagem).
 * Sem "provider", usa o Google Cloud quando configurado; senão, o Gemini.
 */

const {
  AppError,
  MODEL_LABELS,
  sendError,
  googleRequest,
  modelOf,
  checkOrigin,
  passwordRequired,
  rateLimit,
} = require('../lib/google');
const gemini = require('../lib/gemini');

const DEFAULT_LANGUAGE = 'pt-BR';
const CACHE_MS = 60 * 60 * 1000; // 1 hora

let cache = { at: 0, voices: null };

async function loadGoogleVoices() {
  const now = Date.now();
  if (cache.voices && now - cache.at < CACHE_MS) return cache.voices;

  try {
    const data = await googleRequest('GET', '/voices');
    const list = Array.isArray(data && data.voices) ? data.voices : [];
    const voices = [];
    for (const v of list) {
      const model = modelOf(v.name);
      if (!model) continue; // ignora Studio, Polyglot, Journey etc.
      voices.push({
        name: v.name,
        languageCodes: Array.isArray(v.languageCodes) ? v.languageCodes : [],
        gender: v.ssmlGender || 'SSML_VOICE_GENDER_UNSPECIFIED',
        sampleRateHertz: v.naturalSampleRateHertz || null,
        model,
        modelLabel: MODEL_LABELS[model],
      });
    }
    voices.sort((a, b) => a.name.localeCompare(b.name));
    cache = { at: now, voices };
    return voices;
  } catch (err) {
    if (cache.voices) return cache.voices;
    throw err;
  }
}

function summarizeLanguages(voices) {
  const map = new Map();
  for (const v of voices) {
    for (const code of v.languageCodes) {
      if (!map.has(code)) {
        map.set(code, { code, total: 0, models: { standard: 0, wavenet: 0, neural2: 0, chirp3hd: 0 } });
      }
      const entry = map.get(code);
      entry.total += 1;
      entry.models[v.model] += 1;
    }
  }
  const arr = Array.from(map.values());
  arr.sort((a, b) => {
    if (a.code === DEFAULT_LANGUAGE) return -1;
    if (b.code === DEFAULT_LANGUAGE) return 1;
    return a.code.localeCompare(b.code);
  });
  return arr;
}

function geminiPayload() {
  const voices = gemini.VOICES.map((name) => ({
    name,
    languageCodes: ['pt-BR', 'auto'],
    gender: 'SSML_VOICE_GENDER_UNSPECIFIED',
    sampleRateHertz: 24000,
    model: 'gemini',
    modelLabel: 'Gemini',
  }));
  return {
    languages: [
      { code: 'pt-BR', label: 'Português (Brasil)', total: voices.length, models: {} },
      { code: 'auto', label: 'Detectar idioma automaticamente', total: voices.length, models: {} },
    ],
    voices,
    geminiModels: gemini.MODELS,
    maxRequestChars: gemini.MAX_REQUEST_CHARS,
  };
}

module.exports = async function handler(req, res) {
  let providers = [];
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Use o método GET neste endereço.');
    }
    checkOrigin(req);
    rateLimit(req, 'voices', 60);

    providers = gemini.providerList().map((p) => ({ id: p.id, label: p.label, available: p.available, hint: p.hint, missing: p.missing }));
    const available = providers.filter((p) => p.available);
    if (!available.length) {
      const e = new AppError(
        500,
        'CONFIG_MISSING',
        'Nenhum provedor de voz está configurado no servidor. Cadastre GEMINI_API_KEY (chave gratuita do AI Studio) ou GOOGLE_TTS_SERVICE_ACCOUNT_JSON na Vercel (Settings > Environment Variables) e faça um novo deploy.'
      );
      e.extra = { providers };
      throw e;
    }

    let provider = typeof req.query.provider === 'string' ? req.query.provider : '';
    if (provider && !providers.some((p) => p.id === provider)) {
      throw new AppError(400, 'INVALID_PROVIDER', 'Provedor inválido. Use google ou gemini.');
    }
    if (!provider) provider = (available.find((p) => p.id === 'google') || available[0]).id;
    if (!available.some((p) => p.id === provider)) {
      throw new AppError(400, 'PROVIDER_UNAVAILABLE', 'Este provedor não está configurado no servidor. ' + providers.find((p) => p.id === provider).missing + ' na Vercel e faça um novo deploy.');
    }

    let languageCode = DEFAULT_LANGUAGE;
    if (typeof req.query.languageCode === 'string' && req.query.languageCode) languageCode = req.query.languageCode;
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(languageCode)) {
      throw new AppError(400, 'INVALID_LANGUAGE', 'Código de idioma inválido. Exemplo: pt-BR.');
    }

    const base = { provider, providers, defaultLanguage: DEFAULT_LANGUAGE, languageCode, passwordRequired: passwordRequired() };
    let body;
    if (provider === 'gemini') {
      body = Object.assign(base, geminiPayload());
      body.voices = body.voices.filter((v) => v.languageCodes.includes(languageCode));
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    } else {
      const all = await loadGoogleVoices();
      body = Object.assign(base, {
        source: 'texttospeech.googleapis.com/v1/voices',
        languages: summarizeLanguages(all),
        voices: all.filter((v) => v.languageCodes.includes(languageCode)),
      });
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    }
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof AppError && !err.extra && providers.length) err.extra = { providers };
    sendError(res, err);
  }
};
