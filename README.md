English | [한국어](README.ko.md)

# tabyBot

An open-source alternative to Grok Bot. Built on tabyAgent, an agent that runs on Telegram.

Give it a task and it will do it — even if it takes hours, even if things go wrong.

Memory, skills, self-improvement, scheduled tasks, web browsing, and GUI apps work out of the box. No extra setup.

## What it can do

- **Everyday chat**: Get answers in the browser. Text and images are both supported.
- **Inference providers**: Connect OpenAI, OpenRouter, Synthetic, Ollama (local and Cloud), ZenMux, Codex OAuth, Grok OAuth, or your own API endpoint.
- **Skills, MCP**: Add the capabilities and tools you want to the agent yourself.
- **Scheduled tasks**: Recurring jobs run on a schedule, report when they finish, and skip when they are not needed.
- **Multiple agents**: Create specialist agents for different roles and have them work together.
- **Run it anywhere**: Docker container or local Node.js. Native support is macOS and Linux. Windows can work through Docker, but that is not guaranteed.
- **Self-improvement**: tabyBot can improve itself. It learns from how problems were solved and from your corrections, and it gets sharper the more you use it.

## Differences

- tabyBot and tabyAgent share almost every feature. This repo (tabyBot) runs in its own web UI; tabyAgent runs on Telegram.

| Feature            | tabyBot                        | Grok Bot         | OpenClaw         | Hermes           | ChatGPT                            |
| ------------------ | ------------------------------ | ---------------- | ---------------- | ---------------- | ---------------------------------- |
| Everyday chat      | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ✅ Yes                             |
| Multiple agents    | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ❌ No                              |
| Search             | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ✅ Yes                             |
| Multiple providers | ✅ Yes                         | ❌ No            | ✅ Yes           | ✅ Yes           | ❌ No                              |
| Skills             | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ❌ No                              |
| MCP                | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ❌ Paid plan, server-side MCP only |
| Scheduled tasks    | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ✅ Yes                             |
| Self-improvement   | ✅ Yes                         | ✅ Yes           | ❌ No            | ✅ Yes           | ❌ No                              |
| Terminal           | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ❌ Sandbox only                    |
| Browser            | ✅ Yes                         | ✅ Yes           | ✅ Yes           | ✅ Yes           | ❌ No                              |
| GUI apps           | ✅ Yes                         | ✅ Yes           | ❌ No            | ❌ No            | ❌ No                              |
| Local execution    | ✅ Yes                         | ❌ No            | ✅ Yes           | ✅ Yes           | ❌ No                              |
| NSFW level         | ✅ Allow, indirect only, block | ❌ Not available | ❌ Not available | ❌ Not available | ❌ Block                           |
| License            | ✅ AGPL-3.0                    | ❌ Proprietary   | ✅ MIT           | ✅ MIT           | ❌ Proprietary                     |

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

#### 2. Set up in the web UI

1. Open `http://localhost:8999` in a browser.
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

## License

AGPL-3.0
