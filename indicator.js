import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const REFRESH_SECONDS = 5;
const SESSION_CHANGE_DEBOUNCE_MS = 250;
const STARTUP_CODEX_REFRESH_DELAY_SECONDS = 10;
const STARTUP_CODEX_REFRESH_TIMEOUT_SECONDS = 90;
const STARTUP_CODEX_REFRESH_PROMPT = 'Antwoord alleen met OK.';
const CODEX_SESSIONS_DIR = GLib.build_filenamev([
    GLib.get_home_dir(),
    '.codex',
    'sessions',
]);
const MAX_RATE_LIMIT_FILES = 10;
const PANEL_LIMIT_BAR_WIDTH = 34;
const MENU_LIMIT_BAR_WIDTH = 180;

function _findCodexExecutable() {
    const path = GLib.find_program_in_path('codex');
    if (path)
        return path;

    const localPath = GLib.build_filenamev([
        GLib.get_home_dir(),
        '.local',
        'bin',
        'codex',
    ]);

    if (GLib.file_test(localPath, GLib.FileTest.IS_EXECUTABLE))
        return localPath;

    return null;
}

function _remainingPercent(limit) {
    const value = limit?.used_percent;
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;

    return Math.max(0, Math.min(100, 100 - value));
}

function _limitLevelStyleClass(remainingPercent) {
    if (remainingPercent === null)
        return 'codex-limit-fill-unknown';

    if (remainingPercent <= 10)
        return 'codex-limit-fill-danger';

    if (remainingPercent <= 25)
        return 'codex-limit-fill-warning';

    return 'codex-limit-fill-ok';
}

function _formatElapsed(seconds) {
    if (seconds < 60)
        return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    if (hours < 24)
        return `${hours}h ${restMinutes}m`;

    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return `${days}d ${restHours}h`;
}

function _formatResetAt(resetAt) {
    if (typeof resetAt !== 'number' || !Number.isFinite(resetAt))
        return 'reset unknown';

    const now = Math.floor(Date.now() / 1000);
    const seconds = Math.max(0, resetAt - now);
    return `resets in ${_formatElapsed(seconds)}`;
}

function _isCodexProcess(process) {
    const command = `${process.command} ${process.args}`.toLowerCase();

    if (command.includes('codex-status@ppareit.local'))
        return false;

    return command.includes('/codex ') ||
        command.endsWith('/codex') ||
        command.includes(' codex ') ||
        command.startsWith('codex ') ||
        command.includes('codex-linux-sandbox') ||
        command.includes('/.codex/packages/');
}

function _parsePsOutput(output) {
    const processes = [];

    for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!match)
            continue;

        const process = {
            pid: Number.parseInt(match[1], 10),
            elapsed: Number.parseInt(match[2], 10),
            command: match[3],
            args: match[4],
        };

        if (_isCodexProcess(process))
            processes.push(process);
    }

    return processes.sort((a, b) => a.pid - b.pid);
}

function _collectSessionFiles(directory, files = []) {
    const file = Gio.File.new_for_path(directory);
    let enumerator;

    try {
        enumerator = file.enumerate_children(
            'standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            null);
    } catch {
        return files;
    }

    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        const child = GLib.build_filenamev([directory, name]);

        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            _collectSessionFiles(child, files);
        } else if (name.endsWith('.jsonl')) {
            files.push({
                path: child,
                modified: info.get_modification_date_time()?.to_unix() ?? 0,
            });
        }
    }

    enumerator.close(null);
    return files;
}

function _readFile(path) {
    const file = Gio.File.new_for_path(path);
    const [, contents] = file.load_contents(null);
    return new TextDecoder().decode(contents);
}

function _readLatestRateLimits() {
    const files = _collectSessionFiles(CODEX_SESSIONS_DIR)
        .sort((a, b) => b.modified - a.modified)
        .slice(0, MAX_RATE_LIMIT_FILES);

    for (const file of files) {
        let contents;
        try {
            contents = _readFile(file.path);
        } catch {
            continue;
        }

        const lines = contents.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let record;
            try {
                record = JSON.parse(lines[i]);
            } catch {
                continue;
            }

            const rateLimits = record.payload?.rate_limits;
            if (rateLimits?.primary || rateLimits?.secondary)
                return rateLimits;
        }
    }

    return null;
}

