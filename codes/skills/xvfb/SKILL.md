---
name: xvfb
description: Linux GUI app automation on a virtual X display. Launch non-browser Linux GUI apps in Docker, see screenshots, and interact by pixel coordinates.
---

# Xvfb GUI Automation

## When to use

Use `xvfb_gui` for non-browser Linux GUI programs inside Docker: small desktop utilities, installers, dialogs, editors, or test apps that need an X display.

For web browsing, use `browser-use`. Do not route normal browser work through Xvfb.

## Prerequisites

- Docker runtime only. Xvfb is Linux-only, and the tool is not exposed on macOS.
- The Docker image bundles `Xvfb`, `xdotool`, `xterm`, `x11-apps`, and ImageMagick `import`.

## Mental model

One Xvfb display is shared by launched apps. The tool returns screenshots when the model supports vision. Coordinates are pixels from the top-left of the root window.

## Core Workflow

```
1. xvfb_gui action=launch app="xterm"
   -> auto-creates the Xvfb session, launches the app, returns a screenshot
2. Look at the screenshot and choose pixel coordinates.
3. xvfb_gui action=click x=420 y=310
   -> clicks and returns a new screenshot
4. xvfb_gui action=type text="echo hello"
5. xvfb_gui action=key key="Return"
6. xvfb_gui action=close
```

Always verify with a screenshot after meaningful actions.

## Actions

```
# App lifecycle
xvfb_gui action=launch app="<command with args>"   # e.g. "xterm" or "xclock"
xvfb_gui action=kill_app pid=<pid>

# Observation and interaction
xvfb_gui action=screenshot
xvfb_gui action=click x=420 y=310 [button=1|2|3] [double=true] [settle_ms=1000]
xvfb_gui action=drag x1=100 y1=200 x2=500 y2=400 [settle_ms=1000]
xvfb_gui action=type text="hello world"
xvfb_gui action=key key="Return"
xvfb_gui action=scroll x=640 y=400 [amount=3] [direction=up|down]

# Cleanup
xvfb_gui action=close
```

All interaction actions accept `settle_ms` in milliseconds. It defaults to 700 and is capped at 10000.

## Tips

1. Screenshot first; do not interact blindly.
2. Use `key`, `type`, `click`, `drag`, and `scroll`; there are no app-specific shortcuts.
3. Use `settle_ms` for slow dialogs or apps that animate.
4. Call `close` when done so the Xvfb process and launched apps are cleaned up.
