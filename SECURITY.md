# Security

## Reporting

Open a private security advisory on this repo: [Report a vulnerability](https://github.com/dvidia-inference/ow/security/advisories/new).

Do not open a public issue for a security problem. Include what you ran, what happened, and the `ow.mjs` version (the date in [CHANGELOG.md](CHANGELOG.md) is enough).

In scope: `ow.mjs`, `install.sh`, and the host protocol in [PROTOCOL.md](PROTOCOL.md).

## What `ow` keeps

`~/.ow` (or `OW_HOME`) is created `700`. The two key files are `600`.

| File | What it is |
|---|---|
| `nodes.json` | One secret per registered model. Anyone with it can act as this host. |
| `enckey.json` | The X25519 private key that opens sealed prompts. |
| `serve.pid` | The running worker's process ID. |
| `ow.mjs`, `ow` | The program and its launcher. |

Never share `nodes.json` or `enckey.json`. If a secret leaks, stop `ow`. There is no command to revoke a node secret yet. Removing the model from `nodes.json` and joining again registers a new node.

## What it trusts

- Node secrets are sent only to the desk (`POOL_URL`). `LITELLM_KEY` is sent only to your model server (`LITELLM_BASE`).
- Prompts are never logged. Sealed prompts are decrypted in memory, only while the job runs.
- `ow.mjs` is one file with no dependencies. It uses Node built-ins only.
- `install.sh` needs Node 22, downloads `ow.mjs` over HTTPS from owterminal.com, refuses a file that does not parse, and writes with `umask 077`.

Read both files before you run them:

```sh
curl -fsSL https://raw.githubusercontent.com/dvidia-inference/ow/main/install.sh
curl -fsSL https://owterminal.com/ow.mjs
```
