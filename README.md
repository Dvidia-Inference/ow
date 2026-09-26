# ow

<img src="header.jpg" alt="OpenWeights Terminal. The ow command, next to the mark." width="100%">

`ow` looks at the computer you are typing on. If LiteLLM is already running, it joins the models loaded there and stays open for the [OpenWeights](https://owterminal.com) pool. If LiteLLM is not running, it says so and stops.

It does not install Python, a model, or a GPU stack.

## Install

Node 20 or newer. LiteLLM on this same machine, usually at `http://127.0.0.1:4000`.

```sh
curl -fsSL https://raw.githubusercontent.com/dvidia-inference/ow/main/install.sh | sh
export PATH="$HOME/.ow:$PATH"
ow
```

The same installer is on the desk: `curl -fsSL https://owterminal.com/ow-install.sh | sh`

## What the first run does

1. It asks LiteLLM which models are loaded. It waits two seconds.
2. It registers each new model with the desk and prints a four-letter code.
3. It stays open. The bottom line says `waiting`, `working`, or `busy`.

Type that code on [owterminal.com/pool](https://owterminal.com/pool). The row says **Yours**.

Run it again and it prints the same code. It does not register the model a second time. If another window is already open, it says so and stops.

Close the window and the machine leaves the board.

## When it stops

| What you see | What to do |
|---|---|
| LiteLLM is not running on this computer. | Start LiteLLM, then run `ow` again. |
| LiteLLM is running, but the password was refused. | Set `LITELLM_KEY` to the key LiteLLM gave you. |
| It has no models loaded. | Load a model in LiteLLM, then run `ow` again. |
| Already open in another window. | Use that window. Do not start a second one. |

## Commands

```
ow        look at this computer, then stay open
ow join   register the models, then stop
ow serve  stay open, if already registered
```

You only need the first one.

## Knobs

Set these before `ow` if the defaults are wrong. Leave them alone on the machine where LiteLLM is already running.

| | Default | |
|---|---|---|
| `OW_PRICE` | `100` | Cents per million tokens. `100` is $1. `200` is $2. |
| `LITELLM_BASE` | `http://127.0.0.1:4000` | Change this only if the models are on another address. |
| `LITELLM_KEY` | empty | Set it only if LiteLLM asks for a password. |
| `POOL_URL` | `https://owterminal.com` | The desk. |
| `OW_HOME` | `~/.ow` | Where the code and the secret are saved. |

```sh
OW_PRICE=200 ow
```

The secret for each model is written to `~/.ow/nodes.json`. Do not paste that file anywhere. The four-letter code is the only thing the page needs.

## Where it sits

```
this computer
  LiteLLM          the models you already loaded
  ow               looks, joins, stays open
        |
        v
owterminal.com     the desk. the code, the price, the row
```

[LiteLLM](https://github.com/dvidia-inference/litellm) is the gateway on the machine. [owterminal.com](https://owterminal.com) is the desk. [dvidia.org](https://dvidia.org) is the house.

Do not point LiteLLM back at this site. `ow` calls LiteLLM. LiteLLM must not call the pool.

Two computers, each with its own LiteLLM, each run their own `ow`.

## License

[MIT](LICENSE)
