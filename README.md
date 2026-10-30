# Grupo Presidente — Monitoreo de Redes

Panel web que muestra el estado de los monitores de **Uptime Kuma** (versión 2.5.8) de Grupo Presidente: estado, última conexión, último pulso, latencia, uptime (24 h / 7 d / 30 d), tipo de monitor, host/URL, tags e historial de eventos.

## Características

- Backend mínimo en Node + Express que se conecta a Uptime Kuma por Socket.IO (cuenta `admin`).
- Frontend en HTML/CSS/JS sin build step, tema claro/oscuro automático.
- Actualización en tiempo real (eventos de Uptime Kuma) + polling de respaldo cada 10 s.
- Tarjetas ordenadas con caídos primero y luego alfabético.
- Búsqueda por nombre, tag, host o URL.
- Filtros por estado (chips).
- Modal de historial por monitor (eventos importantes + últimos 100 pulsos).
- Incidentes públicos de la status page al pie.
- Alertas visuales para monitores caídos y sin pulso reciente.
- Acceso protegido con HTTP Basic Auth (usuario/clave en `.env`).
- Zona horaria `America/Argentina/Buenos_Aires`, fechas `DD/MM/YYYY HH:mm:ss` (24 h).

## Requisitos

- Node.js 20 o superior.
- Acceso de red al Uptime Kuma (URL configurada en `.env`).

## Instalación

```bash
npm install
cp .env.example .env
# editá .env con la URL de Kuma y las credenciales
npm start
```

El panel queda en `http://localhost:8090`.

## Variables de entorno

Ver `.env.example`. Las más importantes:

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del panel (default 8090). |
| `PANEL_USER` / `PANEL_PASSWORD` | Credenciales del panel (HTTP Basic Auth). |
| `PANEL_AUTH_DISABLED` | `true` para desactivar el acceso (solo LAN confiable). |
| `KUMA_URL` | URL base de Uptime Kuma (interna cuando sea posible). |
| `KUMA_USERNAME` / `KUMA_PASSWORD` | Cuenta de Uptime Kuma (debe tener permisos de dashboard). |
| `KUMA_STATUS_SLUG` | Slug de la status page pública (default `general`). |
| `KUMA_INSECURE_TLS` | `true` solo si la URL usa HTTPS con certificado autofirmado. |
| `TZ` | Zona horaria del panel. |

## Docker

```bash
docker compose up -d --build
```

El archivo `.env` se carga automáticamente. No se incluye en la imagen (ver `.dockerignore`).

## Notas de seguridad

- La API key de Uptime Kuma (`uk1_…`) **no se usa** en este panel: la versión 2.5.8 no expone los endpoints REST que esa clave protege. Si la compartiste, conviene rotarla en Uptime Kuma.
- La cuenta de Kuma usada por el panel es administradora (Uptime Kuma no tiene rol solo-lectura). Usá una cuenta dedicada si es posible.
- Cambiá `PANEL_PASSWORD` por una clave fuerte antes de publicar.
- La URL de Cloudflare Tunnel (`trycloudflare.com`) es temporal: cuando tengas la IP interna, actualizá `KUMA_URL` en `.env`.

## Estructura

```
server/
  index.js   # Express + Basic Auth + API
  kuma.js    # Cliente Socket.IO de Uptime Kuma
public/
  index.html
  styles.css
  app.js
  assets/
```
