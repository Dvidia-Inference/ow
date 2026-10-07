# Changelog

Changes to `ow.mjs` and `install.sh`. Newest first. PR numbers refer to the OpenWeights Terminal site repository.

## 2026-10-07

- `ow.mjs` brought up to date with owterminal.com. Everything below, from 2026-09-26 on, ships in this sync.
- `install.sh` now downloads `ow.mjs` from owterminal.com, so a GitHub install is never older than the site's.
- A daily workflow opens a pull request here whenever owterminal.com serves a newer `ow.mjs`.

## 2026-10-04

- #84 Host relay, `OW_RELAY=1`: one outbound connection per model for instant claims and streamed replies. Present, not enabled yet. Polling stays the path. Prompts never travel over it.

## 2026-10-02

- #78 Sealed prompts. `ow` makes an X25519 key pair in `~/.ow/enckey.json` and sends the public half on join and with each heartbeat. A sealed prompt is decrypted in memory only while its job runs. A prompt that does not decrypt is reported as a failed job and not retried.

## 2026-10-01

- #64 `OW_WAIT=1..15` asks the desk to hold an empty claim open. Opt-in, off by default, one-model hosts only. A desk that does not hold claims ignores it.

## 2026-09-30

- #49 Fewer heartbeats: one when the machine turns busy or free or the model list changes, otherwise every 30 seconds.
- #37 `OW_SLOTS=1..8` takes several jobs at once, for servers that batch.
- #36 Several models per machine. `OW_PRICES` sets a price per model. The model list is read every minute. Keys are saved after each model, atomically. A second worker refuses to start. Up to 24 models.
- #35 On a Mac without `nvidia-smi`, `ow` reports the Apple chip name.
- #34 No fixed default price. Without `OW_PRICE`, the desk suggests one per model, and `ow join` prints it.

## 2026-09-29

- #33 New commands: `ow models`, `ow status`, `ow link`. `OW_MODELS` picks which models to share. `LITELLM_BASE` accepts a trailing `/v1`. Every request has a timeout. `nodes.json` is written `600`. `OW_PRICE` must be whole cents from 1 to 5000. The installer needs Node 22, downloads from owterminal.com, and checks the file parses.

## 2026-09-28

- `ow check` and `ow check status` request and read a pool test. Tests renew every 12 hours while serving. Pool test jobs run with `max_tokens 512` and `temperature 0`. The first-run box prints a public node code.

## 2026-09-26

- Failed jobs, and finishes that never landed, are reported to the desk. A network error no longer stops the loop.
