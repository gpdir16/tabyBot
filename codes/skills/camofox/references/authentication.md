# Authentication & Auth Vault

Credential handling in camofox-browser CLI and API surfaces.

Related:

- `../SKILL.md`
- `./cli-commands.md`
- `./api-endpoints.md`

Source of truth for development: `AGENTS.md`

## Table of Contents

1. Auth Model Overview
2. Vault Crypto Design
3. Vault Storage Layout
4. CLI Auth Commands
5. API Auth Equivalents
6. Security Hardening Notes
7. Common Workflows
8. Auth Gate Configuration Examples
9. Error Handling Matrix

---

## 1) Auth Model Overview

Camofox has two distinct auth concerns:

1. **Credential Vault (CLI local secrets)**
    - Stores website credentials encrypted at rest
    - Used by `camofox auth ...` commands
    - Path: `{{CAMOFOX_DATA_DIR}}/vault`

2. **Server/API key gates (HTTP route protection)**
    - Optional bearer auth when `CAMOFOX_API_KEY` is configured

These are separate systems and should not be conflated.

---

## 2) Vault Crypto Design

Implementation files:

- `src/cli/vault/crypto.ts`
- `src/cli/vault/store.ts`

Encryption details:

- Cipher: `AES-256-GCM`
- Key length: 32 bytes
- Salt length: 16 bytes (`crypto.randomBytes(16)`)
- IV length: 12 bytes (`crypto.randomBytes(12)`)
- Auth tag: 16 bytes

KDF behavior:

- Preferred: `Argon2id` (`argon2.hash` with `timeCost=3`, `memoryCost=65536`, `parallelism=4`, raw output)
- Fallback: `PBKDF2` (`pbkdf2Sync`, `600000` iterations, `sha512`)
- Fallback warning is emitted once when `argon2` module unavailable

Encrypted payload schema:

```json
{
    "version": 1,
    "kdf": "argon2id|pbkdf2",
    "salt": "base64",
    "iv": "base64",
    "tag": "base64",
    "data": "base64"
}
```

Decryption safeguards:

- Version check (`version === 1`)
- Base64 decode validation
- Salt/IV/tag length checks
- Auth tag verification; tamper/wrong password failure returns safe error

---

## 3) Vault Storage Layout

Directory and permissions:

- Vault directory: `{{CAMOFOX_DATA_DIR}}/vault`
- Directory mode: `0700`
- Secret file mode: `0600`

File naming:

- `<profileName>.enc`
- Profile name regex: `^[a-zA-Z0-9_-]+$`, max length `64`

Stored logical profile fields (inside encrypted payload):

```json
{
    "name": "string",
    "url": "optional",
    "username": "string",
    "password": "string",
    "notes": "optional",
    "createdAt": "ISO timestamp",
    "updatedAt": "ISO timestamp"
}
```

---

## 4) CLI Auth Commands

## `camofox auth save <profile-name>`

```bash
camofox auth save <profile-name> [--url <url>] [--notes <notes>]
```

Flow:

- Prompts for master password
- Prompts for username/password
- Encrypts and writes profile file

## `camofox auth load <profile-name>`

```bash
camofox auth load <profile-name>
camofox auth load <profile-name> --inject [tabId] --username-ref <ref> --password-ref <ref> [--user <user>]
```

Behavior:

- Without `--inject`: returns username
- With `--inject`: fills username/password into specified refs

## `camofox auth list`

```bash
camofox auth list [--format <format>]
```

Lists profile metadata (no secrets).

## `camofox auth delete <profile-name>`

```bash
camofox auth delete <profile-name>
```

Prompts for master password and deletes profile.

## `camofox auth change-password <profile-name>`

```bash
camofox auth change-password <profile-name>
```

Re-encrypts profile with new master password.

---

## 5) API Auth Equivalents

There is no REST endpoint for vault CRUD itself; vault is CLI-local.

Closest API equivalents for auth-adjacent workflows:

### Cookie session auth bootstrap

- `POST /sessions/:userId/cookies`
- Use to inject authenticated cookies into user context
- Bearer required when `CAMOFOX_API_KEY` is set

### Optional route protections

If `CAMOFOX_API_KEY` is configured, conditional bearer auth is enforced across protected API routes, including tab creation, navigation, interaction, session management, downloads, tracing, console, and errors. See `references/api-endpoints.md` for the per-endpoint auth matrix.

Header patterns:

Bearer API key (when configured):

```bash
-H 'Authorization: Bearer <CAMOFOX_API_KEY>'
```

---

## 6) Security Hardening Notes

Use these practices in production:

- Set a strong `CAMOFOX_API_KEY` when the server is not loopback-only
- Keep vault files on encrypted disk when possible
- Avoid storing plaintext passwords in shell history or script files
- Prefer `auth load --inject` over manual typing in shared logs
- Use one `userId` per account identity to avoid cross-session contamination

Operational caveat:

- `auth load --inject` needs accurate element refs from a fresh snapshot

---

## 7) Common Workflows

## A) Save credentials once

```bash
camofox auth save gmail --url https://accounts.google.com
```

## B) Inject credentials into login form

```bash
camofox snapshot --user inbox-a
camofox auth load gmail --inject --username-ref e5 --password-ref e9 --user inbox-a
camofox press Enter --user inbox-a
```

## C) Rotate compromised master password

```bash
camofox auth change-password gmail
```

## D) Remove stale profile

```bash
camofox auth delete old-account
```

---

## 8) Auth Gate Configuration Examples

### Minimal secure server startup

```bash
export CAMOFOX_API_KEY='replace-with-long-random-string'
camofox-browser
```

### Cookie import via API key

```bash
curl -X POST http://localhost:9377/sessions/agent1/cookies \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <CAMOFOX_API_KEY>' \
  -d '{"cookies":[]}'
```

### Vault + inject + API workflow

```bash
camofox auth save account-a --url https://example.com/login
camofox open https://example.com/login --user account-a
camofox snapshot --user account-a
camofox auth load account-a --inject --username-ref e4 --password-ref e7 --user account-a
```

---

## 9) Error Handling Matrix

| Symptom                            | Likely cause                                              | Action                                              |
| ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| `Invalid master password`          | Wrong vault password or tampered payload                  | Re-enter password; verify file integrity            |
| `Profile '<name>' not found`       | Missing `.enc` file                                       | Run `camofox auth list`                             |
| `Profile is corrupted`             | Malformed encrypted file or invalid decrypted schema      | Restore from backup / recreate profile              |
| `Forbidden` on protected endpoints | Missing/invalid bearer key while `CAMOFOX_API_KEY` is set | Send correct `Authorization` header                 |
| `Forbidden` on `/stop`             | Missing/invalid admin key                                 | Send valid `x-admin-key` header                     |
| Inject fails with ref errors       | Stale or wrong refs                                       | Run fresh `snapshot`, then inject with current refs |

Operational note:

- Vault and server auth failures are independent domains; a valid vault password does not grant API route authorization.

---

## Troubleshooting

- `Invalid master password`:
    - Wrong password or profile tampering detected
- `argon2 package is not installed` on decrypt:
    - Install `argon2` or re-encrypt on original machine with PBKDF2 fallback compatibility path
- Profile corrupted:
    - File JSON malformed or missing required profile fields after decrypt
