'use strict';

/**
 * Código compartilhado pelas funções /api/voices e /api/tts.
 *
 * Fica fora da pasta api/ de propósito: na Vercel, cada arquivo dentro de api/
 * vira um endereço público. Este arquivo é apenas uma "biblioteca interna".
 */

const crypto = require('crypto');
const { GoogleAuth } = require('google-auth-library');

const API_BASE = 'https://texttospeech.googleapis.com/v1';
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

const LIMITS = {
  // Máximo de caracteres por geração nesta aplicação.
  // Motivo: a Vercel limita a resposta de uma função a 4,5 MB (≈ 12 mil caracteres de fala em MP3).
  MAX_CHARS: 12000,
  // O Google aceita 5.000 bytes por requisição; usamos uma margem de segurança.
  CHUNK_BYTES: 4000,
  GOOGLE_MAX_BYTES: 5000,
  // Limite de resposta da Vercel (4,5 MB) com folga.
  MAX_AUDIO_BYTES: Math.floor(4.4 * 1024 * 1024),
  SPEED_MIN: 0.25,
  SPEED_MAX_DEFAULT: 4.0,
  SPEED_MAX_CHIRP: 2.0,
  PITCH_MIN: -20,
  PITCH_MAX: 20,
  VOLUME_MIN: -96,
  VOLUME_MAX: 16,
};

/* ------------------------------------------------------------------ */
/* Erros                                                               */
/* ------------------------------------------------------------------ */

class AppError extends Error {
  constructor(status, code, message, headers) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.headers = headers || null;
  }
}