function _createLimitItem(label, limit) {
    const remainingPercent = _remainingPercent(limit);
    const fillWidth = Math.round((remainingPercent ?? 0) / 100 * MENU_LIMIT_BAR_WIDTH);
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
    });
    const row = new St.BoxLayout({
        vertical: true,
        style_class: 'codex-limit-row',
        x_expand: true,
    });
    const header = new St.BoxLayout({
        style_class: 'codex-limit-header',
        x_expand: true,
    });
    const name = new St.Label({
        text: label,
        style_class: 'codex-limit-name',
        x_expand: true,
    });
    const value = new St.Label({
        text: remainingPercent === null
            ? 'unavailable'
            : `${Math.round(remainingPercent)}% left`,
        style_class: 'codex-limit-percent',
    });
    const reset = new St.Label({
        text: limit ? _formatResetAt(limit.resets_at) : 'reset unknown',
        style_class: 'codex-limit-reset',
    });
    const bar = new St.Widget({
        style_class: 'codex-limit-bar',
        x_expand: true,
    });
    const fill = new St.Widget({
        style_class: `codex-limit-fill ${_limitLevelStyleClass(remainingPercent)}`,
        style: `width: ${fillWidth}px;`,
    });

    bar.add_child(fill);
    header.add_child(name);
    header.add_child(value);
    row.add_child(header);
    row.add_child(bar);
    row.add_child(reset);
    item.add_child(row);

    return item;
}

