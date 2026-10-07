# Protocol

What `ow.mjs` sends and reads. Everything here comes from that file. Fields the desk may send beyond these are not listed.

## Local model server

Base: `LITELLM_BASE` (default `http://127.0.0.1:4000`, a trailing `/v1` is dropped). Header `authorization: Bearer <LITELLM_KEY>` only when `LITELLM_KEY` is set.

| Call | Use |
|---|---|
| `GET /v1/models` | Model IDs from `data[].id`. IDs must match `[a-zA-Z0-9._:/-]{1,80}`. |
| `POST /v1/chat/completions` | Speed test: `{"model","messages":[{"role":"user","content":"hi"}],"max_tokens":16,"stream":false}`. Speed is `usage.completion_tokens` over wall time. |
| `POST /v1/chat/completions` | A job: `{"model","messages":[{"role":"user","content":<prompt>}],"stream":false}`. Pool tests add `"max_tokens":512,"temperature":0`. 80 second limit. |

## Desk

Base: `POOL_URL` (default `https://owterminal.com`). JSON in, JSON out.

Every call except registration carries `authorization: Bearer <node secret>`. A node secret matches `sk-node-[A-Za-z0-9_-]{32}`. There is one per registered model, saved in `~/.ow/nodes.json`.

### Register: `POST /api/v1/node`

No auth.

```json
{
  "model": "qwen2.5:7b",
  "price": 150,
  "machineSecret": "sk-node-…",
  "enc_pubkey": "<X25519 public key, base64url>"
}
```

- `price`: integer cents per million tokens, 1 to 5000. Left out when unset, and the desk suggests one.
- `machineSecret`: the secret of a model already registered on this machine, so the desk groups them as one machine. Left out for the first model.

Reads `secret`, `code` (the public node code), `price`, `price_basis` (`"host"` when the host set the price), and `error` on failure.

### Heartbeat: `POST /api/v1/pulse`

```json
{
  "chip": "NVIDIA GeForce RTX 4090",
  "vram_gb": 24,
  "vram_used_gb": 21,
  "tok_per_s": 95,
  "busy": false,
  "slots": 1,
  "models": ["qwen2.5:7b"],
  "enc_pubkey": "<base64url>"
}
```

Sent for every model when busy changes or the model list changes, otherwise about every 30 seconds. `chip` and the memory fields come from `nvidia-smi`. On a Mac without it, `chip` is the Apple chip name and the memory fields are `null`. `tok_per_s` is `null` until measured. The pool counts a host offline after three minutes without contact.

### Claim: `POST /api/v1/jobs/claim`

No body. Optional header `x-ow-wait: <1-15>` (opt-in `OW_WAIT`, one-model hosts only).

- `204`: no work. `ow` asks again in about two seconds.
- `200`: a job.

```json
{ "id": "job_…", "model": "qwen2.5:7b", "prompt": "…" }
```

A sealed job:

```json
{
  "id": "job_…",
  "model": "qwen2.5:7b",
  "prompt": "",
  "prompt_mode": "sealed",
  "enc": { "envelope": { "epk": "…", "nonce": "…", "ct": "…", "tag": "…" }, "wrappedKey": "…", "wrapNonce": "…", "wrapTag": "…" }
}
```

IDs start `job_` for caller jobs and `check_` for pool tests. When `prompt_mode` is `"sealed"`, `prompt` is empty and `enc` holds the envelope.

### Finish: `POST /api/v1/jobs/finish`

```json
{ "id": "job_…", "output": "…", "prompt_tokens": 12, "completion_tokens": 340 }
```

Token counts come from the server's `usage`, or `0` when it gives none.

### Fail: `POST /api/v1/jobs/fail`

```json
{ "id": "job_…" }
```

Sent when your model server errors or does not answer, the prompt does not decrypt, or the finish does not land.

### Pool test, status, link

| Call | Reads |
|---|---|
| `POST /api/v1/node/check` | Requests a pool test. `ow serve` sends it when due and again 12 hours after one is accepted. |
| `GET /api/v1/node/check` | The test result, printed as is. |
| `GET /api/v1/node/status` | `state` (printed in capitals, such as `READY` or `CHECKING`), `check`, `lastSeen`. |
| `POST /api/v1/node/link` | `code` (one-time) and `expiresAt`. The code is entered at `/account/machines`. |

## Sealed prompts

The host key pair is X25519, saved as base64url in `~/.ow/enckey.json`. Every `enc` field is base64url.

1. `shared = X25519(host private key, envelope.epk)`
2. `wrapKey = HKDF-SHA256(shared, salt = epk ‖ host public key (raw bytes), info = "owt-sealed-prompt-wrap-v1", 32 bytes)`
3. `contentKey = AES-256-GCM open(wrapKey, nonce = wrapNonce, aad = "<job id>:<node id>", wrappedKey, wrapTag)`
4. `prompt = AES-256-GCM open(contentKey, nonce = envelope.nonce, aad = "<job id>", envelope.ct, envelope.tag)`, as UTF-8

`node id` is `node_` plus the first 8 hex characters of SHA-256 of the node secret.

Any failure is reported with `jobs/fail` and never retried with other inputs. The prompt stays in memory and is not logged.

## Relay

Present in `ow.mjs`, not enabled yet. It stays off unless `OW_RELAY=1`. It tells a host when to claim and carries streamed replies back. Prompts never travel over it: jobs still come from `jobs/claim` over HTTPS.
