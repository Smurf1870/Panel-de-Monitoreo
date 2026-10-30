'use strict';

const DEFAULT_POLL_MS = 10000;

const STATUS_LABELS = {
  up: 'En línea',
  down: 'Caído',
  pending: 'Pendiente',
  maintenance: 'Mantenimiento',
  paused: 'Pausado',
  stale: 'Sin pulso',
  unknown: 'Sin datos',
};

const STATUS_ORDER = {
  down: 0,
  up: 1,
  pending: 1,
  maintenance: 1,
  paused: 1,
  unknown: 1,
  stale: 1,
};

const TYPE_LABELS = {
  http: 'HTTP',
  https: 'HTTPS',
  keyword: 'Keyword',
  'json-query': 'JSON',
  tcp: 'TCP',
  ping: 'Ping',
  port: 'Puerto',
  dns: 'DNS',
  push: 'Push',
  docker: 'Docker',
  group: 'Grupo',
  grpc: 'gRPC',
  mqtt: 'MQTT',
  radius: 'RADIUS',
  'real-browser': 'Navegador',
  'tailscale-ping': 'Tailscale',
  system: 'Sistema',
  manual: 'Manual',
  steam: 'Steam',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  smtp: 'SMTP',
  rabbitmq: 'RabbitMQ',
  'kafka-producer': 'Kafka',
};

const MESSAGE_TRANSLATIONS = {
  'No heartbeat in the time window': 'Sin pulso dentro de la ventana esperada',
  'Request timed out': 'Tiempo de espera agotado',
  Timeout: 'Tiempo de espera agotado',
  'Connection refused': 'Conexión rechazada',
  'Connection reset': 'Conexión reiniciada',
  'Invalid status code': 'Código de respuesta inválido',
};

const state = {
  config: {
    title: 'Grupo Presidente - Monitoreo de Redes',
    company: 'Grupo Presidente',
    subtitle: 'Monitoreo de Redes',
    timezone: 'America/Argentina/Buenos_Aires',
    pollIntervalMs: DEFAULT_POLL_MS,
  },
  data: null,
  filter: 'all',
  search: '',
  fetching: false,
  fetchError: null,
  lastFetchAt: 0,
  pollTimer: null,
  history: {
    id: null,
    tab: 'events',
    data: null,
    loading: false,
    error: null,
    fetchedAt: 0,
  },
};

const els = {
  brandCompany: document.getElementById('brand-company'),
  brandTitle: document.getElementById('brand-title'),
  conn: document.getElementById('conn'),
  connText: document.getElementById('conn-text'),
  refresh: document.getElementById('refresh'),
  summary: document.getElementById('summary'),
  search: document.getElementById('search'),
  banner: document.getElementById('banner'),
  incidents: document.getElementById('incidents'),
  monitors: document.getElementById('monitors'),
  empty: document.getElementById('empty'),
  visibleCount: document.getElementById('visible-count'),
  footerCompany: document.getElementById('footer-company'),
  footerUpdated: document.getElementById('footer-updated'),
  dialog: document.getElementById('history-dialog'),
  dialogTitle: document.getElementById('dialog-title'),
  dialogSub: document.getElementById('dialog-sub'),
  dialogBody: document.getElementById('dialog-body'),
  dialogClose: document.getElementById('dialog-close'),
};

let dateFormatter = null;
let numberFormatter = null;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function getDateFormatter() {
  if (!dateFormatter) {
    const options = {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };

    try {
      dateFormatter = new Intl.DateTimeFormat('es-AR', {
        ...options,
        timeZone: state.config.timezone,
      });
    } catch {
      dateFormatter = new Intl.DateTimeFormat('es-AR', options);
    }
  }

  return dateFormatter;
}

function getNumberFormatter() {
  if (!numberFormatter) {
    numberFormatter = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
  }
  return numberFormatter;
}

function formatDateTime(iso) {
  if (!iso) {
    return '—';
  }

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return getDateFormatter().format(date).replace(',', '');
}

