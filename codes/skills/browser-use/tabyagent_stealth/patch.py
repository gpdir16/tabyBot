# Anti-bot stealth for Browser Use CLI 3.0 (browser-harness backend).
#
# browser-use 0.13.x replaced the old `browser_use.skill_cli.browser.CLIBrowserSession`
# with a Browser Harness daemon (browser_harness.daemon.Daemon) that holds a raw
# CDP WebSocket. We patch Daemon._enable_default_domains — called on initial
# attach AND on every set_session (tab switch / new_tab) — so stealth is applied
# to every CDP session, not just the first.
#
# The .pth file loads this at interpreter startup, so the daemon subprocess
# (spawned via `python -m browser_harness.daemon`) is patched before it serves.

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

logger = logging.getLogger("tabyagent_stealth")

STEALTH_JS_TEMPLATE = (Path(__file__).parent / "stealth.js").read_text(encoding="utf-8")
FALLBACK_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/149.0.0.0 Safari/537.36"
)
DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9"
DEFAULT_PLATFORM = "Linux x86_64"


async def _user_agent(cdp) -> str:
    try:
        version = await asyncio.wait_for(cdp.send_raw("Browser.getVersion"), timeout=4)
        user_agent = str(version.get("userAgent") or "")
        if user_agent:
            return user_agent.replace("HeadlessChrome/", "Chrome/")
    except Exception as exc:
        logger.debug("Browser.getVersion failed: %s", exc)
    return FALLBACK_USER_AGENT


def _stealth_js(user_agent: str) -> str:
    return STEALTH_JS_TEMPLATE.replace("__TABYAGENT_USER_AGENT_JSON__", json.dumps(user_agent))


def _patch_daemon() -> None:
    try:
        from browser_harness.daemon import Daemon
    except Exception as exc:  # browser-harness not installed yet at .pth load time
        logger.debug("browser_harness not importable yet: %s", exc)
        return

    original = getattr(Daemon, "_enable_default_domains", None)
    if original is None:
        logger.debug("browser_harness.daemon.Daemon has no _enable_default_domains hook")
        return

    if getattr(original, "_tabyagent_stealth", False):
        return

    async def enable_with_stealth(self, session_id):
        await original(self, session_id)
        cdp = self.cdp
        if cdp is None:
            return
        user_agent = await _user_agent(cdp)
        # Page.addScriptToEvaluateOnNewDocument runs on every new document load
        # for this session — survives navigation, SPA route changes, iframes.
        try:
            await asyncio.wait_for(
                cdp.send_raw(
                    "Page.addScriptToEvaluateOnNewDocument",
                    {"source": _stealth_js(user_agent)},
                    session_id=session_id,
                ),
                timeout=4,
            )
        except Exception as exc:
            logger.debug("stealth init script failed on %s: %s", session_id, exc)
        # UA override at the emulation layer (affects navigator.userAgent,
        # navigator.platform, Accept-Language header). Per-session is correct:
        # the daemon routes Emulation.* through the active session.
        try:
            await asyncio.wait_for(
                cdp.send_raw(
                    "Emulation.setUserAgentOverride",
                    {
                        "userAgent": user_agent,
                        "acceptLanguage": DEFAULT_ACCEPT_LANGUAGE,
                        "platform": DEFAULT_PLATFORM,
                    },
                    session_id=session_id,
                ),
                timeout=4,
            )
        except Exception as exc:
            logger.debug("UA override failed on %s: %s", session_id, exc)
        try:
            await asyncio.wait_for(
                cdp.send_raw(
                    "Network.setUserAgentOverride",
                    {
                        "userAgent": user_agent,
                        "acceptLanguage": DEFAULT_ACCEPT_LANGUAGE,
                        "platform": DEFAULT_PLATFORM,
                    },
                    session_id=session_id,
                ),
                timeout=4,
            )
        except Exception as exc:
            logger.debug("Network UA override failed on %s: %s", session_id, exc)

    enable_with_stealth._tabyagent_stealth = True  # type: ignore[attr-defined]
    Daemon._enable_default_domains = enable_with_stealth  # type: ignore[method-assign]
    logger.info("Patched browser_harness.daemon.Daemon for stealth (CLI 3.0)")


_patch_daemon()
