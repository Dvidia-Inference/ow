# ow

Looks at this computer. If LiteLLM is already running, it joins those models and stays open for the [OpenWeights](https://owterminal.com) pool. If LiteLLM is not running, it says so and stops.

It does not install Python, a model, or a GPU stack.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/dvidia-inference/ow/main/install.sh | sh
export PATH="$HOME/.ow:$PATH"
ow
```

Node 20 or newer. LiteLLM on this machine, usually `http://127.0.0.1:4000`.

## What you see

LiteLLM running, with models loaded:

```
┌────────────────────────────────────┐
│ OpenWeights                        │
│                                    │
│ LiteLLM is running.                │
│ 2 models on this computer.         │
│                                    │
│ glm-5.3-flash                      │
│ Your code is AB3K                  │
│                                    │
│ Leave this window open.            │
│ Type the code on owterminal.com/pool │
└────────────────────────────────────┘
  waiting
```

Type that code on [owterminal.com/pool](https://owterminal.com/pool). The bottom line says `waiting`, `working`, or `busy`. Close the window and the machine leaves the board.

LiteLLM not running:

```
┌────────────────────────────────────┐
│ OpenWeights                        │
│                                    │
│ LiteLLM is not running             │
│ on this computer.                  │
│                                    │
│ Start it, then run ow again.       │
└────────────────────────────────────┘
```

Run it again and it prints the same code. It does not register the model a second time.

## Knobs

| | |
|---|---|
| `OW_PRICE` | Cents per million tokens. `100` is $1. `200` is $2. |
| `LITELLM_BASE` | Default `http://127.0.0.1:4000`. |
| `LITELLM_KEY` | Only if LiteLLM asks for one. |
| `POOL_URL` | Default `https://owterminal.com`. |

```sh
OW_PRICE=200 ow
```

`ow join` registers and stops. `ow serve` stays open after a join.

## Where it sits

This is the host side. [LiteLLM](https://github.com/dvidia-inference/litellm) is the gateway on the machine. [owterminal.com](https://owterminal.com) is the desk. [dvidia.org](https://dvidia.org) is the house.

Do not point LiteLLM back at this site.