function formatRelative(iso, prefixed = false) {
  if (!iso) {
    return '';
  }

  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) {
    return '';
  }

  if (diff < 5000) {
    return 'ahora';
  }

  const prefix = prefixed ? 'más de ' : 'hace ';
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) {
    return `${prefix}${seconds} s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${prefix}${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${prefix}${hours} h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 60) {
    return `${prefix}${days} d`;
  }

  return formatDateTime(iso);
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '—';
  }

  const number = Number(value);
  if (number >= 99.995) {
    return '100 %';
  }

  return `${getNumberFormatter().format(number)} %`;
}

function formatLatency(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }

  return `${getNumberFormatter().format(Math.round(Number(value)))} ms`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) {
    return '—';
  }

  const total = Math.max(0, Math.round(Number(seconds)));

  if (total < 60) {
    return `${total} s`;
  }

  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    return `${minutes} min ${total % 60} s`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function translateMessage(message) {
  if (!message) {
    return '';
  }

  const raw = String(message).trim();
  return MESSAGE_TRANSLATIONS[raw] || raw;
}

function typeLabel(type) {
  if (!type) {
    return 'Desconocido';
  }

  return TYPE_LABELS[type] || String(type).toUpperCase();
}

function effectiveStatus(monitor) {
  if (monitor.status === 'up' && monitor.stale) {
    return 'stale';
  }
  return monitor.status;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.unknown;
}

function monitorAddress(monitor) {
  if (monitor.url) {
    return monitor.url;
  }

  if (monitor.hostname) {
    return monitor.port ? `${monitor.hostname}:${monitor.port}` : monitor.hostname;
  }

  return '';
}

function safeColor(value) {
  if (!value) {
    return null;
  }

  const color = String(value).trim();
  if (!color || color.length > 40) {
    return null;
  }

  if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', color)) {
    return color;
  }

  return null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);

  if (className) {
    node.className = className;
  }

  if (text !== undefined && text !== null) {
    node.textContent = String(text);
  }

  return node;
}

function setText(node, text) {
  if (node) {
    node.textContent = text;
  }
}

/* ---------- Data fetching ---------- */

async function fetchJSON(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function loadConfig() {
  try {
    const config = await fetchJSON('/api/config');
    state.config = { ...state.config, ...config };
  } catch {
    // Se usan los valores por defecto.
  }

  setText(els.brandCompany, state.config.company);
  setText(els.brandTitle, state.config.subtitle);
  setText(els.footerCompany, state.config.company);
  document.title = state.config.title;
}

function setRefreshing(refreshing) {
  els.refresh.disabled = refreshing;
  const icon = els.refresh.querySelector('svg');
  if (icon) {
    icon.classList.toggle('spin', refreshing);
  }
}

async function refresh() {
  if (state.fetching) {
    return;
  }

  state.fetching = true;
  setRefreshing(true);

  try {
    const data = await fetchJSON('/api/overview');
    state.data = data;
    state.fetchError = null;
    state.lastFetchAt = Date.now();
    render();
  } catch (error) {
    state.fetchError = error.message || 'Error desconocido';
    renderBanner();
    renderConnection();
    renderFooter();
  } finally {
    state.fetching = false;
    setRefreshing(false);
  }
}

/* ---------- Rendering ---------- */

function render() {
  if (!state.data) {
    renderBanner();
    renderConnection();
    renderFooter();
    return;
  }

  renderSummary();
  renderBanner();
  renderConnection();
  renderIncidents();
  renderMonitors();
  renderFooter();
}

function visibleMonitors() {
  if (!state.data) {
    return [];
  }

  return state.data.monitors.filter((monitor) => monitor.type !== 'group');
}

function countStatuses(monitors) {
  const counts = {
    total: monitors.length,
    up: 0,
    down: 0,
    pending: 0,
    maintenance: 0,
    paused: 0,
    unknown: 0,
    stale: 0,
  };

  for (const monitor of monitors) {
    if (counts[monitor.status] !== undefined) {
      counts[monitor.status] += 1;
    }
    if (monitor.status === 'up' && monitor.stale) {
      counts.stale += 1;
    }
  }

  return counts;
}

function createChip({ filter, label, count, status }) {
  const chip = el('button', 'chip');
  chip.type = 'button';
  chip.dataset.filter = filter;
  chip.setAttribute('aria-pressed', String(state.filter === filter));

  if (status) {
    chip.dataset.filter = filter;
    const dot = el('span', 'chip-dot');
    dot.setAttribute('aria-hidden', 'true');
    chip.append(dot);
  }

  chip.append(el('span', 'chip-label', label));
  chip.append(el('span', 'chip-count', String(count)));

  return chip;
}

function renderSummary() {
  const monitors = visibleMonitors();
  const counts = countStatuses(monitors);

  const chips = [
    { filter: 'all', label: 'Total', count: counts.total },
    { filter: 'up', label: 'En línea', count: counts.up, status: true },
    { filter: 'down', label: 'Caídos', count: counts.down, status: true },
  ];

  if (counts.pending > 0) {
    chips.push({ filter: 'pending', label: 'Pendientes', count: counts.pending, status: true });
  }
  if (counts.maintenance > 0) {
    chips.push({ filter: 'maintenance', label: 'Mantenimiento', count: counts.maintenance, status: true });
  }
  if (counts.paused > 0) {
    chips.push({ filter: 'paused', label: 'Pausados', count: counts.paused, status: true });
  }
  if (counts.stale > 0) {
    chips.push({ filter: 'stale', label: 'Sin pulso', count: counts.stale, status: true });
  }
  if (counts.unknown > 0) {
    chips.push({ filter: 'unknown', label: 'Sin datos', count: counts.unknown, status: true });
  }

  els.summary.replaceChildren(...chips.map(createChip));
}

function renderConnection() {
  const kuma = state.data?.kuma;
  let stateName = 'down';
  let text = 'Sin conexión';

  if (!state.data) {
    stateName = 'loading';
    text = state.fetchError ? 'Sin datos' : 'Conectando…';
  } else if (kuma?.connected && kuma?.loggedIn) {
    stateName = 'live';
    text = 'En vivo';
  } else if (kuma?.connected) {
    stateName = 'auth';
    text = 'Autenticando…';
  }

  els.conn.dataset.state = stateName;
  setText(els.connText, text);
  els.conn.title = kuma?.error || 'Estado de la conexión con Uptime Kuma';
}

function renderBanner() {
  const parts = [];
  const data = state.data;

  if (state.fetchError) {
    parts.push({
      tone: 'error',
      strong: 'No se pudo actualizar el panel.',
      text: ` ${state.fetchError}. Se reintenta automáticamente.`,
    });
  }

  if (data?.kuma?.error) {
    parts.push({
      tone: 'error',
      strong: 'Sin conexión con Uptime Kuma.',
      text: ` ${data.kuma.error}`,
    });
  }

  const staleNames = data?.summary?.staleNames || [];
  if (staleNames.length > 0) {
    const names = staleNames.slice(0, 4).join(', ');
    const suffix = staleNames.length > 4 ? ` y ${staleNames.length - 4} más` : '';
    parts.push({
      tone: 'warn',
      strong: `${staleNames.length} monitor${staleNames.length === 1 ? '' : 'es'} sin pulso reciente.`,
      text: ` ${names}${suffix}. Puede que el chequeo esté detenido.`,
    });
  }

  if (parts.length === 0) {
    els.banner.classList.add('hidden');
    els.banner.replaceChildren();
    return;
  }

  els.banner.classList.remove('hidden');
  els.banner.classList.toggle('warn', parts.every((part) => part.tone === 'warn'));
  els.banner.replaceChildren(
    ...parts.map((part) => {
      const line = el('span');
      line.append(el('strong', null, part.strong));
      line.append(document.createTextNode(part.text));
      return line;
    })
  );
}

function renderIncidents() {
  const incidents = state.data?.incidents || [];

  if (incidents.length === 0) {
    els.incidents.classList.add('hidden');
    els.incidents.replaceChildren();
    return;
  }

  const sorted = [...incidents].sort((a, b) => {
    if (a.active !== b.active) {
      return a.active ? -1 : 1;
    }
    const dateA = a.createdDate ? Date.parse(a.createdDate) : 0;
    const dateB = b.createdDate ? Date.parse(b.createdDate) : 0;
    return dateB - dateA;
  });

  const list = el('div', 'incident-list');

  for (const incident of sorted.slice(0, 8)) {
    const item = el('article', 'incident');
    item.dataset.style = incident.style || 'info';

    const head = el('div', 'incident-head');
    head.append(el('h3', 'incident-title', incident.title));

    const tag = el('span', 'incident-tag', incident.active ? 'Activo' : 'Resuelto');
    head.append(tag);
    head.append(el('span', 'incident-time', formatDateTime(incident.createdDate)));

    item.append(head);

    if (incident.content) {
      item.append(el('p', 'incident-body', incident.content));
    }

    list.append(item);
  }

  const title = el('h2', null, 'Incidentes');
  els.incidents.replaceChildren(title, list);
  els.incidents.classList.remove('hidden');
}

function buildTimeCell(label, iso, options = {}) {
  const cell = el('div', 'time');
  cell.append(el('span', 'time-label', label));

  if (!iso) {
    cell.append(el('span', 'time-value', '—'));
    return cell;
  }

  if (options.capped) {
    const value = el('span', 'time-value js-rel', formatRelative(iso, true));
    value.dataset.iso = iso;
    value.dataset.prefix = '1';
    cell.append(value);
    cell.append(el('span', 'time-rel', 'límite de 100 pulsos'));
    return cell;
  }

  cell.append(el('span', 'time-value', formatDateTime(iso)));

  const relative = el('span', 'time-rel js-rel', formatRelative(iso));
  relative.dataset.iso = iso;
  cell.append(relative);

  return cell;
}

function buildStat(label, value, className) {
  const stat = el('div', 'stat');
  stat.append(el('dt', null, label));
  stat.append(el('dd', className || null, value));
  return stat;
}

function buildCard(monitor) {
  const status = effectiveStatus(monitor);
  const card = el('article', 'card');
  card.dataset.status = status;

  const top = el('div', 'card-top');
  const dot = el('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  top.append(dot);

  const name = el('h3', 'card-name', monitor.name);
  name.title = monitor.name;
  top.append(name);

  const badge = el('span', 'status-badge', statusLabel(status));
  if (status === 'stale') {
    badge.title = 'Uptime Kuma lo reporta en línea, pero no llegan latidos recientes.';
  }
  top.append(badge);

  const meta = el('div', 'card-meta');
  meta.append(el('span', 'type-pill', typeLabel(monitor.type)));

  const addressText = monitorAddress(monitor);
  const address = el('span', 'address', addressText || 'Sin URL/host');
  if (!addressText) {
    address.classList.add('empty');
  } else {
    address.title = addressText;
  }
  meta.append(address);

  card.append(top, meta);

  if (Array.isArray(monitor.tags) && monitor.tags.length > 0) {
    const tags = el('div', 'tags');

    for (const tag of monitor.tags) {
      const tagNode = el('span', 'tag');
      const color = safeColor(tag.color);
      if (color) {
        const swatch = el('span', 'tag-swatch');
        swatch.style.setProperty('--tag-color', color);
        tagNode.append(swatch);
      }
      tagNode.append(document.createTextNode(tag.value ? `${tag.name}: ${tag.value}` : tag.name));
      tags.append(tagNode);
    }

    card.append(tags);
  }

  const stats = el('dl', 'stats');
  const latency = formatLatency(monitor.ping ?? monitor.avgPing);
  stats.append(buildStat('Latencia', latency || '—', latency ? null : 'dim'));

  const uptime24 = monitor.uptime24;
  const uptime7 = monitor.uptime7;
  const uptime30 = monitor.uptime30;

  stats.append(buildStat('Uptime 24 h', formatPercent(uptime24), uptime24 !== null && uptime24 < 95 ? 'warn' : null));
  stats.append(buildStat('Uptime 7 d', formatPercent(uptime7), uptime7 !== null && uptime7 < 95 ? 'warn' : null));
  stats.append(
    buildStat('Uptime 30 d', formatPercent(uptime30), uptime30 !== null && uptime30 < 95 ? 'warn' : null)
  );
  card.append(stats);

  const times = el('div', 'times');
  times.append(buildTimeCell('Última conexión', monitor.lastOk));
  times.append(buildTimeCell('Último pulso', monitor.lastPulse));
  times.append(buildTimeCell('En línea desde', monitor.lastUpChange));
  times.append(buildTimeCell('Estado desde', monitor.statusSince, { capped: monitor.statusSinceCapped }));
  card.append(times);

  const foot = el('div', 'card-foot');
  const message = translateMessage(monitor.lastMessage) || '—';
  const msg = el('span', 'card-msg', message);
  msg.title = message;
  foot.append(msg);

  const button = el('button', 'btn small', 'Ver historial');
  button.type = 'button';
  button.dataset.history = String(monitor.id);
  foot.append(button);

  card.append(foot);

  return card;
}

function sortMonitors(monitors) {
  return [...monitors].sort((a, b) => {
    const orderA = STATUS_ORDER[effectiveStatus(a)] ?? 1;
    const orderB = STATUS_ORDER[effectiveStatus(b)] ?? 1;

    if (orderA !== orderB) {
      return orderA - orderB;
    }

    return a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
  });
}

function matchesSearch(monitor) {
  if (!state.search) {
    return true;
  }

  const haystack = normalizeText(
    [
      monitor.name,
      monitor.type,
      typeLabel(monitor.type),
      monitor.hostname,
      monitor.url,
      monitor.pathName,
      monitor.description,
      ...(monitor.tags || []).flatMap((tag) => [tag.name, tag.value]),
    ]
      .filter(Boolean)
      .join(' ')
  );

  return haystack.includes(state.search);
}

function matchesFilter(monitor) {
  if (state.filter === 'all') {
    return true;
  }

  if (state.filter === 'stale') {
    return effectiveStatus(monitor) === 'stale';
  }

  return monitor.status === state.filter;
}

function renderMonitors() {
  const monitors = visibleMonitors();
  const filtered = sortMonitors(monitors.filter((monitor) => matchesFilter(monitor) && matchesSearch(monitor)));

  els.monitors.replaceChildren(...filtered.map(buildCard));
  els.empty.classList.toggle('hidden', filtered.length > 0);
  setText(els.visibleCount, `${filtered.length} de ${monitors.length}`);
}

function renderFooter() {
  if (!state.lastFetchAt) {
    setText(els.footerUpdated, 'Esperando datos…');
    return;
  }

  const iso = new Date(state.lastFetchAt).toISOString();
  setText(els.footerUpdated, `Actualizado ${formatDateTime(iso)} · ${formatRelative(iso)}`);
}

function tick() {
  document.querySelectorAll('.js-rel').forEach((node) => {
    const iso = node.dataset.iso;
    if (!iso) {
      return;
    }
    node.textContent = formatRelative(iso, node.dataset.prefix === '1');
  });

  renderFooter();
}

/* ---------- History dialog ---------- */

function historyStatusLabel(status) {
  return STATUS_LABELS[status] || 'Sin datos';
}

function createPill(status) {
  const pill = el('span', 'pill', historyStatusLabel(status));
  pill.dataset.status = status;
  return pill;
}

function statusKeyFromCode(code) {
  switch (Number(code)) {
    case 0:
      return 'down';
    case 1:
      return 'up';
    case 2:
      return 'pending';
    case 3:
      return 'maintenance';
    default:
      return 'unknown';
  }
}

function renderHistoryBody() {
  const { data, tab, loading, error } = state.history;

  if (loading) {
    els.dialogBody.replaceChildren(el('p', 'muted', 'Cargando historial…'));
    return;
  }

  if (error) {
    els.dialogBody.replaceChildren(el('p', 'muted', `No se pudo cargar el historial: ${error}`));
    return;
  }

  if (!data) {
    els.dialogBody.replaceChildren(el('p', 'muted', 'Sin datos.'));
    return;
  }

  if (tab === 'events') {
    renderEventsTable(data);
    return;
  }

  renderHeartbeatsTable(data);
}

function buildTable(headers, rows) {
  const table = el('table', 'history-table');
  const thead = el('thead');
  const headRow = el('tr');

  for (const header of headers) {
    headRow.append(el('th', null, header));
  }

  thead.append(headRow);
  const tbody = el('tbody');

  for (const cells of rows) {
    const row = el('tr');

    for (const cell of cells) {
      const td = el('td', cell.className || null);
      if (cell.node) {
        td.append(cell.node);
      } else {
        td.textContent = cell.text === undefined || cell.text === null ? '—' : String(cell.text);
      }
      row.append(td);
    }

    tbody.append(row);
  }

  table.append(thead, tbody);
  return table;
}

function renderEventsTable(data) {
  const events = Array.isArray(data.events) ? data.events : [];

  const note = el(
    'p',
    'dialog-note',
    `Se guardan los cambios importantes de estado (caídas, recuperaciones y reintentos). Total: ${data.eventCount || events.length}.`
  );

  if (events.length === 0) {
    els.dialogBody.replaceChildren(note, el('p', 'muted', 'Sin eventos registrados para este monitor.'));
    return;
  }

  const rows = events.map((event) => [
    { text: formatDateTime(event.time), className: 'time-cell' },
    { node: createPill(statusKeyFromCode(event.status)) },
    { text: formatDuration(event.duration), className: 'num' },
    { text: event.retries ?? '—', className: 'num' },
    { text: translateMessage(event.msg), className: 'msg' },
  ]);

  els.dialogBody.replaceChildren(
    note,
    buildTable(['Fecha y hora', 'Estado', 'Duración', 'Reintentos', 'Mensaje'], rows)
  );
}

function renderHeartbeatsTable(data) {
  const heartbeats = Array.isArray(data.heartbeats) ? [...data.heartbeats].reverse() : [];

  const note = el('p', 'dialog-note', 'Últimos 100 latidos recibidos por Uptime Kuma, del más reciente al más antiguo.');

  if (heartbeats.length === 0) {
    els.dialogBody.replaceChildren(note, el('p', 'muted', 'Sin pulsos registrados para este monitor.'));
    return;
  }

  const rows = heartbeats.map((beat) => {
    const status = statusKeyFromCode(beat.status);
    const latency = formatLatency(beat.ping);

    return [
      { text: formatDateTime(beat.time), className: 'time-cell' },
      { node: createPill(status) },
      { text: latency || '—', className: 'num' },
      { text: beat.retries ?? '—', className: 'num' },
      { text: translateMessage(beat.msg), className: 'msg' },
    ];
  });

  els.dialogBody.replaceChildren(
    note,
    buildTable(['Fecha y hora', 'Estado', 'Latencia', 'Reintentos', 'Mensaje'], rows)
  );
}

function setHistoryTab(tab) {
  state.history.tab = tab;

  document.querySelectorAll('.tab').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });

  renderHistoryBody();
}

async function openHistory(monitorId) {
  const monitor = state.data?.monitors.find((item) => item.id === monitorId);

  if (!monitor) {
    return;
  }

  state.history = {
    id: monitorId,
    tab: 'events',
    data: null,
    loading: true,
    error: null,
    fetchedAt: 0,
  };

  setText(els.dialogTitle, monitor.name);
  setText(
    els.dialogSub,
    `${typeLabel(monitor.type)} · ${monitorAddress(monitor) || 'sin URL/host'} · ${statusLabel(effectiveStatus(monitor))}`
  );

  setHistoryTab('events');

  if (typeof els.dialog.showModal === 'function') {
    els.dialog.showModal();
  } else {
    els.dialog.setAttribute('open', '');
  }

  try {
    const data = await fetchJSON(`/api/monitors/${encodeURIComponent(monitorId)}/history`);

    if (state.history.id !== monitorId) {
      return;
    }

    state.history.data = data;
    state.history.fetchedAt = Date.now();
  } catch (error) {
    if (state.history.id !== monitorId) {
      return;
    }
    state.history.error = error.message || 'Error desconocido';
  } finally {
    if (state.history.id === monitorId) {
      state.history.loading = false;
      renderHistoryBody();
    }
  }
}

function closeHistory() {
  if (typeof els.dialog.close === 'function') {
    els.dialog.close();
  } else {
    els.dialog.removeAttribute('open');
  }
}

/* ---------- Events ---------- */

function bindEvents() {
  els.search.addEventListener('input', (event) => {
    state.search = normalizeText(event.target.value.trim());
    renderMonitors();
  });

  els.summary.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) {
      return;
    }

    const filter = chip.dataset.filter;
    state.filter = state.filter === filter && filter !== 'all' ? 'all' : filter;
    renderSummary();
    renderMonitors();
  });

  els.refresh.addEventListener('click', () => {
    refresh();
  });

  els.monitors.addEventListener('click', (event) => {
    const button = event.target.closest('[data-history]');
    if (!button) {
      return;
    }

    openHistory(Number(button.dataset.history));
  });

  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => setHistoryTab(button.dataset.tab));
  });

  els.dialogClose.addEventListener('click', closeHistory);

  els.dialog.addEventListener('click', (event) => {
    if (event.target === els.dialog) {
      closeHistory();
    }
  });

  els.dialog.addEventListener('close', () => {
    state.history.id = null;
    state.history.data = null;
  });
}

/* ---------- Init ---------- */

async function init() {
  bindEvents();
  await loadConfig();
  await refresh();

  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refresh, state.config.pollIntervalMs || DEFAULT_POLL_MS);
  setInterval(tick, 1000);
}

init();