export class CodexStatusIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass({
            GTypeName: `CodexStatusIndicator_${GLib.get_real_time()}`,
        }, this);
    }

    constructor() {
        super(0.5, 'Codex Status');

        this._refreshSource = 0;
        this._queuedRefreshSource = 0;
        this._startupCodexRefreshSource = 0;
        this._startupCodexTimeoutSource = 0;
        this._startupCodexProc = null;
        this._refreshInFlight = false;
        this._sessionMonitors = new Map();
        this._processes = [];
        this._rateLimits = null;

        this._box = new St.BoxLayout({
            style_class: 'codex-status-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            icon_name: 'utilities-terminal-symbolic',
            style_class: 'system-status-icon',
        });
        this._panelLimits = new St.BoxLayout({
            vertical: true,
            style_class: 'codex-panel-limits',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._panelPrimaryFill = new St.Widget({
            style_class: 'codex-panel-limit-fill',
        });
        this._panelSecondaryFill = new St.Widget({
            style_class: 'codex-panel-limit-fill',
        });
        const panelPrimaryBar = new St.Widget({
            style_class: 'codex-panel-limit-bar',
        });
        const panelSecondaryBar = new St.Widget({
            style_class: 'codex-panel-limit-bar',
        });

        this._box.add_child(this._icon);
        panelPrimaryBar.add_child(this._panelPrimaryFill);
        panelSecondaryBar.add_child(this._panelSecondaryFill);
        this._panelLimits.add_child(panelPrimaryBar);
        this._panelLimits.add_child(panelSecondaryBar);
        this._box.add_child(this._panelLimits);
        this.add_child(this._box);

        this._statusItem = new PopupMenu.PopupMenuItem('Checking Codex status...', {
            reactive: false,
        });
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._limitSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._limitSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._processSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._processSection);

        this._syncSessionMonitors();
        this._refresh();
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_SECONDS,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        this._queueStartupCodexRefresh();
    }

    _queueRefresh() {
        if (this._queuedRefreshSource)
            return;

        this._queuedRefreshSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SESSION_CHANGE_DEBOUNCE_MS,
            () => {
                this._queuedRefreshSource = 0;
                this._syncSessionMonitors();
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _syncSessionMonitors() {
        for (const directory of this._collectSessionDirectories())
            this._monitorSessionDirectory(directory);
    }

    _collectSessionDirectories(directory = CODEX_SESSIONS_DIR, directories = []) {
        const file = Gio.File.new_for_path(directory);
        let enumerator;

        try {
            enumerator = file.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null);
        } catch {
            return directories;
        }

        directories.push(directory);

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;

            const child = GLib.build_filenamev([directory, info.get_name()]);
            this._collectSessionDirectories(child, directories);
        }

        enumerator.close(null);
        return directories;
    }

    _monitorSessionDirectory(directory) {
        if (this._sessionMonitors.has(directory))
            return;

        const file = Gio.File.new_for_path(directory);
        let monitor;

        try {
            monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch {
            return;
        }

        monitor.connect('changed', () => this._queueRefresh());
        this._sessionMonitors.set(directory, monitor);
    }

    _queueStartupCodexRefresh() {
        if (this._startupCodexRefreshSource)
            return;

        this._startupCodexRefreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            STARTUP_CODEX_REFRESH_DELAY_SECONDS,
            () => {
                this._startupCodexRefreshSource = 0;
                this._runStartupCodexRefresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    _runStartupCodexRefresh() {
        if (this._startupCodexProc)
            return;

        const codexPath = _findCodexExecutable();
        if (!codexPath) {
            console.warn('Unable to refresh Codex limits at startup: codex executable not found');
            return;
        }

        const proc = new Gio.Subprocess({
            argv: [
                codexPath,
                'exec',
                '--sandbox',
                'read-only',
                '--skip-git-repo-check',
                '-C',
                GLib.get_home_dir(),
                STARTUP_CODEX_REFRESH_PROMPT,
            ],
            flags: Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE,
        });

        try {
            proc.init(null);
        } catch (error) {
            console.warn(`Unable to refresh Codex limits at startup: ${error.message}`);
            return;
        }

        this._startupCodexProc = proc;
        this._startupCodexTimeoutSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            STARTUP_CODEX_REFRESH_TIMEOUT_SECONDS,
            () => {
                this._startupCodexTimeoutSource = 0;

                if (this._startupCodexProc)
                    this._startupCodexProc.force_exit();

                return GLib.SOURCE_REMOVE;
            });

        proc.wait_check_async(null, (subprocess, result) => {
            if (this._startupCodexTimeoutSource) {
                GLib.source_remove(this._startupCodexTimeoutSource);
                this._startupCodexTimeoutSource = 0;
            }

            this._startupCodexProc = null;

            try {
                subprocess.wait_check_finish(result);
            } catch (error) {
                console.warn(`Unable to refresh Codex limits at startup: ${error.message}`);
            }

            this._syncSessionMonitors();
            this._refresh();
        });
    }

    _setErrored(message) {
        this.remove_style_class_name('codex-status-active');
        this.add_style_class_name('codex-status-error');
        this._updatePanelLimitBars();
        this._statusItem.label.text = message;
        this._rebuildLimitMenu();
        this._processSection.removeAll();
    }

    _setProcesses(processes) {
        this.remove_style_class_name('codex-status-error');
        this._processes = processes;

        if (processes.length > 0) {
            this.add_style_class_name('codex-status-active');
            this._statusItem.label.text = processes.length === 1
                ? '1 Codex process is running'
                : `${processes.length} Codex processes are running`;
        } else {
            this.remove_style_class_name('codex-status-active');
            this._statusItem.label.text = 'No Codex process found';
        }

        this._updatePanelLimitBars();
        this._rebuildLimitMenu();
        this._rebuildProcessMenu();
    }

    _updatePanelLimitBars() {
        const primary = _remainingPercent(this._rateLimits?.primary);
        const secondary = _remainingPercent(this._rateLimits?.secondary);
        this._panelLimits.visible = primary !== null || secondary !== null;

        this._setPanelLimitBar(this._panelPrimaryFill, primary);
        this._setPanelLimitBar(this._panelSecondaryFill, secondary);
    }

    _setPanelLimitBar(fill, percent) {
        fill.remove_style_class_name('codex-limit-fill-ok');
        fill.remove_style_class_name('codex-limit-fill-warning');
        fill.remove_style_class_name('codex-limit-fill-danger');
        fill.remove_style_class_name('codex-limit-fill-unknown');

        fill.add_style_class_name(_limitLevelStyleClass(percent));
        fill.set_style(`width: ${Math.round((percent ?? 0) / 100 * PANEL_LIMIT_BAR_WIDTH)}px;`);
    }

    _rebuildLimitMenu() {
        this._limitSection.removeAll();

        this._limitSection.addMenuItem(_createLimitItem(
            '5h limit',
            this._rateLimits?.primary));
        this._limitSection.addMenuItem(_createLimitItem(
            'Weekly limit',
            this._rateLimits?.secondary));
    }

    _rebuildProcessMenu() {
        this._processSection.removeAll();

        for (const process of this._processes) {
            const item = new PopupMenu.PopupMenuItem(
                `PID ${process.pid} - ${_formatElapsed(process.elapsed)}`,
                {reactive: false});
            this._processSection.addMenuItem(item);
        }
    }

    _refresh() {
        if (this._refreshInFlight)
            return;

        this._refreshInFlight = true;

        const proc = new Gio.Subprocess({
            argv: ['/usr/bin/ps', '-eo', 'pid=,etimes=,comm=,args='],
            flags: Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE,
        });

        try {
            proc.init(null);
        } catch (error) {
            this._refreshInFlight = false;
            this._setErrored(`Unable to run ps: ${error.message}`);
            return;
        }

        proc.communicate_utf8_async(null, null, (subprocess, result) => {
            this._refreshInFlight = false;

            try {
                const [, stdout] = subprocess.communicate_utf8_finish(result);
                this._rateLimits = _readLatestRateLimits();
                this._setProcesses(_parsePsOutput(stdout));
            } catch (error) {
                this._setErrored(`Unable to read Codex status: ${error.message}`);
            }
        });
    }

    _onDestroy() {
        if (this._startupCodexRefreshSource) {
            GLib.source_remove(this._startupCodexRefreshSource);
            this._startupCodexRefreshSource = 0;
        }

        if (this._startupCodexTimeoutSource) {
            GLib.source_remove(this._startupCodexTimeoutSource);
            this._startupCodexTimeoutSource = 0;
        }

        if (this._startupCodexProc) {
            this._startupCodexProc.force_exit();
            this._startupCodexProc = null;
        }

        if (this._queuedRefreshSource) {
            GLib.source_remove(this._queuedRefreshSource);
            this._queuedRefreshSource = 0;
        }

        if (this._refreshSource) {
            GLib.source_remove(this._refreshSource);
            this._refreshSource = 0;
        }

        for (const monitor of this._sessionMonitors.values())
            monitor.cancel();

        this._sessionMonitors.clear();

        super._onDestroy();
    }
}
