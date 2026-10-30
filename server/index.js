'use strict';

require('dotenv').config();

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { KumaClient } = require('./kuma');

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const AUTH_DISABLED = String(process.env.PANEL_AUTH_DISABLED || 'false').toLowerCase() === 'true';

const PANEL_TITLE = process.env.PANEL_TITLE || 'Grupo Presidente - Monitoreo de Redes';
const PANEL_COMPANY = process.env.PANEL_COMPANY || 'Grupo Presidente';
const PANEL_SUBTITLE = process.env.PANEL_SUBTITLE || 'Monitoreo de Redes';

const KUMA_URL = process.env.KUMA_URL || '';
const KUMA_USERNAME = process.env.KUMA_USERNAME || '';
const KUMA_PASSWORD = process.env.KUMA_PASSWORD || '';
const KUMA_STATUS_SLUG = process.env.KUMA_STATUS_SLUG || 'general';
const KUMA_INSECURE_TLS = String(process.env.KUMA_INSECURE_TLS || 'false').toLowerCase() === 'true';

const BADGE_TTL_MS = Number(process.env.KUMA_BADGE_7D_TTL_MS || 300000);
const INCIDENTS_TTL_MS = Number(process.env.INCIDENTS_TTL_MS || 300000);
const TIMEZONE = process.env.TZ || 'America/Argentina/Buenos_Aires';

function fail(message) {
  console.error(`[panel] ${message}`);
  process.exit(1);
}

if (!KUMA_URL) {
  fail('Falta KUMA_URL en el archivo .env');
}

if (!AUTH_DISABLED && (!PANEL_PASSWORD || PANEL_PASSWORD === 'cambiar-esta-clave')) {
  fail('Definí PANEL_PASSWORD en .env o poné PANEL_AUTH_DISABLED=true para desactivar el acceso.');
}

try {
  new URL(KUMA_URL);
} catch {
  fail(`KUMA_URL inválida: ${KUMA_URL}`);
}

const kuma = new KumaClient({
  url: KUMA_URL,
  username: KUMA_USERNAME,
  password: KUMA_PASSWORD,
  slug: KUMA_STATUS_SLUG,
  insecureTls: KUMA_INSECURE_TLS,
  badgeTtlMs: BADGE_TTL_MS,
  incidentsTtlMs: INCIDENTS_TTL_MS,
  timezone: TIMEZONE,
});

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; ')
  );
  next();
});

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

const expectedUser = digest(PANEL_USER);
const expectedPassword = digest(PANEL_PASSWORD);

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function basicAuth(req, res, next) {
  if (AUTH_DISABLED) {
    return next();
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Panel de monitoreo", charset="UTF-8"');
    return res.status(401).type('text/plain; charset=utf-8').send('Acceso restringido');
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';

  if (!safeEqual(digest(username), expectedUser) || !safeEqual(digest(password), expectedPassword)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Panel de monitoreo", charset="UTF-8"');
    return res.status(401).type('text/plain; charset=utf-8').send('Usuario o clave incorrectos');
  }

  return next();
}

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.use(basicAuth);

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    title: PANEL_TITLE,
    company: PANEL_COMPANY,
    subtitle: PANEL_SUBTITLE,
    timezone: TIMEZONE,
    pollIntervalMs: 10000,
  });
});

app.get('/api/overview', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(kuma.getSnapshot());
});

app.get('/api/monitors/:id/history', (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Identificador de monitor inválido' });
  }

  const history = kuma.getMonitorHistory(id);

  if (!history) {
    return res.status(404).json({ error: 'Monitor no encontrado' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(history);
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    lastModified: true,
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  })
);

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((req, res) => {
  res.status(404).type('text/plain; charset=utf-8').send('No encontrado');
});

kuma.start();

const server = app.listen(PORT, HOST, () => {
  console.log(`[panel] Escuchando en http://${HOST}:${PORT}`);
  console.log(`[panel] Uptime Kuma: ${KUMA_URL}`);
  console.log(`[panel] Zona horaria: ${TIMEZONE}`);
  if (AUTH_DISABLED) {
    console.warn('[panel] Autenticación desactivada (PANEL_AUTH_DISABLED=true)');
  }
});

function shutdown(signal) {
  console.log(`[panel] ${signal} recibido, cerrando...`);
  kuma.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
