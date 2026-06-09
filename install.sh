#!/usr/bin/env bash
set -euo pipefail

uuid="codex-status@ppareit.local"
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target_dir="${HOME}/.local/share/gnome-shell/extensions/${uuid}"

mkdir -p "${target_dir}"
cp \
    "${source_dir}/metadata.json" \
    "${source_dir}/extension.js" \
    "${source_dir}/indicator.js" \
    "${source_dir}/stylesheet.css" \
    "${target_dir}/"

echo "Installed ${uuid} to ${target_dir}"
echo
if ! command -v gnome-extensions >/dev/null 2>&1; then
    echo "gnome-extensions was not found."
    echo "Restart GNOME Shell if needed, then enable it with:"
    echo "  gnome-extensions enable ${uuid}"
    exit 0
fi

if ! gnome-extensions list | grep -Fxq "${uuid}"; then
    echo "GNOME Shell has not picked up ${uuid} yet."
    echo "On Wayland, log out and back in once, then run:"
    echo "  gnome-extensions enable ${uuid}"
    exit 0
fi

if gnome-extensions info "${uuid}" | grep -q '^State: ENABLED'; then
    gnome-extensions disable "${uuid}" || true
fi

gnome-extensions enable "${uuid}"

echo "Reloaded ${uuid}"
