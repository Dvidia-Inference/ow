#!/bin/sh
set -e
dest="${OW_HOME:-$HOME/.ow}"
mkdir -p "$dest"
curl -fsSL "https://raw.githubusercontent.com/dvidia-inference/ow/main/ow.mjs" -o "$dest/ow.mjs"
printf '%s\n' '#!/bin/sh' "exec node \"$dest/ow.mjs\" \"\$@\"" > "$dest/ow"
chmod +x "$dest/ow"
echo "OW is ready."
echo "export PATH=\"$dest:\$PATH\""
echo "ow"