function sendError(res, err) {
  let e = err;
  if (!(err instanceof AppError)) {
    // Registra só a mensagem (nunca o texto do usuário nem credenciais).
    console.error('[voz-ia-google] erro inesperado:', err && err.message);
    e = new AppError(
      500,
      'INTERNAL',
      'Erro interno inesperado no servidor. Consulte os logs da função na Vercel (aba Logs) para mais detalhes.'
    );
  } else if (e.status >= 500) {
    console.error(`[voz-ia-google] ${e.code}: ${e.message}`);
  }
  if (e.headers) {
    for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(e.status).json(Object.assign({ error: { code: e.code, message: e.message } }, e.extra || {}));
}

/* ------------------------------------------------------------------ */
/* Credenciais e autenticação                                          */
/* ------------------------------------------------------------------ */

let cachedClientPromise = null;

function loadCredentials() {
  const raw = process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    throw new AppError(
      500,
      'CONFIG_MISSING',
      'A variável de ambiente GOOGLE_TTS_SERVICE_ACCOUNT_JSON não está configurada no servidor. ' +
        'Cadastre-a na Vercel (Settings > Environment Variables) com o conteúdo do JSON da Service Account e faça um novo deploy.'
    );
  }

  let creds = null;
  const text = raw.trim();
  try {
    creds = JSON.parse(text);
  } catch (e1) {
    // Tolerância: aceita o JSON codificado em Base64.
    try {
      creds = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
    } catch (e2) {
      creds = null;
    }
  }

  if (!creds || typeof creds !== 'object') {
    throw new AppError(
      500,
      'CONFIG_INVALID',
      'O conteúdo de GOOGLE_TTS_SERVICE_ACCOUNT_JSON não é um JSON válido. ' +
        'Copie o arquivo JSON da Service Account inteiro (do primeiro "{" ao último "}") e cole como valor da variável.'
    );
  }

  if (creds.type !== 'service_account' || !creds.client_email || !creds.private_key) {
    throw new AppError(
      500,
      'CONFIG_INVALID',
      'O JSON informado não parece ser uma chave de Service Account (faltam "type", "client_email" ou "private_key"). ' +
        'Gere uma nova chave em IAM e administrador > Contas de serviço > Chaves > Adicionar chave > JSON.'
    );
  }

  // Quando o JSON passa por painéis de configuração, as quebras de linha da chave às vezes viram "\\n" literais.
  if (typeof creds.private_key === 'string') {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

function getClient() {
  if (!cachedClientPromise) {
    const creds = loadCredentials(); // pode lançar AppError (não fica em cache)
    const auth = new GoogleAuth({ credentials: creds, scopes: SCOPES });
    cachedClientPromise = auth.getClient().catch((err) => {
      cachedClientPromise = null;
      throw translateGoogleError(err);
    });
  }
  return cachedClientPromise;
}

async function googleRequest(method, path, data) {
  const client = await getClient();
  try {
    const res = await client.request({
      url: API_BASE + path,
      method,
      data,
      timeout: 45000,
    });
    return res.data;
  } catch (err) {
    throw translateGoogleError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Tradução dos erros do Google para mensagens claras em português     */
/* ------------------------------------------------------------------ */

function translateGoogleError(err) {
  if (err instanceof AppError) return err;

  const resp = err && err.response;
  const status = resp && resp.status;
  const data = resp && resp.data;
  const gErr = data && typeof data.error === 'object' && data.error ? data.error : null;
  const oauthErr = data && typeof data.error === 'string' ? data : null;

  const googleMsg =
    (gErr && gErr.message) ||
    (oauthErr && (oauthErr.error_description || oauthErr.error)) ||
    (err && err.message) ||
    '';
  const gStatus = (gErr && gErr.status) || '';
  const details = gErr && Array.isArray(gErr.details) ? gErr.details : [];
  const reasonObj = details.find((d) => d && d.reason);
  const reason =
    (reasonObj && reasonObj.reason) ||
    (gErr && Array.isArray(gErr.errors) && gErr.errors[0] && gErr.errors[0].reason) ||
    '';
  const lower = `${googleMsg} ${reason} ${gStatus}`.toLowerCase();
  const tail = googleMsg ? ` Detalhe do Google: "${String(googleMsg).slice(0, 400)}"` : '';

  // 1) Credenciais inválidas / chave revogada
  if (
    oauthErr ||
    status === 401 ||
    gStatus === 'UNAUTHENTICATED' ||
    /invalid_grant|invalid jwt|invalid_client|unauthenticated|could not load the default credentials/.test(lower)
  ) {
    return new AppError(
      500,
      'GOOGLE_AUTH',
      'O Google recusou as credenciais da Service Account (chave inválida, revogada ou de outro projeto). ' +
        'Gere uma nova chave JSON, atualize a variável GOOGLE_TTS_SERVICE_ACCOUNT_JSON na Vercel e faça um novo deploy.' +
        tail
    );
  }

  // 2) API não habilitada
  if (
    reason === 'SERVICE_DISABLED' ||
    reason === 'ACCESS_NOT_CONFIGURED' ||
    /has not been used in project|is disabled|api has not been enabled|accessnotconfigured/.test(lower)
  ) {
    return new AppError(
      503,
      'API_DISABLED',
      'A API Cloud Text-to-Speech não está ativada neste projeto do Google Cloud. ' +
        'Ative em https://console.cloud.google.com/apis/library/texttospeech.googleapis.com e aguarde 1 a 2 minutos.' +
        tail
    );
  }

  // 3) Faturamento
  if (reason === 'BILLING_DISABLED' || /billing/.test(lower)) {
    return new AppError(
      402,
      'BILLING_REQUIRED',
      'O projeto do Google Cloud não tem uma conta de faturamento ativa. A página oficial de preços informa que é preciso ' +
        'ativar o faturamento para usar o Text-to-Speech (a cota gratuita mensal continua valendo). ' +
        'Vincule uma conta de faturamento em https://console.cloud.google.com/billing.' +
        tail
    );
  }

  // 4) Permissão negada
  if (status === 403 || gStatus === 'PERMISSION_DENIED' || reason === 'IAM_PERMISSION_DENIED') {
    return new AppError(
      403,
      'GOOGLE_PERMISSION',
      'A Service Account não tem permissão para usar a API neste projeto. Confirme que a chave pertence ao mesmo projeto em que a API foi ativada. ' +
        'Se a mensagem do Google citar "serviceusage.services.use", conceda à Service Account o papel "Consumidor do Service Usage" ' +
        '(roles/serviceusage.serviceUsageConsumer) em IAM e administrador.' +
        tail
    );
  }

  // 5) Cota / limite de requisições
  if (status === 429 || gStatus === 'RESOURCE_EXHAUSTED' || /quota|rate limit|too many requests/.test(lower)) {
    return new AppError(
      429,
      'QUOTA_EXCEEDED',
      'O limite de requisições por minuto (cota) do Google foi atingido. Aguarde cerca de um minuto e tente de novo. ' +
        'Observação: com o faturamento ativo, ultrapassar a cota gratuita mensal não bloqueia o uso: passa a ser cobrado.' +
        tail,
      { 'Retry-After': '30' }
    );
  }

  // 6) Requisição inválida (400)
  if (status === 400 || gStatus === 'INVALID_ARGUMENT') {
    if (/voice|does not exist|not supported for|language/.test(lower) && !/input/.test(lower)) {
      return new AppError(
        400,
        'VOICE_UNAVAILABLE',
        'Esta voz (ou combinação de voz e idioma) não está disponível no Google agora. Escolha outra voz na lista.' + tail
      );
    }
    if (/longer than the limit|too long|5000|exceed/.test(lower)) {
      return new AppError(
        413,
        'TEXT_TOO_LONG',
        'O Google recusou o texto por ser maior que o limite de 5.000 bytes por requisição. Tente um texto menor.' + tail
      );
    }
    return new AppError(400, 'INVALID_REQUEST', 'O Google recusou a solicitação.' + tail);
  }

  // 7) Problemas de rede
  const netCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ECONNABORTED', 'EPIPE'];
  if ((err && netCodes.includes(err.code)) || /timeout|socket hang up|network/.test(lower)) {
    return new AppError(
      502,
      'NETWORK',
      'Não foi possível se comunicar com o Google (falha de rede ou tempo esgotado). Tente novamente em instantes.'
    );
  }

  // 8) Instabilidade do Google
  if (status && status >= 500) {
    return new AppError(
      503,
      'GOOGLE_UNAVAILABLE',
      'O serviço do Google está indisponível ou instável no momento. Tente novamente em alguns minutos.' + tail
    );
  }

  return new AppError(502, 'GOOGLE_ERROR', 'Erro inesperado ao falar com o Google.' + tail);
}

/* ------------------------------------------------------------------ */
/* Modelos de voz                                                      */
/* ------------------------------------------------------------------ */

const MODEL_LABELS = {
  standard: 'Standard',
  wavenet: 'WaveNet',
  neural2: 'Neural2',
  chirp3hd: 'Chirp 3 HD',
};

/** Descobre o modelo pelo nome da voz (ex.: "pt-BR-Wavenet-A"). Retorna null para modelos não suportados aqui. */
function modelOf(voiceName) {
  const n = String(voiceName || '');
  if (/-Chirp3-HD-/i.test(n)) return 'chirp3hd';
  if (/-Neural2-/i.test(n)) return 'neural2';
  if (/-Wavenet-/i.test(n)) return 'wavenet';
  if (/-Standard-/i.test(n)) return 'standard';
  return null;
}

/* ------------------------------------------------------------------ */
/* Divisão de textos longos (limite de 5.000 bytes por requisição)     */
/* ------------------------------------------------------------------ */

function byteLen(s) {
  return Buffer.byteLength(s, 'utf8');
}

function hardSplit(s, max) {
  const out = [];
  let cur = '';
  for (const ch of s) {
    if (byteLen(cur + ch) > max) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function splitWords(s, max) {
  const out = [];
  let cur = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (byteLen(word) > max) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(...hardSplit(word, max));
      continue;
    }
    const cand = cur ? cur + ' ' + word : word;
    if (byteLen(cand) > max) {
      out.push(cur);
      cur = word;
    } else {
      cur = cand;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Divide o texto em partes de até maxBytes, preferindo cortar entre parágrafos,
 * depois entre frases, depois entre vírgulas e, por último, entre palavras.
 */
function splitText(text, maxBytes) {
  const paragraphs = String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units = []; // { t: texto, sep: separador usado antes dele }
  for (const p of paragraphs) {
    const pieces = [];
    if (byteLen(p) <= maxBytes) {
      pieces.push(p);
    } else {
      const sentences = p.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) || [p];
      for (const raw of sentences) {
        const s = raw.trim();
        if (!s) continue;
        if (byteLen(s) <= maxBytes) {
          pieces.push(s);
        } else {
          for (const part of s.split(/(?<=[,;:])\s+/)) {
            if (byteLen(part) <= maxBytes) pieces.push(part);
            else pieces.push(...splitWords(part, maxBytes));
          }
        }
      }
    }
    pieces.forEach((t, i) => units.push({ t, sep: i === 0 ? '\n\n' : ' ' }));
  }

  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (!cur) {
      cur = u.t;
      continue;
    }
    const cand = cur + u.sep + u.t;
    if (byteLen(cand) <= maxBytes) {
      cur = cand;
    } else {
      chunks.push(cur);
      cur = u.t;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Proteções: origem, senha opcional e limite de requisições           */
/* ------------------------------------------------------------------ */

/** Bloqueia chamadas feitas a partir de outros sites (navegadores). */
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = '';
  try {
    host = new URL(origin).host;
  } catch (e) {
    host = '';
  }
  if (host !== req.headers.host) {
    throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Requisição bloqueada: origem não permitida.');
  }
}

/** Se APP_ACCESS_PASSWORD existir, exige o cabeçalho x-app-password. */
function passwordRequired() {
  return Boolean(process.env.APP_ACCESS_PASSWORD);
}

function checkPassword(req) {
  const expected = process.env.APP_ACCESS_PASSWORD;
  if (!expected) return;
  const provided = String(req.headers['x-app-password'] || '');
  if (!provided) {
    throw new AppError(401, 'APP_PASSWORD_REQUIRED', 'Este aplicativo é protegido por senha. Informe a senha de acesso.');
  }
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    throw new AppError(401, 'APP_PASSWORD_INVALID', 'Senha de acesso incorreta.');
  }
}

const hits = new Map();

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return req.headers['x-real-ip'] || xff || (req.socket && req.socket.remoteAddress) || 'desconhecido';
}

/**
 * Limite simples por IP, na memória da instância.
 * Atenção: na Vercel cada instância tem sua própria memória, então este limite reduz abusos
 * mas não é absoluto. A proteção mais forte é a senha (APP_ACCESS_PASSWORD) e os alertas de orçamento.
 */
function rateLimit(req, bucket, defaultPerMinute) {
  const envLimit = Number(process.env.RATE_LIMIT_PER_MINUTE);
  const limit = Number.isFinite(envLimit) && envLimit > 0 && bucket === 'tts' ? envLimit : defaultPerMinute;
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  let entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + 60000 };
    hits.set(key, entry);
  }
  entry.count += 1;

  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }

  if (entry.count > limit) {
    const wait = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    throw new AppError(
      429,
      'RATE_LIMITED',
      `Muitas requisições em pouco tempo. Aguarde ${wait} segundo(s) e tente novamente.`,
      { 'Retry-After': String(wait) }
    );
  }
}

module.exports = {
  API_BASE,
  LIMITS,
  MODEL_LABELS,
  AppError,
  sendError,
  googleRequest,
  translateGoogleError,
  modelOf,
  splitText,
  byteLen,
  checkOrigin,
  checkPassword,
  passwordRequired,
  rateLimit,
};
