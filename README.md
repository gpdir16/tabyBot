English | [한국어](README.ko.md)

# tabyAgent

A more autonomous, more persistent, and easier alternative to OpenClaw/Hermes.

Give it a task and it will carry it out, even if it takes hours or runs into problems.

Memory, skills, self-improvement, scheduled tasks, web browsing, and GUI app usage work out of the box with no extra setup.

## What it can do

- **Daily chat**: Send messages and get replies directly in Telegram. Text, images, and files are supported.
- **Connect inference providers**: Works with OpenAI, OpenRouter, Synthetic, Ollama (local and Cloud), ZenMux, Codex OAuth, Grok OAuth, or your own API endpoint.
- **Skills, MCP**: Add the capabilities and tools you want directly to the agent.
- **Scheduled tasks**: Recurring jobs can run automatically, report when needed, or be skipped when not necessary.
- **Runs anywhere**: Use Docker or local Node.js. Native support is available on macOS and Linux; Windows can work through Docker, but it is not guaranteed.
- **Self-improvement**: tabyAgent can improve itself. It learns from how problems are solved and from user feedback, becoming smarter over time.

## Differences

| Feature                         | tabyAgent                      | OpenClaw                         | Hermes                                              | ChatGPT                                                               |
| ------------------------------- | ------------------------------ | -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------- |
| Daily chat                      | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ✅ Yes                                                                |
| Search                          | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ✅ Yes                                                                |
| Multiple providers              | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ❌ No                                                                 |
| Skills support                  | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ❌ No                                                                 |
| MCP support                     | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ❌ Paid plan, server-side MCP only                                    |
| Scheduled tasks                 | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ✅ Yes                                                                |
| Self-improvement                | ✅ Yes                         | ❌ No                            | ✅ Yes                                              | ❌ No                                                                 |
| Terminal use                    | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ❌ Sandbox only                                                       |
| Browser use                     | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ❌ No                                                                 |
| GUI app use                     | ✅ Yes                         | ❌ No                            | ❌ No                                               | ❌ No                                                                 |
| Local execution                 | ✅ Yes                         | ✅ Yes                           | ✅ Yes                                              | ❌ No                                                                 |
| Persistence\*                   | ✅ Has worked for 2 hours      | ✅ Has worked for 15 minutes     | ✅ Has worked for 20 minutes                        | ❌ No                                                                 |
| Refusal for "ethical reasons"\* | ✅ Rarely refuses most tasks   | ✅ Refuses for red-team security | ❌ Refuses for red-team security and CAPTCHA bypass | ❌ Refuses for red/blue team security, blaming others, CAPTCHA bypass |
| NSFW level settings             | ✅ Allow, indirect only, block | ❌ Not available                 | ❌ Not available                                    | ❌ Block                                                              |
| Memory usage                    | ✅ ~800MB                      | ❌ ~2GB                          | ✅ ~800MB                                           | ✅ -                                                                  |
| License                         | ✅ AGPL-3.0                    | ✅ MIT                           | ✅ MIT                                              | ❌ Proprietary                                                        |

> Items marked with an asterisk (\*) were verified by the tabyAgent developer through direct testing or real-world use, so they may vary depending on the environment.
> For the comparison test, OpenClaw and Hermes used the Ollama Cloud provider and the Kimi-K2.6 model.

## Example prompts

- "How much was last month's DigitalOcean bill?"
- "Find all files in the Documents folder that contain the word report and summarize them."
- "Run direct performance tests on gemma4 e4b and e2b on this machine, then compare them."
- "Organize next week's schedule."
- "Delete the sales row from this Excel file and highlight the columns with values."
- "Cancel my ChatGPT Plus subscription for me."
- "Is this actually real? (link to X/Reddit, etc.)"
- "Summarize this long pasted text."
- "I'll give you my email account so you can use it later. The address is () and the SMTP/POP3 password is ()."
- "Set up Spotify using the email account I gave you earlier."
- "Please visualize this paper in an easy-to-understand way."
- "Compare privatestater analytics and privatestater captcha with Google Analytics and reCAPTCHA."
- "What's a privacy-respecting alternative to Gmail?"
- "What should I eat for lunch in a bit? I only have 3.22 dollars in my bank account."

## Quick Start

### Installation Option A: Automated Script

#### 1. Create a Telegram bot

1. Search for [@BotFather](https://t.me/botfather) in Telegram.
2. Send `/newbot` and follow the instructions.
3. Copy the bot token you receive.

#### 2. Install (Linux / macOS)

Paste the one-line command below into your terminal and press Enter. Installation may take a while, so please wait.

After the installer starts, it will ask you to paste the **BotFather token** from step 1. Then you can choose Docker or local execution, with Docker recommended. It will also ask whether you want to connect a PC folder; the recommended and default answer is N (No).

**Requirements:** If you choose Docker, everything needed will be installed automatically. If you choose local execution, Node.js 22 or later must already be installed.

The automated script does not support Windows. If you are on Windows, consider switching your main OS to a Linux-based distribution. In many cases it is faster, more privacy-friendly, and more freedom-preserving.

```bash
curl -fsSL https://raw.githubusercontent.com/gpdir16/tabyAgent/main/scripts/install.sh | bash
```

To update tabyAgent later, run the same command again. Your settings and memory will be preserved during the update.

#### CLI commands

Run these from the host machine for both Docker and local installs.

- `tabyagent status` — view running status
- `tabyagent stop` — stop tabyAgent
- `tabyagent restart` — restart tabyAgent
- `tabyagent logs` — view logs
- `tabyagent help` — CLI help
- `tabyagent uninstall` — remove tabyAgent (`--purge` also deletes user data)
- `tabyagent foreground` — debug only, not needed for normal use

#### 3. Configure in Telegram

1. Open the bot you created in Telegram and send `/start`. The first person to send a message is approved automatically.
2. The setup wizard will guide you through the language, LLM provider, API key, and model.
3. Once setup is complete, you can start chatting right away.

You can send `/config` at any time to change your settings.

### Installation Option B: Docker Compose (not recommended)

```bash
git clone https://github.com/gpdir16/tabyAgent.git
cd tabyAgent
cp .env.example .env   # set TELEGRAM_BOT_TOKEN
docker compose up -d
# To mount a PC host folder into Docker, use the commands below (optional, default is none):
echo 'HOST_WORKSPACE=/absolute/path/to/your/project' >> .env
docker compose -f docker-compose.yml -f docker-compose.workspace.yml up -d
```

## License

AGPL-3.0
