English | [한국어](README.ko.md)

# tabyBot

An open-source alternative to Grok Bot. Built on my previous project [tabyAgent](https://github.com/gpdir16/tabyAgent).

Give it a task and it will do it — even if it takes hours, even if things go wrong.

Memory, skills, self-improvement, scheduled tasks, todos, web browsing, and GUI apps work out of the box. No extra setup.

## What it can do

- **Everyday chat**: Get answers in the browser. Almost every format is supported — text, images, files, and more.
- **Inference providers**: Connect OpenAI, OpenRouter, OrcaRouter, Synthetic, Ollama (local and Cloud), ZenMux, Codex OAuth, Grok OAuth, GitHub Copilot OAuth, or your own API endpoint.
- **Skills, MCP**: Add the capabilities and tools you want to the agent. Even if you don't install anything yourself, the agent finds and installs what it needs.
- **Scheduled tasks**: Recurring jobs run on a schedule, report when they finish, and skip when they are not needed.
- **Todos**: Manages todo lists for both you and the agents. You use it like a regular todo app, while agents automatically watch the list, schedule work, and handle your tasks for you.
- **Multiple agents**: Create specialist agents for different roles and have them work together.
- **Run it anywhere**: Docker container or local Node.js. Native support is macOS and Linux. Windows can work through Docker, but that is not guaranteed.
- **Self-improvement**: tabyBot can improve itself. It learns from how problems were solved and from your corrections, and it gets sharper the more you use it. It also learns the things you regularly do, and can remind you when you forget.

## Differences

- Differences between tabyBot and tabyAgent: (1) tabyBot runs in its own web UI while tabyAgent runs on Telegram. (2) Many features, like improved self-improvement and dreaming, are only in tabyBot for now and will be ported to tabyAgent later. (3) Because tabyBot is not tied to a specific platform, new features can be added faster.

| Feature                 | tabyBot              | Grok Bot             | OpenClaw         | Hermes           | ChatGPT (Chat)  |
| ----------------------- | -------------------- | -------------------- | ---------------- | ---------------- | --------------- |
| Everyday chat           | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ✅ Yes          |
| Multiple agents         | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ❌ No           |
| Search                  | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ✅ Yes          |
| Multiple providers      | ✅ Yes               | ❌ No                | ✅ Yes           | ✅ Yes           | ❌ No           |
| Smart todo list         | ✅ User + agents     | ❌ No                | ❌ No            | ❌ No            | ❌ No           |
| Remote computer control | ✅ Browser, terminal | ✅ Browser, terminal | ❌ No            | ❌ No            | ❌ No           |
| Proactive outreach      | ✅ Yes               | ❌ No                | ❌ No            | ❌ No            | ❌ No           |
| Skills                  | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ❌ No           |
| MCP                     | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ✅ Dev mode     |
| Scheduled tasks         | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ✅ Yes          |
| Self-improvement        | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ❌ No           |
| Terminal                | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ❌ Sandbox only |
| Browser                 | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ❌ No           |
| GUI apps                | ✅ Yes               | ✅ Yes               | ✅ Yes           | ✅ Yes           | ❌ No           |
| Local execution         | ✅ Yes               | ❌ No                | ✅ Yes           | ✅ Yes           | ❌ No           |
| NSFW level              | ✅ Allow, block      | ❌ Not available     | ❌ Not available | ❌ Not available | ❌ Block        |
| License                 | ✅ AGPL-3.0          | ❌ Proprietary       | ✅ MIT           | ✅ MIT           | ❌ Proprietary  |

> Tests used the Grok OAuth provider and the Grok 4.6 model.

## Example prompts

- "What's last month's DigitalOcean bill?"
- "Find every file in Documents that contains the word report and summarize them all."
- "Run gemma4 e4b and e2b on this machine yourself, then compare them."
- "Organize next week's schedule."
- "Delete the sales row in this Excel file and highlight the columns that have values."
- "Cancel my ChatGPT Plus subscription for me."
- "Is this actually real? (X/Reddit link)"
- "Summarize this (long pasted text)."
- "I'll give you my email account so you can use it later. Address is (), SMTP/POP3 password is ()."
- "Sign up for Spotify with the email account I told you about earlier."
- "Visualize this paper so it's easy to understand. (paper link)"
- "Compare privatestater analytics and privatestater captcha with Google Analytics and reCAPTCHA."
- "What's a privacy-respecting Gmail alternative?"
- "What should I eat for lunch in a bit? I have 4,328 won in my account."
- "Every morning at 8, send me today's weather and my todos."
- "Let me know when a new one drops. (manga/channel link)"
- "If there's anything on my todo list you can handle, just do it."
- "I study Japanese around 9pm every night — nudge me if I forget."
- "What was that thing we talked about before?"
- "Make a translation specialist bot and have it translate this whole document."
- "That thing you did earlier was wrong — do it this way from now on."
- "Take as long as you need — organize every photo in this folder by date."
- "Before I get off work, summarize what I did today."

## Quick start

### Option A: Installer script

#### 1. Install (Linux / macOS)

Paste the line below into a terminal and press Enter. Installation can take a while, so wait for it to finish.

You can choose Docker or a local run. Docker is recommended for security and isolation.

**Requirements:** If you pick Docker, everything you need is installed for you. If you pick local, Node.js 22 or later must already be installed.

The installer does not support Windows. If you are on Windows, consider switching your main OS to a Linux-based distribution — in most cases it is faster, more privacy-friendly, and leaves you with more freedom.

```bash
curl -fsSL https://raw.githubusercontent.com/gpdir16/tabyBot/main/scripts/install.sh | bash
```

To update tabyBot later, run the same command again. Settings and memory are kept.

By default the web UI listens on all interfaces, so other devices on your network can reach it at `http://<your-LAN-IP>:8999`. To restrict it to this machine only, reinstall with `TABYBOT_BIND=127.0.0.1`. When it is open to the network, create an account on the first-visit screen so the UI requires sign-in — until an account exists the UI/API is open.

#### 2. Set up in the web UI

1. Open `http://localhost:8999` in a browser — you'll be asked to create an account (username + password, skippable).
2. The setup wizard walks you through language, LLM provider, API key, and model.
3. When setup is done, you can start chatting.

You can change language, model, thinking level, and more in settings at any time.

### Option B: Docker Compose (not recommended)

```bash
git clone https://github.com/gpdir16/tabyBot.git
cd tabyBot
cp .env.example .env
docker compose up -d
```

## Third-party licenses

| Project                   | Version | License              | Source                                                               |
| ------------------------- | ------- | -------------------- | -------------------------------------------------------------------- |
| tabyAgent                 | —       | AGPL-3.0             | [Repository](https://github.com/gpdir16/tabyAgent)                   |
| marked                    | 12.0.2  | MIT                  | [Repository](https://github.com/markedjs/marked)                     |
| DOMPurify                 | 3.1.6   | Apache-2.0 / MPL-2.0 | [Repository](https://github.com/cure53/DOMPurify)                    |
| Highlight.js              | 11.9.0  | BSD-3-Clause         | [Repository](https://github.com/highlightjs/highlight.js)            |
| xterm.js                  | —       | MIT                  | [Repository](https://github.com/xtermjs/xterm.js)                    |
| @modelcontextprotocol/sdk | 1.30.0  | MIT                  | [Repository](https://github.com/modelcontextprotocol/typescript-sdk) |
| js-tiktoken               | 1.0.21  | MIT                  | [Repository](https://github.com/dqbd/tiktoken)                       |
| node-cron                 | 3.0.3   | ISC                  | [Repository](https://github.com/node-cron/node-cron)                 |
| openai                    | 4.104.0 | Apache-2.0           | [Repository](https://github.com/openai/openai-node)                  |
| web-push                  | 3.6.7   | MPL-2.0              | [Repository](https://github.com/web-push-libs/web-push)              |
| prettier                  | 3.8.3   | MIT                  | [Repository](https://github.com/prettier/prettier)                   |
| camofox-browser           | 2.4.7   | MIT                  | [Repository](https://github.com/redf0x1/camofox-browser)             |
| Camoufox                  | —       | MPL-2.0              | [Repository](https://github.com/daijro/camoufox)                     |
| Playwright                | —       | Apache-2.0           | [Repository](https://github.com/microsoft/playwright)                |

<details>
<summary>Transitive npm dependencies</summary>

- **Apache-2.0:** `ecdsa-sig-formatter`, `openai`
- **BSD-2-Clause:** `json-schema-typed`, `webidl-conversions`
- **BSD-3-Clause:** `buffer-equal-constant-time`, `fast-uri`, `qs`
- **ISC:** `inherits`, `isexe`, `minimalistic-assert`, `node-cron`, `once`, `setprototypeof`, `which`, `wrappy`, `zod-to-json-schema`
- **MIT:** `@hono/node-server`, `@modelcontextprotocol/sdk`, `@types/node`, `@types/node-fetch`, `abort-controller`, `accepts`, `agent-base`, `agentkeepalive`, `ajv`, `ajv-formats`, `asn1.js`, `asynckit`, `base64-js`, `bn.js`, `body-parser`, `bytes`, `call-bind-apply-helpers`, `call-bound`, `combined-stream`, `content-disposition`, `content-type`, `cookie`, `cookie-signature`, `cors`, `cross-spawn`, `debug`, `delayed-stream`, `depd`, `dunder-proto`, `ee-first`, `encodeurl`, `es-define-property`, `es-errors`, `es-object-atoms`, `es-set-tostringtag`, `escape-html`, `etag`, `event-target-shim`, `eventsource`, `eventsource-parser`, `express`, `express-rate-limit`, `fast-deep-equal`, `finalhandler`, `form-data`, `form-data-encoder`, `formdata-node`, `forwarded`, `fresh`, `function-bind`, `get-intrinsic`, `get-proto`, `gopd`, `has-symbols`, `has-tostringtag`, `hasown`, `hono`, `http-errors`, `http_ece`, `https-proxy-agent`, `humanize-ms`, `iconv-lite`, `ip-address`, `ipaddr.js`, `is-promise`, `jose`, `js-tiktoken`, `json-schema-traverse`, `jwa`, `jws`, `math-intrinsics`, `media-typer`, `merge-descriptors`, `mime-db`, `mime-types`, `minimist`, `ms`, `negotiator`, `node-domexception`, `node-fetch`, `object-assign`, `object-inspect`, `on-finished`, `parseurl`, `path-key`, `path-to-regexp`, `pkce-challenge`, `prettier`, `proxy-addr`, `range-parser`, `raw-body`, `require-from-string`, `router`, `safe-buffer`, `safer-buffer`, `send`, `serve-static`, `shebang-command`, `shebang-regex`, `side-channel`, `side-channel-list`, `side-channel-map`, `side-channel-weakmap`, `statuses`, `toidentifier`, `tr46`, `type-is`, `undici-types`, `unpipe`, `uuid`, `vary`, `web-streams-polyfill`, `whatwg-url`, `zod`
- **MPL-2.0:** `web-push`

</details>

## License

AGPL-3.0
