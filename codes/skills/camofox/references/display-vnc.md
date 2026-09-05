# Display Modes and VNC Remote Viewing

How camofox-browser switches display modes and exposes remote browser viewing through VNC/noVNC.

Related:

- `../SKILL.md`
- `./api-endpoints.md`
- `./session-management.md`

Source of truth: `AGENTS.md`

## Table of Contents

1. Overview
2. Display Toggle Endpoint
3. Mode Semantics (`headless` / `headed` / `virtual`)
4. VNC Stack (`x11vnc` + `websockify` + noVNC)
5. Xvfb Virtual Display
6. Setup Requirements
7. Remote Debugging Use Cases
8. Examples

---

## 1) Overview

Camofox supports runtime display switching per `userId` session and can expose a browser view over VNC.

Key files:

- `src/routes/core.ts` (display toggle route)
- `src/services/vnc.ts` (x11vnc/websockify orchestration)
- `src/services/context-pool.ts` (virtual display / Xvfb behavior)

---

## 2) Display Toggle Endpoint

Endpoint:

- `POST /sessions/:userId/toggle-display`

Body:

```json
{ "headless": true }
```

or

```json
{ "headless": false }
```

or

```json
{ "headless": "virtual" }
```

Important behavior:

- Session context is restarted
- Existing tabs become invalid and must be recreated
- Non-headless modes may return a `vncUrl`

---

## 3) Mode Semantics (`headless` / `headed` / `virtual`)

Platform boundary:

- Windows x64 is supported in headless mode only.
- `headless: false` and `headless: "virtual"` are rejected on Windows before Xvfb/VNC processes are started.
- The Xvfb + x11vnc + websockify/noVNC stack below is Linux-only.

- `headless: true`
    - no visible display
    - VNC is stopped for that user

- `headless: false`
    - headed mode using system display when available
    - on Linux with no usable `DISPLAY`, context pool auto-falls back to virtual display

- `headless: "virtual"`
    - explicitly forces virtual display mode (Xvfb-backed)
    - useful in servers/containers without physical display

---

## 4) VNC Stack (`x11vnc` + `websockify` + noVNC)

Service: `src/services/vnc.ts`

Runtime chain:

1. `x11vnc` attaches to selected X display (`:N`) and exposes RFB port (`5900 + N`)
2. `websockify` bridges websocket traffic to VNC and serves noVNC assets
3. Client connects to generated URL:
    - `http://<host>:<wsPort>/vnc.html?autoconnect=true&resize=scale&token=<token>`

Session controls:

- per-user VNC session map
- timeout auto-stop (`CAMOFOX_VNC_TIMEOUT_MS`, default 120000ms)
- cleanup on stop/timeout

---

## 5) Xvfb Virtual Display

Context pool can spawn Xvfb when virtual display is needed:

- picks first free display lock (`:99`, `:100`, ...)
- starts `Xvfb` with resolution from `CAMOFOX_VNC_RESOLUTION` (default `1920x1080x24`)
- injects display into browser launch options

This enables headed-style rendering in headless Linux environments.

---

## 6) Setup Requirements

These requirements apply to Linux virtual-display/VNC deployments. They are not Windows dependencies.

Required binaries for remote viewing:

- `Xvfb` (virtual X server)
- `x11vnc` (VNC server bound to X display)
- `websockify` (WebSocket bridge)

Required web assets:

- noVNC web root at `/opt/noVNC` (as expected by `src/services/vnc.ts`)

Config/env knobs:

- `CAMOFOX_HEADLESS` (`true` / `false` / `virtual`)
- `CAMOFOX_VNC_RESOLUTION` (e.g. `1920x1080x24`)
- `CAMOFOX_VNC_TIMEOUT_MS`
- `CAMOFOX_VNC_BASE_PORT` (default 6080)
- `CAMOFOX_VNC_HOST` (default `localhost`)

---

## 7) Remote Debugging Use Cases

VNC mode is useful when you need visual confirmation for:

- anti-bot challenge flows
- flaky click/overlay interactions
- cookie/login state issues
- element visibility and layout diagnostics
- reproducing environment-specific rendering behavior in CI/containers

Operational caveat:

- After any display toggle, recreate tabs and reacquire refs (`eN`) before continuing automation.

---

## 8) Examples

### A) Switch to virtual display and get VNC URL

```bash
curl -X POST "http://localhost:9377/sessions/demo/toggle-display" \
  -H 'Content-Type: application/json' \
  -d '{"headless":"virtual"}'
```

Typical response:

```json
{
    "ok": true,
    "headless": "virtual",
    "vncUrl": "http://localhost:6080/vnc.html?...",
    "message": "Browser visible via VNC",
    "userId": "demo"
}
```

### B) Return to headless mode

```bash
curl -X POST "http://localhost:9377/sessions/demo/toggle-display" \
  -H 'Content-Type: application/json' \
  -d '{"headless":true}'
```

### C) Recreate tab after toggle

```bash
curl -X POST "http://localhost:9377/tabs" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo","sessionKey":"default","url":"https://example.com"}'
```
