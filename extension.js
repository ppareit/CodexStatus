import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class CodexStatusExtension extends Extension {
    enable() {
        this._indicator = null;
        this._enableToken = (this._enableToken ?? 0) + 1;
        const token = this._enableToken;

        const uri = this.dir.get_child('indicator.js').get_uri();
        const version = GLib.get_real_time();

        import(`${uri}?version=${version}`).then(module => {
            if (token !== this._enableToken)
                return;

            this._indicator = new module.CodexStatusIndicator();
            Main.panel.addToStatusArea('codex-status', this._indicator, 1, 'right');
        }).catch(error => {
            console.error(`Unable to load Codex Status implementation: ${error.message}`);
        });
    }

    disable() {
        this._enableToken = (this._enableToken ?? 0) + 1;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
