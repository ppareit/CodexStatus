# Codex Status GNOME Extension

Small GNOME Shell extension that adds a visual Codex status indicator to the
top bar.

The indicator refreshes every 5 seconds:

- The top bar shows a terminal icon. Its color indicates whether Codex is
  active.
- The top bar shows two compact bars for the 5h and weekly Codex limits when
  recent Codex status data is available. The bars show the percentage left, not
  the percentage used.
- The dropdown lists whether Codex is running.
- The dropdown lists matching PIDs and runtime.
- The dropdown lists the 5h limit and weekly limit with larger bars,
  percentages left, and reset times.

## Install

```bash
./install.sh
```

The install script copies the files and reloads the extension with
`gnome-extensions disable/enable` when GNOME Shell already knows about the
extension. During normal development, run `./install.sh` after a change and the
updated extension should appear immediately.

GNOME Shell caches extension JavaScript modules for the lifetime of the shell
process. This extension keeps `extension.js` as a small loader and loads
`indicator.js` with a changing version parameter, so changes to the indicator
code are picked up by `./install.sh` without logging out. After changing the
loader itself, log out and back in once on Wayland, or restart GNOME Shell on
Xorg, before continuing development.

On the first install, if GNOME does not see the extension immediately, log out
and back in once, then run:

```bash
gnome-extensions enable codex-status@ppareit.local
```

## Files

- `metadata.json`: GNOME Shell extension metadata.
- `extension.js`: small loader that imports the indicator implementation.
- `indicator.js`: panel indicator and process polling logic.
- `stylesheet.css`: small status styles.
- `install.sh`: copies the extension into the per-user GNOME extensions folder.
