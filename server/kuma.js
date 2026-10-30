'use strict';

const { EventEmitter } = require('node:events');
const { io } = require('socket.io-client');

const STATUS_BY_CODE = {
  0: 'down',
  1: 'up',
  2: 'pending',
  3: 'maintenance',
};

const INCIDENT_STYLES = new Set(['info', 'warning', 'danger', 'primary', 'light', 'dark']);

function parseKumaTime(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  // Uptime Kuma guarda los heartbeats en UTC y los devuelve sin zona:
  // "2026-10-29 18:50:10" o "2026-10-29 18:50:10.304".
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) {
    const date = new Date(`${raw.replace(' ', 'T')}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOrNull(value) {
  const date = parseKumaTime(value);
  return date ? date.toISOString() : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function safeUrl(raw) {
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    if (!url.hostname) {
      return null;
    }
    // Nunca mostrar credenciales embebidas en la URL.
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .filter((tag) => tag && typeof tag === 'object')
    .map((tag) => ({
      name: tag.name ? String(tag.name) : '',
      color: tag.color ? String(tag.color) : null,
      value: tag.value === null || tag.value === undefined ? null : String(tag.value),
    }))
    .filter((tag) => tag.name);
}

function normalizeHeartbeat(heartbeat) {
  if (!heartbeat || typeof heartbeat !== 'object') {
    return null;
  }

  const status = Number(heartbeat.status);
  const time = isoOrNull(heartbeat.time);
  if (!Number.isInteger(status) || !time) {
    return null;
  }

  return {
    status,
    time,
    msg: heartbeat.msg === null || heartbeat.msg === undefined ? '' : String(heartbeat.msg),
    ping: numberOrNull(heartbeat.ping),
    duration: numberOrNull(heartbeat.duration),
    retries: numberOrNull(heartbeat.retries),
    important: Boolean(heartbeat.important),
  };
}

function normalizeIncident(incident) {
  if (!incident || typeof incident !== 'object') {
    return null;
  }

  const style = INCIDENT_STYLES.has(incident.style) ? incident.style : 'info';

  return {
    id: numberOrNull(incident.id),
    title: incident.title ? String(incident.title) : 'Incidente',
    content: incident.content ? String(incident.content) : '',
    style,
    active: Boolean(incident.active),
    pinned: Boolean(incident.pin),
    createdDate: isoOrNull(incident.createdDate),
    lastUpdatedDate: isoOrNull(incident.lastUpdatedDate),
  };
}

function sanitizeMonitor(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const id = numberOrNull(raw.id);
  if (!id) {
    return null;
  }

  return {
    id,
    name: raw.name ? String(raw.name) : `Monitor ${id}`,
    type: raw.type ? String(raw.type) : 'unknown',
    active: raw.active !== false && raw.forceInactive !== true,
    url: safeUrl(raw.url),
    hostname: raw.hostname ? String(raw.hostname) : null,
    port: numberOrNull(raw.port),
    path: Array.isArray(raw.path) ? raw.path.map(String) : [],
    pathName: raw.pathName ? String(raw.pathName) : '',
    description: raw.description ? String(raw.description) : null,
    interval: numberOrNull(raw.interval),
    retryInterval: numberOrNull(raw.retryInterval),
    maxretries: numberOrNull(raw.maxretries),
    maintenance: Boolean(raw.maintenance),
    tags: sanitizeTags(raw.tags),
    weight: numberOrNull(raw.weight),
  };
}

function sortAscending(list) {
  return list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function sortDescending(list) {
  return list.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

function computeStatusSince(heartbeats) {
  if (!heartbeats.length) {
    return { time: null, capped: false };
  }

  const lastStatus = heartbeats[heartbeats.length - 1].status;
  let index = heartbeats.length - 1;

  while (index > 0 && heartbeats[index - 1].status === lastStatus) {
    index -= 1;
  }

  return {
    time: heartbeats[index].time,
    capped: index === 0,
  };
}

class KumaClient extends EventEmitter {
  constructor(config) {
    super();

    this.config = config;
    this.baseUrl = new URL(config.url).origin;
    this.socket = null;
    this.connected = false;
    this.loggedIn = false;
    this.loggingIn = false;
    this.lastError = null;
    this.lastEventAt = null;
    this.info = null;

    this.monitors = new Map();
    this.heartbeats = new Map();
    this.events = new Map();
    this.eventsLoaded = new Set();
    this.uptimes = new Map();
    this.avgPings = new Map();
    this.badgeCache = new Map();
    this.badgeFetching = new Set();

    this.incidents = [];
    this.incidentsError = null;
    this.incidentsFetchedAt = 0;
    this.fetchingIncidents = false;

    this.updateTimer = null;
    this.loginRetryTimer = null;
    this.refreshTimer = null;
  }

  start() {
    this.connect();
    this.fetchIncidents();

    this.refreshTimer = setInterval(() => {
      this.refreshAllBadges();
      this.fetchIncidents();
    }, 5 * 60 * 1000);

    if (typeof this.refreshTimer.unref === 'function') {
      this.refreshTimer.unref();
    }
  }

  stop() {
    clearTimeout(this.updateTimer);
    clearTimeout(this.loginRetryTimer);
    clearInterval(this.refreshTimer);

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  connect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
    }

    this.socket = io(this.baseUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      timeout: 15000,
      rejectUnauthorized: !this.config.insecureTls,
    });

    this.socket.on('connect', () => {
      this.connected = true;
      this.loggedIn = false;
      this.eventsLoaded.clear();
      this.scheduleUpdate();
      this.login();
    });

    this.socket.on('disconnect', (reason) => {
      this.connected = false;
      this.loggedIn = false;
      this.lastError = reason === 'io client disconnect' ? null : 'Conexión con Uptime Kuma perdida';
      this.scheduleUpdate();
    });

    this.socket.on('connect_error', (error) => {
      this.connected = false;
      this.loggedIn = false;
      this.lastError = error?.message || 'No se pudo conectar con Uptime Kuma';
      this.scheduleUpdate();
    });

    this.socket.on('info', (info) => {
      this.info = info || null;
      this.scheduleUpdate();
    });

    this.socket.on('monitorList', (list) => {
      this.handleMonitorList(list);
    });

    this.socket.on('heartbeatList', (monitorID, list) => {
      this.handleHeartbeatList(monitorID, list);
    });

    this.socket.on('heartbeat', (heartbeat) => {
      this.handleHeartbeat(heartbeat);
    });

    this.socket.on('uptime', (monitorID, period, value) => {
      this.handleUptime(monitorID, period, value);
    });

    this.socket.on('avgPing', (monitorID, value) => {
      this.handleAvgPing(monitorID, value);
    });

    this.socket.on('maintenanceList', () => {
      this.scheduleUpdate();
    });
  }

  async login() {
    if (this.loggingIn || !this.socket?.connected) {
      return;
    }

    this.loggingIn = true;
    this.lastError = null;

    try {
      const response = await this.emitWithAck(
        'login',
        {
          username: this.config.username,
          password: this.config.password,
        },
        15000
      );

      if (response?.tokenRequired) {
        throw new Error('La cuenta de Uptime Kuma tiene 2FA activo');
      }

      if (!response?.ok) {
        throw new Error(response?.msg || 'Credenciales rechazadas');
      }

      this.loggedIn = true;
      this.lastError = null;
      this.scheduleUpdate();
      this.fetchEventsForAll();
      this.refreshAllBadges();
      this.fetchIncidents();
    } catch (error) {
      this.loggedIn = false;
      this.lastError = `No se pudo iniciar sesión en Uptime Kuma: ${error.message}`;
      this.scheduleUpdate();

      clearTimeout(this.loginRetryTimer);
      this.loginRetryTimer = setTimeout(() => {
        if (this.socket?.connected) {
          this.login();
        } else if (this.socket) {
          this.socket.connect();
        }
      }, 10000);
    } finally {
      this.loggingIn = false;
    }
  }

  emitWithAck(event, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.socket?.connected) {
        reject(new Error('Sin conexión con Uptime Kuma'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error('Tiempo de espera agotado'));
      }, timeoutMs);

      this.socket.emit(event, payload, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  handleMonitorList(rawList) {
    const list = Array.isArray(rawList) ? rawList : Object.values(rawList || {});
    const next = new Map();

    for (const raw of list) {
      const monitor = sanitizeMonitor(raw);
      if (monitor) {
        next.set(monitor.id, monitor);
      }
    }

    this.monitors = next;

    for (const id of next.keys()) {
      if (!this.heartbeats.has(id)) {
        this.heartbeats.set(id, []);
      }
      if (!this.events.has(id)) {
        this.events.set(id, []);
      }
    }

    for (const id of this.heartbeats.keys()) {
      if (!next.has(id)) {
        this.heartbeats.delete(id);
        this.events.delete(id);
        this.eventsLoaded.delete(id);
        this.uptimes.delete(id);
        this.avgPings.delete(id);
        this.badgeCache.delete(id);
      }
    }

    this.fetchEventsForAll();
    this.refreshAllBadges();
    this.scheduleUpdate();
  }

  handleHeartbeatList(monitorID, rawList) {
    const id = Number(monitorID);
    if (!id || !Array.isArray(rawList)) {
      return;
    }

    const list = rawList
      .map(normalizeHeartbeat)
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      .slice(-100);

    this.heartbeats.set(id, list);
    this.scheduleUpdate();
  }

  handleHeartbeat(rawHeartbeat) {
    const id = Number(rawHeartbeat?.monitorID ?? rawHeartbeat?.monitor_id);
    const heartbeat = normalizeHeartbeat(rawHeartbeat);
    if (!id || !heartbeat) {
      return;
    }

    const list = this.heartbeats.get(id) || [];
    const last = list[list.length - 1];

    if (last && last.time === heartbeat.time) {
      list[list.length - 1] = heartbeat;
    } else {
      list.push(heartbeat);
    }

    this.heartbeats.set(id, list.slice(-100));

    if (heartbeat.important) {
      const events = this.events.get(id) || [];
      const exists = events.some((event) => event.time === heartbeat.time && event.status === heartbeat.status);
      if (!exists) {
        events.unshift(heartbeat);
        this.events.set(id, events.slice(0, 500));
      }
    }

    this.scheduleUpdate();
  }

  handleUptime(monitorID, period, value) {
    const id = Number(monitorID);
    if (!id) {
      return;
    }

    const uptime = this.uptimes.get(id) || {};
    uptime[period] = numberOrNull(value);
    this.uptimes.set(id, uptime);
    this.scheduleUpdate();
  }

  handleAvgPing(monitorID, value) {
    const id = Number(monitorID);
    if (!id) {
      return;
    }

    this.avgPings.set(id, numberOrNull(value));
    this.scheduleUpdate();
  }

  fetchEventsForAll() {
    if (!this.socket?.connected || !this.loggedIn) {
      return;
    }

    for (const id of this.monitors.keys()) {
      if (this.eventsLoaded.has(id)) {
        continue;
      }

      this.eventsLoaded.add(id);

      this.socket.timeout(15000).emit(
        'monitorImportantHeartbeatListPaged',
        id,
        0,
        500,
        (error, response) => {
          if (error || !response?.ok || !Array.isArray(response.data)) {
            this.eventsLoaded.delete(id);
            return;
          }

          const events = response.data
            .map(normalizeHeartbeat)
            .filter(Boolean)
            .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
            .slice(0, 500);

          this.events.set(id, events);
          this.scheduleUpdate();
        }
      );
    }
  }

  refreshAllBadges() {
    for (const id of this.monitors.keys()) {
      this.refreshBadge(id);
    }
  }

  async refreshBadge(monitorID) {
    const id = Number(monitorID);
    if (!id || this.badgeFetching.has(id)) {
      return;
    }

    const cached = this.badgeCache.get(id);
    if (cached && Date.now() - cached.ts < this.config.badgeTtlMs) {
      return;
    }

    this.badgeFetching.add(id);

    try {
      const response = await fetch(`${this.baseUrl}/api/badge/${id}/uptime/168h`, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'image/svg+xml,text/plain,*/*' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const svg = await response.text();
      const match = svg.match(/Uptime \([^)]*\):\s*([\d.]+)%/);
      const value = match ? Number(match[1]) : null;

      this.badgeCache.set(id, {
        value: Number.isFinite(value) ? value : null,
        ts: Date.now(),
      });
      this.scheduleUpdate();
    } catch {
      this.badgeCache.set(id, { value: null, ts: Date.now() - this.config.badgeTtlMs + 60000 });

      setTimeout(() => {
        this.refreshBadge(id);
      }, 60000).unref?.();
    } finally {
      this.badgeFetching.delete(id);
    }
  }

  async fetchIncidents() {
    if (this.fetchingIncidents) {
      return;
    }

    if (this.incidentsFetchedAt && Date.now() - this.incidentsFetchedAt < this.config.incidentsTtlMs) {
      return;
    }

    this.fetchingIncidents = true;

    try {
      const response = await fetch(
        `${this.baseUrl}/api/status-page/${encodeURIComponent(this.config.slug)}/incident-history`,
        {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json' },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const incidents = Array.isArray(data?.incidents) ? data.incidents.map(normalizeIncident).filter(Boolean) : [];

      this.incidents = incidents.sort((a, b) => {
        const dateA = a.createdDate ? Date.parse(a.createdDate) : 0;
        const dateB = b.createdDate ? Date.parse(b.createdDate) : 0;
        return dateB - dateA;
      });
      this.incidentsError = null;
      this.incidentsFetchedAt = Date.now();
      this.scheduleUpdate();
    } catch (error) {
      this.incidentsError = error.message;
      this.incidentsFetchedAt = Date.now();
      this.scheduleUpdate();
    } finally {
      this.fetchingIncidents = false;
    }
  }

  scheduleUpdate() {
    this.lastEventAt = Date.now();

    if (this.updateTimer) {
      return;
    }

    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.emit('update');
    }, 300);

    if (typeof this.updateTimer.unref === 'function') {
      this.updateTimer.unref();
    }
  }

  buildMonitor(monitor, now) {
    const heartbeats = this.heartbeats.get(monitor.id) || [];
    const events = this.events.get(monitor.id) || [];
    const uptimes = this.uptimes.get(monitor.id) || {};
    const lastHeartbeat = heartbeats[heartbeats.length - 1] || null;
    const lastOk = [...heartbeats].reverse().find((heartbeat) => heartbeat.status === 1) || null;
    const lastUpEvent = events.find((event) => event.status === 1) || null;
    const lastDownEvent = events.find((event) => event.status === 0) || null;

    let status = 'pending';
    if (!monitor.active) {
      status = 'paused';
    } else if (lastHeartbeat) {
      status = STATUS_BY_CODE[lastHeartbeat.status] || 'unknown';
    }

    let statusSince = null;
    let statusSinceCapped = false;

    if (status !== 'paused' && status !== 'unknown') {
      const latestEvent = events[0];
      if (latestEvent && STATUS_BY_CODE[latestEvent.status] === status) {
        statusSince = latestEvent.time;
      } else if (lastHeartbeat) {
        const computed = computeStatusSince(heartbeats);
        statusSince = computed.time;
        statusSinceCapped = computed.capped;
      }
    }

    const pulseAgeSec = lastHeartbeat
      ? Math.max(0, Math.round((now - Date.parse(lastHeartbeat.time)) / 1000))
      : null;

    const staleThreshold = Math.max((monitor.interval || 60) * 2 + 30, 180);
    const stale =
      (status === 'up' || status === 'pending') &&
      pulseAgeSec !== null &&
      pulseAgeSec > staleThreshold;

    const uptime24 = uptimes[24] === null || uptimes[24] === undefined ? null : round2(uptimes[24] * 100);
    const uptime30 = uptimes[720] === null || uptimes[720] === undefined ? null : round2(uptimes[720] * 100);
    const badge = this.badgeCache.get(monitor.id);
    const uptime7 = badge && badge.value !== null && badge.value !== undefined ? round2(badge.value) : null;
    const avgPing = this.avgPings.get(monitor.id);

    return {
      ...monitor,
      status,
      statusSince,
      statusSinceCapped,
      lastPulse: lastHeartbeat?.time || null,
      lastPulseStatus: lastHeartbeat ? STATUS_BY_CODE[lastHeartbeat.status] || 'unknown' : null,
      lastMessage: lastHeartbeat?.msg || null,
      lastOk: lastOk?.time || null,
      lastUpChange: lastUpEvent?.time || null,
      lastDownChange: lastDownEvent?.time || null,
      pulseAgeSec,
      stale,
      ping: lastHeartbeat?.ping ?? null,
      avgPing: avgPing === null || avgPing === undefined ? null : round2(avgPing),
      uptime24,
      uptime7,
      uptime30,
      eventCount: events.length,
    };
  }

  getMonitorHistory(monitorID) {
    const id = Number(monitorID);
    const monitor = this.monitors.get(id);

    if (!monitor) {
      return null;
    }

    const heartbeats = this.heartbeats.get(id) || [];
    const events = this.events.get(id) || [];

    return {
      monitor: {
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
      },
      heartbeats: heartbeats.slice(-100),
      events: events.slice(0, 100),
      eventCount: events.length,
      generatedAt: new Date().toISOString(),
    };
  }

  getSnapshot() {
    const now = Date.now();
    const monitors = [...this.monitors.values()].map((monitor) => this.buildMonitor(monitor, now));

    const summary = {
      total: monitors.length,
      up: 0,
      down: 0,
      pending: 0,
      maintenance: 0,
      paused: 0,
      unknown: 0,
      stale: 0,
      downNames: [],
      staleNames: [],
    };

    for (const monitor of monitors) {
      if (summary[monitor.status] !== undefined) {
        summary[monitor.status] += 1;
      }
      if (monitor.status === 'down') {
        summary.downNames.push(monitor.name);
      }
      if (monitor.stale) {
        summary.stale += 1;
        summary.staleNames.push(monitor.name);
      }
    }

    return {
      generatedAt: new Date(now).toISOString(),
      timezone: this.config.timezone,
      kuma: {
        connected: this.connected,
        loggedIn: this.loggedIn,
        version: this.info?.version || null,
        lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
        error: this.lastError,
      },
      summary,
      monitors,
      incidents: this.incidents,
      incidentsError: this.incidentsError,
    };
  }
}

module.exports = {
  KumaClient,
  STATUS_BY_CODE,
};
