#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail

# A private bus and data directory exercise real encryption without touching a
# developer's login keyring or allowing plaintext storage as a test shortcut.
kalynt_keyring_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/kalynt-keyring.XXXXXX")
trap 'rm -rf "$kalynt_keyring_dir"' EXIT
export KALYNT_TEST_KEYRING_DIR="$kalynt_keyring_dir"
dbus-run-session -- bash -euo pipefail -c '
    export XDG_DATA_HOME="$KALYNT_TEST_KEYRING_DIR/data"
    mkdir -p "$XDG_DATA_HOME" "$KALYNT_TEST_KEYRING_DIR/control"
    printf "%s" "kalynt-disposable-ci-keyring" | gnome-keyring-daemon --unlock --components=secrets --control-directory="$KALYNT_TEST_KEYRING_DIR/control"
    xvfb-run -a npm run test:smoke --workspace=apps/desktop -- --no-sandbox --disable-gpu --password-store=gnome-libsecret
'
