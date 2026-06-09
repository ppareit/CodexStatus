#!/usr/bin/env bash
set -euo pipefail

gnome-extensions pack \
    --force \
    --extra-source=indicator.js \
    --out-dir=. \
    .
