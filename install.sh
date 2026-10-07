#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo "Install Node.js 22 or newer, then retry: https://nodejs.org/en/download" >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo "Node.js 22 or newer is required." >&2; exit 1; }
dest="${OW_HOME:-$HOME/.ow}"
umask 077
mkdir -p "$dest"
tmp=$(mktemp "$dest/install.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
curl -fsSL "https://owterminal.com/ow.mjs" -o "$tmp"
node --input-type=module --check < "$tmp"
mv "$tmp" "$dest/ow.mjs"
printf '%s\n' '#!/bin/sh' 'exec node "$(dirname "$0")/ow.mjs" "$@"' > "$dest/ow"
chmod 700 "$dest/ow"
echo "OW is ready."
echo "Add $dest to your PATH, then run ow models."
