// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// Alt-Tab Enhanced, the advanced window-switcher applet for Cinnamon, version 1.8 or later.
// Copyright (C) 2013 Per Ångström, see LICENSE file.

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Cinnamon = imports.gi.Cinnamon;
const Signals = imports.signals;
const St = imports.gi.St;

const Applet = imports.ui.applet;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const PopupMenu = imports.ui.popupMenu;
const Tweener = imports.ui.tweener;

const PointerTracker = imports.misc.pointerTracker;
const Util = imports.misc.util;
const WindowUtils = imports.misc.windowUtils;

const AppletManager = imports.ui.appletManager;
const MessageTray = imports.ui.messageTray;

var Connector;

var Settings = null;
try {
    Settings = imports.ui.settings; // requires Cinnamon 1.7.2 or later
}
catch (e) {}

const POPUP_SCROLL_TIME = 0.10; // seconds
const POPUP_DELAY_TIMEOUT = 110; // milliseconds

const THUMBNAIL_FADE_TIME = 0.1; // seconds

const PREVIEW_DELAY_TIMEOUT = 180; // milliseconds
var PREVIEW_SWITCHER_FADEOUT_TIME = 0.5; // seconds

const DEMANDS_ATTENTION_CLASS_NAME = "window-list-item-demands-attention";

const MAX_ICON_SIZE = 128;
const iconSizes = [96, 80, 72, 64, 56, 48, 40, 32, 24];

var g_version = "unknown";

const HELP_TEXT = [
    "",
    _("Escape: Close Alt-Tab and return to the currently active window"),
    _("Return: Activate the currently selected window and close Alt-Tab"),
    _("Tab, Right arrow: Select next right"),
    _("Shift+Tab, Left arrow: Select next left"),
    _("Home: Select first window"),
    _("End: Select last window"),
    _("Ctrl+Right arrow: Skip right"),
    _("Ctrl+Left arrow: Skip left"),
    _("Space: Select/unselect current window"),
    _("Menu key, Right-click: Open context menu for the selected windows"),
    _("m: Move selected windows to next monitor"),
    _("n: Minimize/restore selected windows"),
    _("Super+Left/Right arrow: Move selected windows to the next workspace right/left"),
    _("Period key (.): Move selected windows to the current workspace"),
    _("Ctrl+w: Close selected windows. Use with care!"),
    _("Ctrl+g: Toggle \"global mode\", in which windows from all workspaces are mixed, sorted on last use"),
    _("Ctrl+a: Select/Unselect all windows at once"),
    _("z: Zoom to see all windows at once without scrolling (toggle)"),
    _("F4: Switch between the most common Alt-Tab styles"),
    _("F5: Toggle between seeing all windows or only windows from the current workspace"),
    _("F6: Change vertical alignment of switcher bar (top->center->bottom)"),
    _("Shift+F6: Toggle full-screen thumbnails on/off"),
    _("F7: Toggle display of thumbnail header (showing window icon and title)"),
    _("F8: Toggle single-line window-title labels on/off"),
    _("F9: Switch between the different thumbnail-behind-icon styles (always, never, behind-identical-icons)"),
    _("Shift+F10: Make the current configuration permanent"),
    _("F1: Show this quick-help screen"),
    "",
];

const KeyState = {
    PRESSED: 1,
    RELEASED: 2
};

function mod(a, b) {
    return (a + b) % b;
}

function primaryModifier(mask) {
    if (mask == 0)
        return 0;

    let primary = 1;
    while (mask > 1) {
        mask >>= 1;
        primary <<= 1;
    }
    return primary;
}

let g_selection = [];

let g_monitorOverride = null;
let g_vAlignOverride = null;
function getVerticalAlignment() {
    return g_vAlignOverride || g_settings["vertical-alignment"];
}

var g_uuid;
function openSettings() {
    Util.spawnCommandLine("cinnamon-settings applets " + g_uuid);
}

var g_setup = {};
function processSwitcherStyle() {
    g_setup._previewEnabled = false;
    g_setup._iconsEnabled = false;
    g_setup._thumbnailsEnabled = false;
    g_setup._previewThumbnails = false;

    let styleSettingsMaster = g_settings["style"];
    let isSystemStyle = styleSettingsMaster == ":system";
    let styleSettings = isSystemStyle ? g_vars.switcherStyle : styleSettingsMaster;

    let found = false;
    if (styleSettings.indexOf(":") < 0) {
        let features = styleSettings.split('+');
        for (let i in features) {
            if (features[i] === 'icons') {
                g_setup._iconsEnabled = true;
                found = true;
            }
            if (features[i] === 'preview') {
                g_setup._previewEnabled = true;
                found = true;
            }
            if (features[i] === 'thumbnails') {
                g_setup._thumbnailsEnabled = true;
                found = true;
            }
        }
    }
    else {
        if (styleSettings == ":preview-thumbnails") {
            g_setup._iconsEnabled = true;
            g_setup._previewEnabled = true;
            g_setup._previewThumbnails = true;
        }
    }
    if (!found) {
        g_setup._iconsEnabled = true;
    }

    g_setup._showThumbnails = g_setup._thumbnailsEnabled;
}

const g_aligmentTypes = ["top", "center", "bottom"];
const g_alttabStyles = ["icons+preview", ":preview-thumbnails", "icons", "icons+thumbnails"]; // the most usual ones ...
const g_thumbnailIconOptions = ["behind-identical", "always", "never"];

function getSwitcherStyle() {
    g_vars.switcherStyle = global.settings.get_string("alttab-switcher-style");
    processSwitcherStyle();
};

var g_vars = Main._alttab_enhanced_vars;
if (!g_vars) {
    g_vars = Main._alttab_enhanced_vars = {};
// there are some things we want to live on, even when we are disabled,
// so that we don't have to start from scratch if we are enabled again
    g_vars.windowsOrdered = [];
    g_vars.globalFocusOrder = false;
    g_vars.g_lastWindowHotkey = -1;
    g_vars.g_hotKeyAssignment = {};

    global.display.connect('notify::focus-window', function(display) {
        g_vars.windowsOrdered = g_vars.windowsOrdered.filter(function(window) {
            return window && window != display.focus_window && isValidWindow(window);
        }, this);
        g_vars.windowsOrdered.unshift(display.focus_window);
    });
    global.settings.connect('changed::alttab-switcher-style', getSwitcherStyle);

    // this object will be populated with our settings, if settings support is available
    g_vars.settings = {};
}

const g_settings = g_vars.settings;

var g_myMonitor = Main.layoutManager.primaryMonitor;
var g_myMonitorIndex = Main.layoutManager.primaryIndex;

var g_activeWsIndex = null;
//----
var g_hotKeyAssignment = g_vars.g_hotKeyAssignment;

function assignHotkey(window, force) {
    if (!window._alttab_hotkey || force) {
        ++g_vars.g_lastWindowHotkey;
        window._alttab_hotkey = {index: g_vars.g_lastWindowHotkey};
        g_hotKeyAssignment[g_vars.g_lastWindowHotkey] = window;
    }
    return window._alttab_hotkey.index;
}

function assignHotkeys(newones_in, remove) {
    if (!newones_in) {
        return;
    }
    let newones = newones_in.slice();
    newones.slice().sort(function(a, b) {
        return -((a._alttab_hotkey ? a._alttab_hotkey.index : 0) - (b._alttab_hotkey ? b._alttab_hotkey.index : 0));
    }).forEach(function(window) {
        unassignHotkey(window);
    });

    if (remove) {
        return;
    }

    // fill the empty slots
    for (let i = 0; newones.length && i < g_vars.g_lastWindowHotkey; ++i) {
        let window = g_hotKeyAssignment[i];
        if (!window) {
            window = newones.shift();
            g_hotKeyAssignment[i] = window;
            window._alttab_hotkey = {index: i};
        }
    }

    // add the rest
    newones.forEach(function(window) {
        assignHotkey(window);
    });
}

function unassignHotkey(window) {
    if (window._alttab_hotkey) {
        if (window._alttab_hotkey.index == g_vars.g_lastWindowHotkey) {
            --g_vars.g_lastWindowHotkey;
        }
        delete g_hotKeyAssignment[window._alttab_hotkey.index];
        delete window._alttab_hotkey;
    }
}

//----
var g_windowTracker = Cinnamon.WindowTracker.get_default();

function createApplicationIcon(app, size) {
    return app ?
        app.create_icon_texture(size) :
        new St.Icon({ icon_name: 'application-default-icon',
            icon_type: St.IconType.FULLCOLOR,
            icon_size: size
        });
}

function getTabList(workspaceOpt, screenOpt) {
    let screen = screenOpt || global.screen;
    let display = screen.get_display();
    let workspace = workspaceOpt || screen.get_active_workspace();

    let allwindows = display.get_tab_list(Meta.TabList.NORMAL_ALL, screen,
                                       workspace);
    if (allwindows.length) {
        return allwindows.filter(Main.isInteresting);
    }
    return [];
}

function isEmptyWorkspace(ws) {
    return getTabList(ws).filter(function(window) {
        return !window.is_on_all_workspaces();
    }).length == 0;
}

// -------------------------------------------------------------------------

function AltTabPopup() {
    this._init();
}

function selectMonitor(monitorOverride)
{
    let index = -1;
    let monitor = null;
    if (!monitorOverride) {
        let mIndex;
        switch (g_settings["preferred-monitor"]) {
            case ":primary":
                mIndex = "primaryMonitor"; break;
            case ":bottom":
                mIndex = "bottomMonitor"; break;
            case ":focus":
                mIndex = "focusMonitor"; break;
            case ":secondary":
                index = Math.min(1, Main.layoutManager.monitors.length - 1);
                mIndex = null; break;
            default:
                mIndex = "primaryMonitor"; break;
        }
        if (mIndex) {
            index = Main.layoutManager.monitors.indexOf(Main.layoutManager[mIndex]);
        }
    } else {
        index = Main.layoutManager.monitors.indexOf(monitorOverride);
    }
    index = index >= 0 ? index : 0;
    monitor = Main.layoutManager.monitors[index];
    return [index, monitor];
}

function setupWorkspaceListeners(alttab)
{
    g_vars.altTabPopup = alttab;
    if (!alttab) {return;}
    if (g_vars.altTabPopup_connected) {return;}

    g_vars.altTabPopup_connected = true;
    let connectToWorkspace = Lang.bind(this, function(workspace) {
        workspace.connect('window-removed', Lang.bind(null, function(ws, metaWindow) {
            if (!isValidWindow(metaWindow)) {
                unassignHotkey(metaWindow);
            }
            if (g_vars.altTabPopup) {g_vars.altTabPopup._removeWindow(metaWindow);}
        }));
        workspace.connect('window-added', Lang.bind(null, function(ws, metaWindow) {
            if (g_vars.altTabPopup) {
                Mainloop.idle_add(Lang.bind(null, function() {
                    if (g_vars.altTabPopup) {
                        g_vars.altTabPopup.refresh();
                    }
                }));
            }
        }));
    });
    for (let [i, numws] = [0, global.screen.n_workspaces]; i < numws; ++i) {
        let workspace = global.screen.get_workspace_by_index(i);
        connectToWorkspace(workspace);
    }

    global.display.connect('window-demands-attention', function() {
        if (g_vars.altTabPopup) g_vars.altTabPopup._onWindowDemandsAttention.apply(g_vars.altTabPopup, arguments);
    });
    global.display.connect('window-marked-urgent', function() {
        if (g_vars.altTabPopup) g_vars.altTabPopup._onWindowDemandsAttention.apply(g_vars.altTabPopup, arguments);
    });
    global.screen.connect('workspace-added', Lang.bind(this, function(screen, index) {
        let workspace = global.screen.get_workspace_by_index(index);
        connectToWorkspace(workspace);
    }));
    global.screen.connect('workspace-removed', function() {
        if (g_vars.altTabPopup) g_vars.altTabPopup.refresh();
    });
    global.screen.connect('window-left-monitor', function() {
        if (g_vars.altTabPopup) g_vars.altTabPopup.refresh();
    });
}

function isSpecialWorkspaceHandling() {
    return Main.wm.workspacesOnlyOnPrimary && Main.layoutManager.monitors.length > 1;
}

function isOnWorkspaceIndex(mw, index) {
    let ix = getWindowWorkspaceIndex(mw);
    return ix == index;
}

function getWindowWorkspaceIndex(mw) {
    return (isSpecialWorkspaceHandling() && mw.get_monitor() != Main.layoutManager.primaryIndex)
        ? -1
        : mw.get_workspace() ? mw.get_workspace().index() : -1;
}

function getWindowWorkspace(mw) {
    return isSpecialWorkspaceHandling() && mw.get_monitor() == Main.layoutManager.primaryIndex
        ? mw.get_workspace()
        : global.screen.get_active_workspace();
}

function moveToMonitor(mw, target) {
    mw.foreach_transient(function(transient) {
        transient.move_to_monitor(target);
    });
    mw.move_to_monitor(target);
}

function changeWindowWorkspace(mw, ws) {
    if (isSpecialWorkspaceHandling() && mw.get_monitor() != Main.layoutManager.primaryIndex) {
        moveToMonitor(mw, Main.layoutManager.primaryIndex);
    }
    mw.change_workspace(ws);
    return true;
}

function isValidWindow(mw) {
    return !!mw.get_compositor_private();
}

var g_firstWorkspaceIndex = 0;

AltTabPopup.prototype = {
    _init : function() {
        this._loadTs = (new Date()).getTime();
        [g_myMonitorIndex, g_myMonitor] = selectMonitor(g_monitorOverride);
        this.actor = new Cinnamon.GenericContainer({ name: 'altTabPopup',
                                                  reactive: true,
                                                  visible: false });

        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this.opacity = 255;
        this._haveModal = false;
        this._modifierMask = 0;

        // Keeps track of the number of "primary" items, which is the number
        // of windows on the current workspace. This information is used to
        // size the icons to a size that fits the current working set.
        this._numPrimaryItems = 0;

        this.thumbnailsVisible = false;
        Main.uiGroup.add_actor(this.actor);
        setupWorkspaceListeners(this);
    },

    _indexOfWindow: function(metaWindow) {
        let index = -1;
        if (!this._appSwitcher || !this._appIcons) {
            return index;
        }
        this._appIcons.some(function(ai, ix) {
            if (ai.window == metaWindow) {
                index = ix;
                return true; // break
            }
            return false; // continue
        }, this);
        return index;
    },

    _removeWindow: function(metaWindow) {
        if (!isValidWindow(metaWindow)) {
            let index = g_selection.indexOf(metaWindow);
            if (index >= 0) {
                g_selection.splice(index, 1);
            }
        }
        let index = this._indexOfWindow(metaWindow);
        if (index >= 0) {
            if (index == this._currentApp) {
                this._clearPreview();
                this._destroyThumbnails();
            }
            if (metaWindow == this._homeWindow) {
                this._homeWindow = null;
            }
            this._appSwitcher._removeIcon(index);
            this._minorRefresh();
            this.refresh();
        }
    },

    _onWindowDemandsAttention: function(display, metaWindow) {
        let index = this._indexOfWindow(metaWindow);
        if (index >= 0) {
            this._appIcons[index]._checkAttention();
        }
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        alloc.min_size = global.screen_width;
        alloc.natural_size = global.screen_width;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        alloc.min_size = global.screen_height;
        alloc.natural_size = global.screen_height;
    },

    _allocate: function (actor, box, flags) {
        let childBox = new Clutter.ActorBox();
        let primary = g_myMonitor;

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
        let vPadding = this.actor.get_theme_node().get_vertical_padding();
        let hPadding = leftPadding + rightPadding;

        // Allocate the appSwitcher
        // We select a size based on an icon size that does not overflow the screen
        let [childMinHeight, childNaturalHeight] = this._appSwitcher.actor.get_preferred_height(primary.width - hPadding);
        let [childMinWidth, childNaturalWidth] = this._appSwitcher.actor.get_preferred_width(childNaturalHeight);
        childNaturalWidth = Math.max(childNaturalWidth, primary.width/8);
        childBox.x1 = Math.max(primary.x + leftPadding, primary.x + Math.floor((primary.width - childNaturalWidth) / 2));
        childBox.x2 = Math.min(primary.x + primary.width - rightPadding, childBox.x1 + childNaturalWidth);
        let vAlignment = getVerticalAlignment();
        childBox.y1 = primary.y + Math.floor(
            vAlignment == 'center'
                ? (primary.height - childNaturalHeight) / 2
                : vAlignment == 'top'
                    ? 0
                    : primary.height - childNaturalHeight);
        childBox.y2 = childBox.y1 + childNaturalHeight;
        this._appSwitcher.actor.allocate(childBox, flags);

        // Allocate the thumbnails
        // We try to avoid overflowing the screen so we base the resulting size on
        // those calculations
        if (this._thumbnails && this._currentApp >= 0) {
            let icon = this._appIcons[this._currentApp].actor;
            let [posX, posY] = icon.get_transformed_position();
            let thumbnailCenter = posX + icon.width / 2;
            let spacing = this.actor.get_theme_node().get_length('spacing');
            let spacing2 = Math.floor(spacing/2);
            if (!g_settings["full-screen-thumbnails"]) {
                let thHeight = vAlignment == 'center'
                    ? primary.height - (this._appSwitcher.actor.allocation.y2 - primary.y) - spacing
                    : primary.height - (this._appSwitcher.actor.allocation.y2 - this._appSwitcher.actor.allocation.y1) - spacing
                    ;
                let thWidth = Math.floor(thHeight * primary.width / primary.height) + leftPadding * 2;

                childBox.x1 = primary.x + Math.floor((primary.width - thWidth)/2);
                childBox.x2 = childBox.x1 +  thWidth;
                childBox.y1 = vAlignment == 'bottom'
                    ? this._appSwitcher.actor.allocation.y1 - thHeight - spacing2
                    : this._appSwitcher.actor.allocation.y2 + spacing2
                    ;
                childBox.y2 = childBox.y1 + thHeight;
            } else {
                let thHeight = primary.height - spacing;
                let thWidth = Math.floor(thHeight * primary.width / primary.height) + leftPadding * 2;
                childBox.x1 = primary.x + Math.floor((primary.width - thWidth)/2);
                childBox.x2 = childBox.x1 +  thWidth;
                childBox.y1 = primary.y + spacing2;
                childBox.y2 = childBox.y1 + thHeight;
            }
           this._thumbnails.actor.allocate(childBox, flags);
        }
    },

    set _currentApp(val) {
        this._appSwitcher._curApp = val;
    },

    get _currentApp() {
        return !isNaN(this._appSwitcher._curApp) ?  this._appSwitcher._curApp : -1;
    },

    get _appIcons() {
        return this._appSwitcher.icons;
    },

    refresh : function(binding, backward) {
        this._refreshCount = (this._refreshCount || 0) + 1;
        if (!this.actor) {return false;} // asynchronous death
        if (this._appSwitcher) {
            this._destroyThumbnails();
            this._appSwitcher.actor.destroy();
        }

        let stamp = new Date().getTime();
        let filterDuplicates = function(window) {
            try {
                return window._alttab_stamp != stamp;
            } finally {
                window._alttab_stamp = stamp;
            }
        };

        let cwsi = global.screen.get_active_workspace_index();
        // if there are duplicates, we want the "original" window to be on the current workspace
        let wsWindows = getTabList().filter(filterDuplicates);
        
        let ws_slots = {};
        for (let i = 0, numws = global.screen.n_workspaces; i < numws; ++i) {
            let windows = i == cwsi ? wsWindows : getTabList(global.screen.get_workspace_by_index(i)).filter(filterDuplicates);
            windows.forEach(function(window) {
                let indx = getWindowWorkspaceIndex(window);
                let slot = ws_slots[indx] || [];
                slot.push(window);
                ws_slots[indx] = slot;
            });
        }

        let [currentWindow, forwardWindow, backwardWindow] = [wsWindows[0], null, null];

        let windows = [];
        let [currentIndex, forwardIndex, backwardIndex] = [-1, -1, -1];

        let activeWsIndex = g_activeWsIndex = wsWindows.length && getWindowWorkspaceIndex(currentWindow) == -1 ? -1 : global.screen.get_active_workspace_index();
        let awsMode = g_settings["all-workspaces-mode"];
        for (let i = -1, numws = global.screen.n_workspaces; i < numws; ++i) {
            let wlist = ws_slots[i];
            if (!wlist || !wlist.length) {
                continue;
            }
            if ((i == activeWsIndex || awsMode) || (!awsMode && i == -1)) {
                windows = windows.concat(wlist);
            }
            if (i == activeWsIndex) {
                currentIndex = windows.indexOf(currentWindow);
                // Quick alt-tabbing (with no use of the switcher) should only
                // select between the windows of the active workspace.
                forwardWindow = windows[wlist.length > 1 ? currentIndex + 1 : currentIndex];
                backwardWindow = windows[wlist.length > 1 ? currentIndex + wlist.length - 1 : currentIndex];
            }
        }

        g_firstWorkspaceIndex = ws_slots[-1] ? -1 : 0;

        if (g_vars.globalFocusOrder) {
            windows = windows.sort(function(a, b) {
                let minimizedDiff = (a.minimized ? 1 : 0) - (b.minimized ? 1 : 0);
                if (minimizedDiff) return minimizedDiff;
                let inGlobalListDiff = (g_vars.windowsOrdered.indexOf(a) < 0 ? 1 : 0) - (g_vars.windowsOrdered.indexOf(b) < 0 ? 1 : 0);
                if (inGlobalListDiff) {
                    return inGlobalListDiff;
                }
                let globalDiff = g_vars.windowsOrdered.indexOf(a) - g_vars.windowsOrdered.indexOf(b);
                return globalDiff || windows.indexOf(a) - windows.indexOf(b);
            }, this);
            currentWindow = windows[0];
            forwardWindow = windows[1];
            backwardWindow = windows[windows.length - 1];
        }

        currentIndex = windows.indexOf(currentWindow);
        if (forwardWindow) {forwardIndex = windows.indexOf(forwardWindow)};
        if (backwardWindow) {backwardIndex = windows.indexOf(backwardWindow)};

        // Size the icon bar primarily to fit the windows of the current workspace, and a few more
        this._numPrimaryItems_Orig = Math.min(Math.max(2, wsWindows.length + 4), windows.length);
        this._numPrimaryItems = g_settings["zoom-on"] ? this._numPrimaryItems_Orig : windows.length;
        this._zoomedOut = this._numPrimaryItems != this._numPrimaryItems_Orig;

        this._createAppswitcher(windows);
        
        this._appSwitcher.actor.opacity = (this._refreshCount > 1 || this._persistent) ? 255 : 0;
        this.actor.show();
        
        if (!this._homeWindow) {
            this._homeWindow = currentWindow;
        }

        // if we are refreshing after already being shown, retain current selection, if possible.
        // but only if we are on the same workspace as the selected window.
        let selectedWindow = this._selectedWindow && wsWindows.indexOf(this._selectedWindow) >= 0 ? this._selectedWindow : null;
        if (g_selection.length) {
            let isel = selectedWindow ? g_selection.indexOf(selectedWindow) : -1;
            forwardIndex = isel >= 0 ? windows.indexOf(selectedWindow) : -1;
        }
        else if (selectedWindow) {
            forwardIndex = windows.indexOf(selectedWindow);
        }

        // Make the initial selection
        if (this._appIcons.length > 0 && (currentIndex >= 0 || forwardIndex >= 0)) {
            if (binding == 'no-switch-windows' || binding == 'switch-group') {
                this._select(currentIndex);
                this._appSwitcher._scrollTo(backwardIndex, 1, 3, true);
                this._appSwitcher._scrollTo(currentIndex, -1, 2, true);
            } else if (backward) {
                this._select(backwardIndex);
                this._appSwitcher._scrollTo(backwardIndex, 1, 0, true);
            } else if (forwardIndex >= 0) {
                this._select(forwardIndex);
                // ensure that all the windows of the current workspace are in view
                this._appSwitcher._scrollTo(backwardIndex, 1, 3, true);
                this._appSwitcher._scrollTo(forwardIndex, -1, 2, true);
            } else {
                this._select(-1, true);
            }
        } else {
            this._clearPreview();
            this._select(-1, true);
        }
        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details.) So we check now. (Have to do this after updating
        // selection.)
        if (!this._persistent) {
            let state = this._getModifierState();
            if (state == 0) {
                return false;
            }
        }

        if (this._appSwitcher.actor.opacity != this.opacity) {
            // We delay showing the popup so that fast Alt+Tab users aren't
            // disturbed by the popup briefly flashing.
            let timeout = POPUP_DELAY_TIMEOUT - ((new Date().getTime()) - this._loadTs);
            if (timeout > 25) {
                Mainloop.timeout_add(timeout, Lang.bind(this, function () {
                    if (this.actor) {
                        this._appSwitcher.actor.opacity = this.opacity;
                    }
                }));
            }
            else {
                this._appSwitcher.actor.opacity = this.opacity;
            }
        }
        
        if (g_settings["all-workspaces-mode"] && g_settings["display-origin-arrow"] && !g_vars.globalFocusOrder) { // restricted feature
            this._appSwitcher._indicateItem(currentIndex, "_currentFocus", St.Side.TOP);
        }
        return true;
    },

    _multiChangeToTemporaryWorkspace: function(selection) {
        let lastWsIndex = global.screen.n_workspaces - 1;
        let selection2 = selection.slice();
        let firstMw = selection2.shift();
        Main.moveWindowToNewWorkspace(firstMw, false);
        let lastWsIndexNew = global.screen.n_workspaces - 1;
        if (lastWsIndexNew > lastWsIndex) {
            let ws = global.screen.get_workspace_by_index(lastWsIndexNew);
            selection2.forEach(function(mw) {
                changeWindowWorkspace(mw, ws);
            });
            ws.connect('window-removed', function() {
                Mainloop.timeout_add_seconds(10, function() {
                    if (ws.index() >= 0 && !getTabList(ws).filter(function(window) {
                        return !window.is_on_all_workspaces();
                    }).length) {
                        if (Main.hasDefaultWorkspaceName(ws.index())) {
                            Main._removeWorkspace(ws);
                        }
                    }
                });
            });
        }
    },

    _multiChangeToEmptyWorkspace: function(selection) {
        for (let i = 0; i < global.screen.n_workspaces; ++i) {
            let ws = global.screen.get_workspace_by_index(i);
            if (isEmptyWorkspace(ws)) {
                selection.forEach(function(mw) {
                    changeWindowWorkspace(mw, ws);
                });
                return;
            }
        }
        this._multiChangeToTemporaryWorkspace(selection);
    },

    _multiChangeToCurrentWorkspace: function(selection) {
        let ws = global.screen.get_active_workspace();
        selection.forEach(function(mw) {
            if (!isOnWorkspaceIndex(mw, ws.index())) {
                changeWindowWorkspace(mw, ws);
            }
        });
        this.refresh();
    },

    _multiMoveWorkspace: function(selin, direction) {
        if (!selin.length) {return;}
        // If all windows belong to the same workspace, all are moved left or right.
        // Otherwise, only move some windows, left or right, so they all end up on the same workspace.

        let selection = selin.slice();
        selection.sort(function(a, b) {return getWindowWorkspaceIndex(a) < getWindowWorkspaceIndex(b);});
        let current = getWindowWorkspaceIndex(selection[direction > 0 ? selection.length - 1 : 0]);
        let nextIndex = direction > 0
            ? (current > getWindowWorkspaceIndex(selection[0]) 
                ? current
                : Math.min(current + direction, global.screen.n_workspaces - 1))
            : (current < getWindowWorkspaceIndex(selection[selection.length - 1])
                ? current
                : Math.max(current + direction, 0));
        selection.forEach(function(mw) {
            if (direction > 0 ? getWindowWorkspaceIndex(mw) < nextIndex : getWindowWorkspaceIndex(mw) > nextIndex) {
                changeWindowWorkspace(mw, global.screen.get_workspace_by_index(nextIndex));
            }
        });
    },

    _minorRefresh: function() {
        this._select(this._currentApp, true);
    },

    _multiMoveMonitor: function(selin, index) {
        if (!selin.length) {return;}
        let monitorCount = Main.layoutManager.monitors.length;
        if (monitorCount < 2) {return;}

        let selection = selin.slice();
        selection.sort(function(a, b) {return a.get_monitor() < b.get_monitor();});
        let target = index === undefined ? (selection[0].get_monitor() + monitorCount + 1) % monitorCount : index;
        selection.forEach(function(mw) {
            if (mw.get_monitor() != target) {
                moveToMonitor(mw, target);
                if (isSpecialWorkspaceHandling() && target == Main.layoutManager.primaryIndex) {
                    mw.unstick();
                }
            }
        });
        this._minorRefresh();
    },

    _multiClose: function(selection) {
        selection.sort(function(a, b){
            // sort so that the highest hotkey gets deleted first
            return -((a._alttab_hotkey ? a._alttab_hotkey.index : 0) - (b._alttab_hotkey ? b._alttab_hotkey.index : 1));
        }).forEach(function(mw) {
            mw.delete(global.get_current_time());
        });
        this._minorRefresh();
    },

    _multiAssignHotkey: function(selection, remove) {
        assignHotkeys(selection, remove);
        this.refresh();
    },

    _multiRestore: function(selection) {
        selection.forEach(function(mw) {
            if (mw.minimized) {mw.unminimize();}
        });
        this._minorRefresh();
    },

    _multiIgnore: function(selection) {
        let allIgnored = (selection.filter(function(mw) {return mw._alttab_ignored;}).length == selection.length);
        selection.forEach(function(mw) {
            let iconIndex = this._indexOfWindow(mw);
            if (allIgnored || mw._alttab_ignored) {
                mw._alttab_ignored = false;
            }
            else {
                mw._alttab_ignored = true;
                unassignHotkey(mw);
             }
            this._minorRefresh();
        }, this);
    },

    _multiMinimize: function(selection) {
        let allMinimized = (selection.filter(function(mw) {return mw.minimized;}).length == selection.length);
        selection.forEach(function(mw) {
            if (allMinimized) {mw.unminimize();}
            else if (!mw.minimized) {mw.minimize();}
        });
        this.refresh();
    },

    _populateCommonWindowContextMenuItems: function(selection) {
        let items = [];
        items.push(new PopupMenu.PopupSeparatorMenuItem());
        
        let itemCloseWindow = new PopupMenu.PopupMenuItem(_("Close"));
        itemCloseWindow.connect('activate', Lang.bind(this, function(actor, event){
            selection.forEach(function(mw) {
                mw.delete(global.get_current_time());
            });
        }));
        items.push(itemCloseWindow);

        let minimizedCount = selection.filter(function(mw) {return mw.minimized;}).length;
        let someMinimized = minimizedCount && minimizedCount < selection.length;
        let noneMinimized = minimizedCount == 0;

        if (someMinimized) {
            let itemMinimizeWindow = new PopupMenu.PopupMenuItem(_("Restore"));
            itemMinimizeWindow.connect('activate', Lang.bind(this, function(actor, event){
                this._multiRestore(selection);
            }));
            items.push(itemMinimizeWindow);
            let itemRestoreWindow = new PopupMenu.PopupMenuItem(_("Minimize"));
            itemRestoreWindow.connect('activate', Lang.bind(this, function(actor, event){
                this._multiMinimize(selection);
            }));
            items.push(itemRestoreWindow);
        }
        else {
            let itemMinimizeWindow = new PopupMenu.PopupMenuItem(noneMinimized ? _("Minimize") : _("Restore"));
            itemMinimizeWindow.connect('activate', Lang.bind(this, function(actor, event){
                (noneMinimized ? this._multiMinimize : this._multiRestore).call(this, selection);
            }));
            items.push(itemMinimizeWindow);
        }

        if (selection.length) {
            let wn_items = [];
            let some_unassignable = selection.some(function(mw) {return mw._alttab_hotkey;});
            let some_assignable = selection.some(function(mw) {return !mw._alttab_hotkey;});
            let reassignable = !some_assignable && selection.length > 1 && selection.some(function(mw, index) {
                if (index == 0) {return false;}
                return !mw._alttab_hotkey || !selection[index -1]._alttab_hotkey || selection[index -1]._alttab_hotkey.index > mw._alttab_hotkey.index;
            });
            if (reassignable) {
                let item = new PopupMenu.PopupMenuItem(_("Reassign window number"));
                item.connect('activate', Lang.bind(this, function(actor, event){
                    this._multiAssignHotkey(selection);
                }));
                wn_items.push(item);
            } else if (some_assignable) {
                let item = new PopupMenu.PopupMenuItem(_("Assign window number"));
                item.connect('activate', Lang.bind(this, function(actor, event){
                    this._multiAssignHotkey(selection.filter(function(mw) {return !mw._alttab_hotkey;}));
                }));
                wn_items.push(item);
            }
            if (some_unassignable) {
                let item = new PopupMenu.PopupMenuItem(_("Unassign window number"));
                item.connect('activate', Lang.bind(this, function(actor, event){
                    this._multiAssignHotkey(selection, true);
                }));
                wn_items.push(item);
            }
            if (wn_items.length < 2) {
                items = items.concat(wn_items);
            } else {
                let submenu = new PopupMenu.PopupSubMenuMenuItem(_("Window numbers"));
                wn_items.forEach(function(item) {
                    submenu.menu.addMenuItem(item);
                });
                items.push(submenu);           
            }
        }

        if (selection.length > 1) {
            let itemUnselectAll = new PopupMenu.PopupMenuItem(_("Unselect all"));
            itemUnselectAll.connect('activate', Lang.bind(this, function(actor, event){
                g_selection = [];
                this._minorRefresh();
            }));
            items.push(new PopupMenu.PopupSeparatorMenuItem());
            items.push(itemUnselectAll);
        } else {
            let emptyWorkspaces = [];
            for (let i = 0; i < global.screen.n_workspaces; ++i) {
                if (!Main.hasDefaultWorkspaceName(i)) {
                    continue;
                }
                let ws = global.screen.get_workspace_by_index(i);
                if (isEmptyWorkspace(ws)) {
                    emptyWorkspaces.push(ws);
                }
            }
            if (emptyWorkspaces.length > 0) {
                let item = new PopupMenu.PopupMenuItem(_("Prune workspaces"));
                item.connect('activate', Lang.bind(this, function(actor, event){
                    emptyWorkspaces.forEach(function(ws) {
                        Main._removeWorkspace(ws);
                    });
                    this.refresh();
                }));
                items.push(new PopupMenu.PopupSeparatorMenuItem());
                items.push(item);
            }
        }

        if (Main.layoutManager.monitors.length > 1) {
            let monitorItems = [];
            Main.layoutManager.monitors.forEach(function(monitor, index) {
                if (selection.filter(function(mw) {return mw.get_monitor() != index;}).length) {
                    let item = new PopupMenu.PopupMenuItem(_("Move to monitor %d").format(index + 1));
                    item.connect('activate', Lang.bind(this, function() {
                        this._multiMoveMonitor(selection, index);
                    }));
                    monitorItems.push(item);
                }
            }, this);
            if (Main.layoutManager.monitors.length > 2) {
                let submenu = new PopupMenu.PopupSubMenuMenuItem(_("Monitor-move"));
                monitorItems.forEach(function(item) {
                    submenu.menu.addMenuItem(item);
                });
                monitorItems = [submenu];
            } else {
                monitorItems.unshift(new PopupMenu.PopupSeparatorMenuItem());
            }
            items = monitorItems.concat(items);
        }

        if (true) {
            let wsItems = [];
            for (let i = 0; i < global.screen.n_workspaces; ++i) {
                if (selection.filter(function(mw) {return !isOnWorkspaceIndex(mw, i);}).length) {
                    let item = new PopupMenu.PopupMenuItem(_("Move to %s").format(Main.getWorkspaceName(i)));
                    let index = i;
                    item.connect('activate', Lang.bind(this, function() {
                        selection.forEach(function(mw) {
                            if (!isOnWorkspaceIndex(mw, index)) {
                                changeWindowWorkspace(mw, global.screen.get_workspace_by_index(index));
                            }
                        });
                        // explicit refresh should technically only be needed in case we are unsticking a window,
                        // otherwise the handlers should kick in
                        this.refresh();
                    }));
                    wsItems.push(item);
                }
            }
            wsItems.push(new PopupMenu.PopupSeparatorMenuItem());

            if (selection.filter(function(mw) {return getWindowWorkspace(mw) != global.screen.get_active_workspace();}).length) {
                let item = new PopupMenu.PopupMenuItem(_("Move to current workspace"));
                item.connect('activate', Lang.bind(this, function() {
                    this._multiChangeToCurrentWorkspace(selection);
                }));
                wsItems.push(item);
            }

            if (selection.filter(function(mw) {return getWindowWorkspaceIndex(mw) >= 0;}).length) {
                let itemMoveToEmptyWorkspace = new PopupMenu.PopupMenuItem(_("Move to an empty workspace"));
                itemMoveToEmptyWorkspace.connect('activate', Lang.bind(this, function(actor, event) {
                    this._multiChangeToEmptyWorkspace(selection);
                }));
                wsItems.push(itemMoveToEmptyWorkspace);
            }

            if (selection.filter(function(mw) {return getWindowWorkspaceIndex(mw) >= 0;}).length) {
                let item = new PopupMenu.PopupMenuItem(_("Show on all workspaces"));
                item.connect('activate', Lang.bind(this, function(actor, event) {
                    selection.forEach(function(mw) {
                        mw.stick();
                    });
                    this.refresh();
                }));
                wsItems.push(item);
            }

            if (wsItems.length > 2) {
                let submenu = new PopupMenu.PopupSubMenuMenuItem(_("Workspace-move"));
                wsItems.forEach(function(item) {
                    submenu.menu.addMenuItem(item);
                });
                wsItems = [submenu];
            }
            items = wsItems.concat(items);
        }
        return items;
    },

    _modifySelection: function(insel, n, options) {
        if (n < 0) {
            return insel;
        }
        let selection = insel.filter(function(window) {return isValidWindow(window);} );
        let appIcon = this._appIcons[n];
        let index = selection.indexOf(appIcon.window);
        if (index < 0) {
            if (selection.length && options && options.mustExist) {
                return [];
            }
            if (!(options && options.noAdd)) {
                selection.push(appIcon.window);
            }
        } else if (options && options.removeIfPresent) {
            selection.splice(index, 1);
        }
        return selection;
    },

    _showContextMenu: function(show) {
        if (this._contextMenu) {
            this._contextMenu.close(); this._contextMenu = null;
            return;
        }
        if (!show) {return;}
        let mm = new PopupMenu.PopupMenuManager(this);
        let orientation = getVerticalAlignment() == 'top' ? St.Side.TOP : St.Side.BOTTOM;
        let menu = this._contextMenu = new Applet.AppletPopupMenu({actor: this._appSwitcher.actor}, orientation);
        mm.addMenu(menu);

        let item = new PopupMenu.PopupMenuItem(_("Help"));
        item.connect('activate', Lang.bind(this, this._showHelp));
        menu.addMenuItem(item);
        let item = new PopupMenu.PopupMenuItem(_("Settings"));
        item.connect('activate', Lang.bind(this, function() {
            Mainloop.idle_add(Lang.bind(this, function() {
                this.destroy();
                openSettings();
            }));
        }));
        menu.addMenuItem(item);

        let ct = Connector.connect(this.actor, 'destroy', Lang.bind(this, function() {
            this._showContextMenu(false);
        }));
        menu.connect('open-state-changed', Lang.bind(this, function(sender, opened) {
            this._menuActive = opened;
            if (!opened) {
                this._contextMenu = null;
                ct.disconnect();
                if (this.actor) {
                    global.stage.set_key_focus(this.actor);
                }
            }
        }));
        menu.open();
    },

    _showWindowContextMenu: function(n) {
        if (n < 0 && !g_selection.length) {
            return;
        }
        if (n >= 0) {
            if (g_selection.length && g_selection.indexOf(this._appIcons[n].window) < 0) {
                g_selection = [];
                this._select(n, true);
            }
        }
        let selection = g_selection.length ? g_selection : this._modifySelection(g_selection, n);
        if (n < 0 && !selection.length) {
            return;
        }
        let mm = new PopupMenu.PopupMenuManager(this);
        let orientation = getVerticalAlignment() == 'top' ? St.Side.TOP : St.Side.BOTTOM;
        let appIcon = this._appIcons[n >= 0 ? n : this._indexOfWindow(selection[selection.length - 1])];
        let menu = new Applet.AppletPopupMenu({actor: appIcon.actor}, orientation);
        menu._arrowAlignment = selection.length > 1 ? 1.0 : 0.0; // differentiate, give visual clue
        mm.addMenu(menu);

        let items = this._populateCommonWindowContextMenuItems(selection);

        items.forEach(function(item) {
            menu.addMenuItem(item);
        }, this);

        menu.connect('open-state-changed', Lang.bind(this, function(sender, opened) {
            this._menuActive = opened;
            if (!opened) {
                if (!this.actor) {return;}

                global.stage.set_key_focus(this.actor);
                // Make alt-tab stay on screen after the menu has been exited, provided that ALT is not held down.
                // This avoids unpleasant surprises after some actions, minimize in particular,
                // which might otherwise have no lasting effect if the minimized window is
                // immediately activated.
                let state = this._getModifierState();
                if (state == 0) {
                    this._persistent = true;
                }
            }
        }));
        menu.open();
    },

    _createAppswitcher: function(windows) {
        if (this._appSwitcher) {
            this._appSwitcher.actor.destroy();
        }
        this._appSwitcher = new AppSwitcher(windows, g_setup._showThumbnails, g_setup._iconsEnabled, this);
        this.actor.add_actor(this._appSwitcher.actor);
        if (!g_setup._iconsEnabled && !g_setup._thumbnailsEnabled) {
            this._appSwitcher.actor.hide();
        }
        this._appSwitcher.connect('item-activated', Lang.bind(this, this._appActivated));
        this._appSwitcher.connect('item-context-menu', Lang.bind(this, function(sender, n) {
            this._select(n);
            this._showWindowContextMenu(n);
        }));
        this._appSwitcher.connect('hover', Lang.bind(this, function(sender, index) {
            this._appSwitcher._noscroll = true;
            try {
                this._select(index);
            }
            finally {
                this._appSwitcher._noscroll = false;
            }
        }));
    },
    
    _getModifierState : function() {
        let [x, y, mods] = global.get_pointer();
        return mods & this._modifierMask;
    },

    show : function(backward, binding, mask) {
        if (!Main.pushModal(this.actor)) {
            this.destroy();
            return false;
        }
        this._haveModal = true;
        this._modifierMask = primaryModifier(mask);
        if (!this.refresh(binding, backward)) {
            this._finish();
            return false;
        }
        
        this.actor.connect('key-press-event', Lang.bind(this, this._keyPressReleaseEvent, KeyState.PRESSED));
        this.actor.connect('key-release-event', Lang.bind(this, this._keyPressReleaseEvent, KeyState.RELEASED));

        this.actor.connect('button-release-event', Lang.bind(this, this._clickedOutside));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScroll));
        return true;
    },

    _nextApp : function(nowrap) {
        return nowrap
            ? Math.min(this._currentApp + 1, this._appIcons.length - 1)
            : mod(this._currentApp + 1, this._appIcons.length);
    },
    _previousApp : function(nowrap) {
        return nowrap
            ? Math.max(this._currentApp - 1, 0)
            : mod(Math.max(-1, this._currentApp - 1), this._appIcons.length);
    },

    _toggleZoom : function() {
        this._zoomedOut = !this._zoomedOut;
        let numItems = this._zoomedOut ? this._appIcons.length : this._numPrimaryItems_Orig;
        if (numItems != this._numPrimaryItems) {
            this._numPrimaryItems = numItems;
            let current = this._currentApp; // save before re-creating the app switcher
            let windows = this._appIcons.map(function(appIcon) {return appIcon.window;});
            this._createAppswitcher(windows);
            if (current >= 0) {
                Mainloop.idle_add(Lang.bind(this, this._select, current)); // async refresh
            }
        }
    },

    _keyPressReleaseEvent : function(actor, event, keyState) {
        let released = keyState === KeyState.RELEASED;
        let pressed = keyState === KeyState.PRESSED;

        if (released) {
            let state = this._getModifierState();
            if (state == 0 && !this._persistent) {
                this._finish();
                return true;
            }
        }
        
        let findFirstWorkspaceWindow = Lang.bind(this, function(startIndex) {
            let wsCurIx = getWindowWorkspaceIndex(this._appIcons[startIndex].window);
            for (let i = startIndex; i >= 0; --i) {
                if (isOnWorkspaceIndex(this._appIcons[i].window, wsCurIx)) {
                    continue;
                }
                return i + 1;
             }
            return 0;
        });

        let skipWorkspace = Lang.bind(this, function(direction) {
            if (this._currentApp < 0) {
                return false;
            }
            let wsCurIx = getWindowWorkspaceIndex(this._appIcons[this._currentApp].window);
            if (direction > 0) {
                for (let [i, iLen] = [this._currentApp + 1, this._appIcons.length]; i < iLen; ++i) {
                    if (i == iLen - 1 || !isOnWorkspaceIndex(this._appIcons[i].window, wsCurIx)) {
                        this._select(i);
                        return true;
                    }
                }
            }
            if (direction < 0) {
                let ix = findFirstWorkspaceWindow(this._currentApp);
                if (ix == 0 || this._currentApp - ix > 0) {
                    this._select(ix);
                    return true;
                }
                this._select(findFirstWorkspaceWindow(ix - 1));
                return true;
            }
            return false;
        });

        let switchWorkspace = Lang.bind(this, function(direction) {
            if (g_settings["all-workspaces-mode"]) {
                return skipWorkspace(direction);
            }
            if (global.screen.n_workspaces < 2) {
                return false;
            }
            let current = global.screen.get_active_workspace_index();
            let nextIndex = (global.screen.n_workspaces + current + direction) % global.screen.n_workspaces;
            global.screen.get_workspace_by_index(nextIndex).activate(global.get_current_time());
            if (current == global.screen.get_active_workspace_index()) {
                return false;
            }
            Main.wm.showWorkspaceOSD();
            this.refresh();
            return true;
        });

        let keysym = event.get_key_symbol();
        let event_state = Cinnamon.get_event_state(event);
        let shiftDown = event_state & Clutter.ModifierType.SHIFT_MASK;
        let ctrlDown = event_state & Clutter.ModifierType.CONTROL_MASK;
        let altDown = event_state & Clutter.ModifierType.MOD1_MASK;
        let superDown = event_state & Clutter.ModifierType.MOD4_MASK;
        let action = global.display.get_keybinding_action(event.get_key_code(), event_state);
        const SCROLL_AMOUNT = 5;

        if (pressed) {
            if (!this._released) {
                // if the user doesn't relase the tab key for a while after the initial
                // invocation, we don't want to scroll in the list but stay on the initially
                // selected item.
                return true;
            }
            let now = new Date().getTime();
            let ms_diff =  now - (this.lastPressTs || 0);
            this.lastPressTs = now;
            let nowrap = ms_diff < 200;

            if (false) {
            } else if (ctrlDown && (keysym == Clutter.a || keysym == Clutter.A)) {
                if (g_selection.length) {
                    g_selection = [];
                } else {
                    g_selection = this._appIcons.map(function(icon) {
                        return icon.window;
                    });
                }
                this._minorRefresh();
            } else if (keysym == Clutter.Menu) {
                this._showWindowContextMenu(this._currentApp);
            } else if (keysym == Clutter.Escape) {
                this.destroy();
            } else if (keysym == Clutter.Tab) {
                this._select(this._nextApp(nowrap));
            } else if (keysym == Clutter.Alt_L  ) {
                if (!this._appletActivated) {
                    // This is to exit persistent mode after a menu has been open.
                    this._persistent = false;
                }
            } else if (keysym == Clutter.ISO_Left_Tab) {
                this._select(this._previousApp(nowrap));
            } else if (keysym == Clutter.Home || keysym == Clutter.KP_Home) {
                this._select(ctrlDown && this._homeWindow ? this._indexOfWindow(this._homeWindow) : Math.min(0, this._appIcons.length - 1));
            } else if (keysym == Clutter.End || keysym == Clutter.KP_End) {
                this._select(this._appIcons.length - 1);
            } else if (keysym == Clutter.Page_Down || keysym == Clutter.KP_Page_Down) {
                this._select(Math.min(this._appIcons.length - 1, this._currentApp + SCROLL_AMOUNT));
            } else if (keysym == Clutter.Page_Up || keysym == Clutter.KP_Page_Up) {
                this._select(Math.max(Math.min(0, this._appIcons.length - 1), this._currentApp - SCROLL_AMOUNT));
            } else if (keysym == Clutter.Return) {
                this._finish();
                return true;
            } else if (action == Meta.KeyBindingAction.PANEL_RUN_DIALOG) {
                this.destroy();
                if (this._currentApp >= 0) {
                    let window = this._appIcons[this._currentApp].window;
                    this._activateWindow(window);
                }
                Mainloop.idle_add(function() {
                    Main.getRunDialog().open();
                });
            } else if (action == Meta.KeyBindingAction.WORKSPACE_DOWN || action == Meta.KeyBindingAction.WORKSPACE_UP) {
                if (this._currentApp >= 0) {
                    let window = this._appIcons[this._currentApp].window;
                    this._activateWindow(window);
                }
                this.destroy();
                Mainloop.idle_add(function() {
                    (action == Meta.KeyBindingAction.WORKSPACE_DOWN ? Main.overview : Main.expo).show();
                });
            } else if (action == Meta.KeyBindingAction.SWITCH_GROUP || action == Meta.KeyBindingAction.SWITCH_WINDOWS) {
                this._select(shiftDown ? this._previousApp(nowrap) : this._nextApp(nowrap));
            } else {
                let removeOptions = {removeIfPresent: true, noAdd: true};
                if (keysym == Clutter.Left) {
                    if (superDown) {
                        this._multiMoveWorkspace(this._modifySelection(g_selection, this._currentApp, {mustExist: true}), -1);
                        return true;
                    }
                    if (ctrlDown && !shiftDown) {
                        if (switchWorkspace(-1)) {
                            return false;
                        }
                    } else if (shiftDown) {
                        g_selection = this._modifySelection(g_selection, this._currentApp, ctrlDown ? removeOptions : null);
                        g_selection = this._modifySelection(g_selection, this._previousApp(nowrap), ctrlDown ? removeOptions : null);
                    }    
                    this._select(this._previousApp(nowrap));
                }
                else if (keysym == Clutter.Right) {
                    if (superDown) {
                        this._multiMoveWorkspace(this._modifySelection(g_selection, this._currentApp, {mustExist: true}), 1);
                        return true;
                    }
                    if (ctrlDown && !shiftDown) {
                        if (switchWorkspace(1)) {
                            return false;
                        }
                    }
                    else if (shiftDown) {
                        g_selection = this._modifySelection(g_selection, this._currentApp, ctrlDown ? removeOptions : null);
                        g_selection = this._modifySelection(g_selection, this._nextApp(nowrap), ctrlDown ? removeOptions : null);
                    }
                    this._select(this._nextApp(nowrap));
                }
            }
            return true;
        }
        else if (released) {
            this._released = true;
            if (false) {
            } else if (keysym == Clutter.F1) {
                this._showHelp();
            } else if (keysym == Clutter.KEY_space) {
                if (superDown) {
                    g_selection = [this._selectedWindow];
                } else {
                    g_selection = this._modifySelection(g_selection, this._currentApp, {removeIfPresent: true});
                }
                this._minorRefresh();
            } else if (keysym == Clutter.z) {
                this._toggleZoom();
            } else if (keysym == Clutter.h) { // toggle hide
                if (this.opacity < 255) {
                    this.opacity = this._appSwitcher.actor.opacity = 255;
                }
                else {
                    this.opacity = this._appSwitcher.actor.opacity = 25;
                }
            } else if (keysym == Clutter.g && ctrlDown) {
                if (global.screen.n_workspaces > 1) {
                    g_vars.globalFocusOrder = !g_vars.globalFocusOrder;
                    if (g_vars.globalFocusOrder) {
                        g_settings["all-workspaces-mode"] = true; // enable together, but disable separately
                    }
                    this.refresh();
                }
            } else if (keysym == Clutter.KEY_period) {
                this._multiChangeToCurrentWorkspace(this._modifySelection(g_selection, this._currentApp, {mustExist: true}));
            } else if (keysym == Clutter.w && ctrlDown) {
                this._multiClose(this._modifySelection(g_selection, this._currentApp, {mustExist: true}));
            } else if (keysym == Clutter.i && ctrlDown) {
                this._multiIgnore(this._modifySelection(g_selection, this._currentApp, {mustExist: true}));
            } else if (keysym == Clutter.r && ctrlDown) {
                this._multiAssignHotkey(this._modifySelection(g_selection, this._currentApp, {mustExist: true}));
            } else if (keysym == Clutter.m && !ctrlDown) {
                this._multiMoveMonitor(this._modifySelection(g_selection, this._currentApp, {mustExist: true}));
                this._minorRefresh();
            } else if (keysym == Clutter.n && !ctrlDown) {
                this._multiMinimize(this._modifySelection(g_selection, this._currentApp, {mustExist: true}));
            } else if (keysym == Clutter.F4) {
                let index = g_alttabStyles.indexOf(g_settings["style"]);
                let newIndex = (index + 1 + g_alttabStyles.length) % g_alttabStyles.length;
                g_settings["style"] = g_alttabStyles[newIndex];
                processSwitcherStyle();
                this.refresh();
            } else if (keysym == Clutter.F5) {
                g_settings["all-workspaces-mode"] = !g_settings["all-workspaces-mode"];
                if (!g_settings["all-workspaces-mode"]) {
                    // must not have a hidden selection
                    g_selection = [];
                }
                this.refresh();
            } else if (keysym == Clutter.F6 && !shiftDown) {
                if (g_setup._iconsEnabled) {
                    let alignmentTypeIndex = g_aligmentTypes.indexOf(getVerticalAlignment());
                    let newIndex = (alignmentTypeIndex + 1 + g_aligmentTypes.length) % g_aligmentTypes.length;
                    g_settings["vertical-alignment"] = g_aligmentTypes[newIndex];
                    g_vAlignOverride = null;
                    this.refresh();
                }
            } else if (keysym == Clutter.F6 && shiftDown) {
                if (this._thumbnails) {
                    g_settings["full-screen-thumbnails"] = !g_settings["full-screen-thumbnails"];
                    this.refresh();
                }
            } else if (keysym == Clutter.F7) {
                if (g_setup._iconsEnabled && g_setup._thumbnailsEnabled) {
                    g_settings["display-thumbnail-headers"] = !g_settings["display-thumbnail-headers"];
                    this._minorRefresh();
                }
            } else if (keysym == Clutter.F8) {
                if (g_setup._iconsEnabled) {
                    g_settings["compact-labels"] = !g_settings["compact-labels"];
                    this.refresh();
                }
            } else if (keysym == Clutter.F9) {
                if (g_setup._iconsEnabled) {
                    let index = g_thumbnailIconOptions.indexOf(g_settings["thumbnails-behind-icons"]);
                    let newIndex = (index + 1 + g_thumbnailIconOptions.length) % g_thumbnailIconOptions.length;
                    g_settings["thumbnails-behind-icons"] = g_thumbnailIconOptions[newIndex];
                    this.refresh();
                }
            } else if (keysym == Clutter.F10 && shiftDown && !ctrlDown) {
                saveSettings();
            } else {
                let index = this._symbolToIndex(keysym);
                if (index >= 0 && index <= 10) {
                    if (ctrlDown) {
                        let nextIndex = (index == 0
                            ? global.screen.n_workspaces
                            : Math.min(index, global.screen.n_workspaces)
                            ) - 1;
                        if (nextIndex != global.screen.get_active_workspace_index()) {
                            global.screen.get_workspace_by_index(nextIndex).activate(global.get_current_time());
                            Main.wm.showWorkspaceOSD();
                            this.refresh();
                        }
                    } else if (!ctrlDown && !superDown) {
                        let window = g_hotKeyAssignment[index];
                        if (window) {
                            this._activateWindow(window);
                            this.destroy();
                        }
                    }
                }
            }
            return true;
        }
        
        return false;
    },

    _symbolToIndex : function(keysym) {
        let index = keysym - 48; // convert '0' to 0, etc
        if (index >= 0 && index <= 10) {
            return index;
        }
        let index = keysym - Clutter.KP_0; // convert Num-pad '0' to index 0, etc
        if (index >= 0 && index <= 10) {
            return index;
        }
        return -1;
    },

    _showHelp : function() {
        let dialog = new ModalDialog.ModalDialog();

        let label = new St.Label({text: _("Alt-Tab Quick Help (version %s)").format(g_version)});
        let bin = new St.Bin();
        bin.child = label;
        dialog.contentLayout.add(bin);
        HELP_TEXT.forEach(function(text) {
            let label = new St.Label({text: text});
            dialog.contentLayout.add(label);
        }, this);

        let altTab = this;
        dialog.setButtons([
            {
                label: _("Open Settings"),
                focused: false,
                action: function() {
                    altTab.destroy();
                    dialog.close();
                    openSettings();
                }
            },
            canSaveSettings() ? {
                label: _("Save current configuration"),
                focused: false,
                action: function() {
                    dialog.close();
                    saveSettings();
                }
            } : null,
            canSaveSettings() ? {
                label: _("Revert to saved configuration"),
                focused: false,
                action: function() {
                    dialog.close();
                    loadSettings();
                }
            } : null,
            {
                label: _("Close"),
                focused: true,
                action: function() {
                    dialog.close();
                }
            }
        ].filter(function(val) {return val != null;}));
        dialog.open();
    },

    _onScroll : function(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP) {
            this._select(this._previousApp(true));
        } else if (direction == Clutter.ScrollDirection.DOWN) {
            this._select(this._nextApp(true));
        }
    },

    _clickedOutside : function(actor, event) {
        if (!this._menuActive) {
            Mainloop.idle_add(Lang.bind(this, this.destroy));
        }
        return true;
    },

    _activateWindow : function(window) {
        let wsNow = global.screen.get_active_workspace();
        Main.activateWindow(window);
        if (window.get_workspace() != wsNow) {
            Main.wm.showWorkspaceOSD();
        }
    },

    _appActivated : function(sender, n) {
        // If the user clicks on the selected app, activate the
        // selected window; otherwise (e.g., they click on an app while
        // !mouseActive) activate the clicked-on app.
        this._activateWindow(this._appIcons[n].window);
        this.destroy();
    },

    _windowActivated : function(sender, window) {
        this._activateWindow(window);
        this.destroy();
    },

    _finish : function() {
        if (this._appIcons.length > 0 && this._currentApp > -1) {
            let app = this._appIcons[this._currentApp];
            this._activateWindow(app.window);
        }
        this.destroy();
    },

    _popModal: function() {
        if (this._haveModal) {
            Main.popModal(this.actor);
            this._haveModal = false;
        }
    },

    destroy : function() {
        if (this.actor) {
            this.actor.destroy();
            this.actor = null;
        }
    },

    _onDestroy : function() {
        setupWorkspaceListeners(null);
        this._popModal();

        if (this._motionTimeoutId)
            Mainloop.source_remove(this._motionTimeoutId);
        if (this._thumbnailTimeoutId)
            Mainloop.source_remove(this._thumbnailTimeoutId);
        if (this._displayPreviewTimeoutId)
            Mainloop.source_remove(this._displayPreviewTimeoutId);
        g_vAlignOverride = null;
        g_monitorOverride = null;
        g_selection = [];
    },
    
    _clearPreview: function() {
        if (this._previewClones) {
            this._previewClones.destroy();
            this._previewClones = null;
        }
    },
    
    _doWindowPreview: function() {
        if (!g_setup._previewEnabled || this._appIcons.length < 1 || this._currentApp < 0)
        {
            this._clearPreview();
            return;
        }

        let showPreview = function() {
            this._displayPreviewTimeoutId = null;
            if (!this._haveModal || this._currentApp < 0) {return;}

            this._setupBackground();
            let childBox = new Clutter.ActorBox();

            let window = this._appIcons[this._currentApp].window;
            let app = this._appIcons[this._currentApp].app;

            let previewClones = null;
            let [x1, y1] = [0, 0];
            if (!g_setup._previewThumbnails) {
                previewClones = new St.Group();
                this.actor.add_actor(previewClones);
                let clones = WindowUtils.createWindowClone(window, 0, 0, true, false);
                for (let i = 0; i < clones.length; i++) {
                    let clone = clones[i];
                    previewClones.add_actor(clone.actor);
                    let [width, height] = clone.actor.get_size();
                    childBox.x1 = clone.x;
                    childBox.x2 = clone.x + width;
                    childBox.y1 = clone.y;
                    childBox.y2 = clone.y + height;
                    clone.actor.allocate(childBox, 0);
                }
                [x1, y1] = [clones[0].x, clones[0].y];
            }
            else {
                let th = new ThumbnailHolder();
                previewClones = th.actor;
                this.actor.add_actor(previewClones);
                let r = window.get_compositor_private();
                childBox.x1 = r.x;
                childBox.x2 = r.x + r.width;
                childBox.y1 = r.y;
                childBox.y2 = r.y + r.height;
                previewClones.allocate(childBox, 0);
                th.addClones(window, app, false);
                [x1, y1] = [previewClones.x, previewClones.y];
            }

            previewClones.lower(this._appSwitcher.actor);
            if (window.minimized) {
                previewClones.opacity = 192;
            }
            const size = 64;
            let icon = app ? app.create_icon_texture(size) : null;
            if (icon) {
                previewClones.add_actor(icon);
                childBox.x1 = x1;
                childBox.x2 = x1 + size;
                childBox.y1 = y1;
                childBox.y2 = y1 + size;
                icon.allocate(childBox, 0);
            }

            this._clearPreview();
            this._previewClones = previewClones;
            this._previewClones.reactive = true;
            this._previewClones.connect('button-release-event', Lang.bind(this, function() {
                this._activateWindow(window);}
            ));
        }; // showPreview

        // Use a cancellable timeout to avoid flickering effect when tabbing rapidly through the set.
        if (this._displayPreviewTimeoutId) {
            Mainloop.source_remove(this._displayPreviewTimeoutId);
        }
        let delay = this._previewOnce ? PREVIEW_DELAY_TIMEOUT : PREVIEW_DELAY_TIMEOUT/2;
        this._displayPreviewTimeoutId = Mainloop.timeout_add(delay, Lang.bind(this, showPreview));
        this._previewOnce = true;
    },
    
    /**
     * _select:
     * @app: index of the app to select
     */
    _select : function(app, force) {
        let same = this._currentApp == app;
        if (same && !force) {
            return;
        }
        if (this._thumbnailTimeoutId) {
            Mainloop.source_remove(this._thumbnailTimeoutId);
            this._thumbnailTimeoutId = 0;
        }

        this._currentApp = app;
        if (this._currentApp >= 0) {
            this._selectedWindow = this._appIcons[this._currentApp].window;
        }
        if (this._appIcons.length < 1) {
            return;
        }

        this._appSwitcher.highlight(app);
        this._doWindowPreview();
        if (g_setup._thumbnailsEnabled && g_setup._iconsEnabled) {
            if (!same) {
                this._destroyThumbnails();
            }
            if (this._thumbnailTimeoutId) {
                Mainloop.source_remove(this._thumbnailTimeoutId);
            }
            this._thumbnailTimeoutId = Mainloop.timeout_add(
                this.thumbnailOnce ? PREVIEW_DELAY_TIMEOUT : PREVIEW_DELAY_TIMEOUT/2, Lang.bind(this, function() {
                    if (this._currentApp >= 0) { 
                        this._thumbnailTimeoutId = null;
                        this.thumbnailOnce = true;
                        this._createThumbnails();
                    }
            }));
        }
    },

    _setupBackground : function() {
        if (!this._dimmer) {
            let dimmer = this._dimmer = new St.Bin();
            dimmer.style = "background-color: rgba(0,0,0,%f)".format(g_settings["background-dim-factor"]);
            this.actor.add_actor(dimmer);
            dimmer.lower(this._appSwitcher.actor);
            dimmer.allocate(this.actor.allocation, 0);
        }

        if (!this._previewBackdrop) {                
            let backdrop = g_settings["background-image-enabled"] ? Meta.BackgroundActor.new_for_screen(global.screen) : null;
            if (backdrop) {
                this._previewBackdrop = backdrop;
                this.actor.add_actor(backdrop);
                backdrop.lower(this._dimmer);
            }
        }
    },

    _destroyThumbnails : function() {
        if (!this._thumbnails) {
            return;
        }
        if (!g_setup._thumbnailsEnabled) {
            this._thumbnails.actor.destroy();
            this._thumbnails = null;
            return;
        }
        this._thumbnails.addClones(null);
        this.thumbnailsVisible = false;
    },

    _createThumbnails : function() {
        if (!this._thumbnails) {
            this._setupBackground();
            this._thumbnails = new ThumbnailHolder();
            this._thumbnails.connect('item-activated', Lang.bind(this, this._windowActivated));
            this.actor.add_actor(this._thumbnails.actor);
            // Need to force an allocation so we can figure out the dimensions
            this._thumbnails.actor.get_allocation_box();
            this._thumbnails.actor.lower(this._appSwitcher.actor);
        }
        this._thumbnails.addClones(this._appIcons[this._currentApp].cachedWindows[0], this._appIcons[this._currentApp].app, true);
        this.thumbnailsVisible = true;
    }
};

function AppSwitcher() {
    this._init.apply(this, arguments);
}

AppSwitcher.prototype = {
    _init : function(windows, showThumbnails, showIcons, altTabPopup) {
        this.actor = new Cinnamon.GenericContainer({ style_class: 'switcher-list', reactive: true });
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocateTop));
        this.actor.connect('destroy', Lang.bind(this, function() {
            if (this._highlightTimeout) {Mainloop.source_remove(this._highlightTimeout);}
        }));
        this.actor.connect('button-release-event', Lang.bind(this, function(actor, event) {
            let pointerTracker = new PointerTracker.PointerTracker();
            let [x, y] = pointerTracker.getPosition();
            if (global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y) != this.actor) {
                return false;
            }
            if (event.get_button() < 3) {
                altTabPopup._showContextMenu(false);
                return false;
            }
            if (event.get_button() == 3) {
                altTabPopup._showContextMenu(true);
            }
            return true;
        }));

        // Here we use a GenericContainer so that we can force all the
        // children except the separator to have the same width.
        this._list = new Cinnamon.GenericContainer({ style_class: 'switcher-list-item-container' });
        this._list.spacing = 0;
        this._list.connect('style-changed', Lang.bind(this, function() {
            this._list.spacing = this._list.get_theme_node().get_length('spacing');
        }));

        this._list.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this._list.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this._list.connect('allocate', Lang.bind(this, this._allocate));

        this._label = new St.Label({text: Main.getWorkspaceName(global.screen.get_active_workspace_index())});
        this.actor.add_actor(this._label);

        this._clipBin = new St.Bin({style_class: 'cbin'});
        this._clipBin.child = this._list;
        this.actor.add_actor(this._clipBin);

        let pointerTracker = new PointerTracker.PointerTracker();
        this._leftGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-left', vertical: true, reactive: true});
        this._leftGradient.connect('enter-event', Lang.bind(this, function() {
            if (pointerTracker.hasMoved() && this._scrollableLeft && this._items.length) {
                Tweener.addTween(this._list, { anchor_x: 0,
                    time: POPUP_SCROLL_TIME,
                    transition: 'linear',
                    onComplete: this.determineScrolling,
                    onCompleteScope: this
                });
            }
        }));

        this._rightGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-right', vertical: true, reactive: true});
        this._rightGradient.connect('enter-event', Lang.bind(this, function() {
            if (pointerTracker.hasMoved() && this._scrollableRight && this._items.length) {
                let padding = this.actor.get_theme_node().get_horizontal_padding();
                let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
                let x = this._items[this._items.length - 1].allocation.x2 - g_myMonitor.width + padding + parentPadding;
                Tweener.addTween(this._list, { anchor_x: x,
                    time: POPUP_SCROLL_TIME,
                    transition: 'linear',
                    onComplete: this.determineScrolling,
                    onCompleteScope: this
                });
            }
        }));

        this._rightGradient.style = this._leftGradient.style = "border-radius: 0";
        this.actor.add_actor(this._leftGradient);
        this.actor.add_actor(this._rightGradient);

        // Those arrows indicate whether scrolling in one direction is possible
        this._leftArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                               pseudo_class: 'highlighted' });
        this._leftArrow.connect('repaint', Lang.bind(this,
            function() { _drawArrow(this._leftArrow, St.Side.LEFT); }));
        this._rightArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                                pseudo_class: 'highlighted' });
        this._rightArrow.connect('repaint', Lang.bind(this,
            function() { _drawArrow(this._rightArrow, St.Side.RIGHT); }));

        this.actor.add_actor(this._leftArrow);
        this.actor.add_actor(this._rightArrow);

        this._items = [];
        this._highlighted = -1;
        this._separators = [];
        this._minSize = 0;
        this._scrollableRight = true;
        this._scrollableLeft = false;

        // Construct the AppIcons, add to the popup
        let activeWorkspace = global.screen.get_active_workspace();
        let workspaceIcons = [];
        for (let i = 0; i < windows.length; i++) {
            let appIcon = new AppIcon(windows[i], showThumbnails, showIcons);
            // Cache the window list now; we don't handle dynamic changes here,
            // and we don't want to be continually retrieving it
            appIcon.cachedWindows = [windows[i]];
            workspaceIcons.push(appIcon);
        }

        let awMode = g_settings["all-workspaces-mode"];
        this.icons = [];
        let lastWsIndex = g_firstWorkspaceIndex;
        workspaceIcons.forEach(function(icon) {
            let wsIndex = getWindowWorkspaceIndex(icon.window);
            for (let i = wsIndex - lastWsIndex; awMode && i > 0; --i) {
                this.addSeparator();
                lastWsIndex = wsIndex;
            }
            this._addIcon(icon);
        }, this);
        for (let i = lastWsIndex + 1; awMode && i < global.screen.n_workspaces; ++i) {
            this.addSeparator();
        }
        this._label.visible = this.icons.length == 0;
        this._prevApp = this._curApp = -1;
        this._iconSize = 0;
        this._altTabPopup = altTabPopup;
        this._mouseTimeOutId = 0;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        if (this._items.length < 1) {
            alloc.min_size = alloc.natural_size = 32;
            return;
        }
        // using the current index may lead to sligthly varying heights when scrolling
        // using the current index + 1 leads to jumping when scrolling backwards
        let modelIndex = (this._curApp + this._items.length + 2) % this._items.length;

        // find the tallest item
        let labelNaturalHeight = 0;
        this.icons.forEach(function(appIcon) {labelNaturalHeight = Math.max(labelNaturalHeight, appIcon._label_bin.get_preferred_height(-1)[1]);});

        let themeNode = this._items[modelIndex].get_theme_node();
        let iconPadding = themeNode.get_horizontal_padding();
        let iconVPadding = themeNode.get_vertical_padding();
        let iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
        let iconSpacing = iconPadding + iconBorder;
        let totalSpacing = this._list.spacing * (this._items.length - 1);
        if (this._separators.length) {
           totalSpacing += Math.max(1, this._separators.length - 1) * (this._separators[0].width + this._list.spacing);
        }

        let primary = g_myMonitor;
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let availWidth = primary.width - parentPadding - this.actor.get_theme_node().get_horizontal_padding();

        for (let i =  0; i < iconSizes.length; i++) {
            this._iconSize = iconSizes[i];
            let w = totalSpacing;
            if (this._altTabPopup._numPrimaryItems != this.icons.length) {
                let width = this._iconSize + themeNode.get_horizontal_padding() + iconBorder;
                w += width * this._altTabPopup._numPrimaryItems;
            }
            else {
                for(let ii = 0; ii < this._altTabPopup._numPrimaryItems; ii++) {
                    w += this.icons[ii].calculateSlotSize(this._iconSize) + iconSpacing * 2;
                }
            }
            if (w <= availWidth) {
                break;
            }
        }   

        for(let i = 0; i < this.icons.length; i++) {
            if (this.icons[i].icon != null)
                break;
            this.icons[i].set_size(this._iconSize);
        }

        alloc.min_size = alloc.natural_size = this._iconSize + labelNaturalHeight + iconVPadding;
    },

    _getArrowDimensions: function() {
        let arrowHeight = Math.floor(this.actor.get_theme_node().get_padding(St.Side.BOTTOM) / 3);
        let arrowWidth = arrowHeight * 2;
        return [arrowWidth, arrowHeight];
    },

    _indicateItem: function(index, id, direction) {
        if (this[id]) {
            this[id].destroy();
            this[id] = 0;
        }
        if (index < 0) {
            return;
        }

        // First, find the tallest item in the list
        let height = 0;
        for (let i = 0; i < this._items.length; i++) {
            height = Math.max(height, this._items[i].allocation.y2 - this._items[i].allocation.y1);
        }
        if (height == 0) {
            return;
        }

        let arrow = this[id] = new St.DrawingArea({ style_class: 'switcher-arrow' });
        arrow.connect('repaint', Lang.bind(this, function() {
            _drawArrow(arrow, direction);
        }));
        this._list.add_actor(arrow);

        let childBox = new Clutter.ActorBox();
        let [arrowWidth, arrowHeight] = this._getArrowDimensions();
        let itemBox = this._items[index].allocation;

        childBox.x1 = Math.floor(itemBox.x1 + (itemBox.x2 - itemBox.x1 - arrowWidth) / 2);
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y1 = height + arrowHeight;
        childBox.y2 = childBox.y1 + arrowHeight;
        arrow.allocate(childBox, 0);
    },

    highlight : function(n) {
        if (this._prevApp != -1) {
            this.icons[this._prevApp].set_size(this._iconSize);
        }

        let prevIndex = this._highlighted;
        this.updateSelectionHighlight(n);
        this._highlighted = n;

        if (!this._noscroll) {
            // If previous index is negative, we are probably initializing, and we want
            // to show as many of the current workspace's windows as possible.
            let direction = prevIndex == -1 ? 1 : n - prevIndex;
            // If we're close to either the left or the right edge, we want to scroll
            // the edge-most items into view.
            let scrollMax = Math.min(this._noscroll ? 1 : 5, Math.floor(this._items.length/4));
            this._scrollTo(n, direction, scrollMax, prevIndex == -1);
        }
        else {
            this.determineScrolling();
        }

        this._prevApp = this._curApp = n;
 
        if (this._curApp != -1 && g_setup._iconsEnabled) {
            this.icons[this._curApp].set_size(this._iconSize, true);
        }
    },

    _removeIcon : function(index) {
        let icon = this.icons[index];
        this.icons.splice(index, 1);
        this._items[index].destroy();
        this._items.splice(index, 1);
        if (index < this._prevApp) {
            this._prevApp = this._prevApp - 1;
        }
        else if (index == this._prevApp) {
            this._prevApp = -1;
        }
        
        if (index < this._curApp) {
            this._highlighted = this._curApp = this._curApp - 1;
        }
        else if (index == this._curApp) {
            this._curApp = Math.min(this._curApp, this.icons.length - 1);
            this._highlighted = -1;
        }
        icon.actor.destroy();
    },

    _addIcon : function(appIcon) {
        this.icons.push(appIcon);
        this.addItem(appIcon.actor);
        appIcon._checkAttention();
    },

    _allocateTop: function(actor, box, flags) {
        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);

        let childBox = new Clutter.ActorBox();
        let scrollable = this._minSize > box.x2 - box.x1;
        this._clipBin.allocate(box, flags);

        let label_extra = 4;
        childBox.x1 = ((this.actor.allocation.x2 - this.actor.allocation.x1) - this._label.width - label_extra) / 2;
        childBox.x2 = childBox.x1 + this._label.width + label_extra;
        childBox.y1 = ((this.actor.allocation.y2 - this.actor.allocation.y1) - this._label.height - label_extra) / 2;
        childBox.y2 = childBox.y1 + this._label.height + label_extra;
        this._label.allocate(childBox, flags);

        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = this._leftGradient.width;
        childBox.y2 = this.actor.height;
        this._leftGradient.allocate(childBox, flags);
        this._leftGradient.opacity = 0;

        childBox.x1 = (this.actor.allocation.x2 - this.actor.allocation.x1) - this._rightGradient.width;
        childBox.y1 = 0;
        childBox.x2 = childBox.x1 + this._rightGradient.width;
        childBox.y2 = this.actor.height;
        this._rightGradient.allocate(childBox, flags);
        this._rightGradient.opacity = 0;

        let arrowWidth = Math.floor(leftPadding / 3);
        let arrowHeight = arrowWidth * 2;
        childBox.x1 = leftPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._leftArrow.allocate(childBox, flags);
        this._leftArrow.opacity = 0;

        arrowWidth = Math.floor(rightPadding / 3);
        arrowHeight = arrowWidth * 2;
        childBox.x1 = this.actor.width - rightPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._rightArrow.allocate(childBox, flags);
        this._rightArrow.opacity = 0;
        this.determineScrolling();
    },

    addItem : function(item, label) {
        let bbox = new St.Button({ style_class: 'item-box',
                                   reactive: true });
        bbox.set_child(item);
        this._list.add_actor(bbox);

        let n = this._items.length;
        bbox.connect('button-release-event', Lang.bind(this, function(actor, event) {
            let shiftDown = Cinnamon.get_event_state(event) & Clutter.ModifierType.SHIFT_MASK;
            let ctrlDown = Cinnamon.get_event_state(event) & Clutter.ModifierType.CONTROL_MASK;
            if (event.get_button()==1) {
                if (!ctrlDown && !shiftDown) {
                    this.emit('item-activated', n);
                } else if (ctrlDown && !shiftDown) {
                    g_selection = this._altTabPopup._modifySelection(g_selection, n, {removeIfPresent:true});
                    this.updateSelectionHighlight(n);
                } else if (!ctrlDown && shiftDown) {
                    let num = Math.abs(n - this._curApp) + 1;
                    let start = Math.min(n, this._curApp);
                    for (let i = 0; i < num; ++i) {
                        g_selection = this._altTabPopup._modifySelection(g_selection, start + i);
                    }
                    if (num) {
                        this._altTabPopup._select(n, true);
                    }
                }
            }
            if (event.get_button()==3) {
                this.emit('item-context-menu', n);
            }
        }));

        this._hoverTimeout = null;
        // There may occur spurious motion events, so use a pointer tracker to verify that the pointer has moved.
        // The detection is not completely fail-safe, due to the effects of scrolling, but it is better than nothing.
        let pointerTracker = new PointerTracker.PointerTracker();
        bbox.connect('enter-event', Lang.bind(this, function(actor, event) {
            let [x, y, mods] = global.get_pointer();
            let shiftDown = mods & Clutter.ModifierType.SHIFT_MASK;
            if (pointerTracker.hasMoved() && !shiftDown) {
                if (this._hoverTimeout) {
                    Mainloop.source_remove(this._hoverTimeout);
                }
                this._hoverTimeout = Mainloop.timeout_add(125, Lang.bind(this, function() {
                    this._hoverTimeout = null;
                    this.emit('hover', n);
                }));
            }
        }));
        bbox.connect('leave-event', Lang.bind(this, function() {
            if (pointerTracker.hasMoved()) {
                if (this._hoverTimeout) {
                    Mainloop.source_remove(this._hoverTimeout);
                    this._hoverTimeout = null;
                }
            }
        }));
        this._items.push(bbox);
    },

    addSeparator: function () {
        if (!g_vars.globalFocusOrder) {
            let box = new St.Bin({ style_class: 'separatore' });
            this._separators.push(box);
            this._list.add_actor(box);
        }
    },

    updateSelectionHighlight: function(index) {
        this._items.forEach(function(item, i) {
            let outliner = this.icons[i].actor;
            if (i == this._highlighted) {
                item.remove_style_pseudo_class('selected');
            }
            if (g_selection.indexOf(this.icons[i].window) < 0) {
                outliner.remove_style_pseudo_class('outlined');
            } else {
                outliner.add_style_pseudo_class('outlined');
            }
            if (i == index) {
                item.add_style_pseudo_class('selected');
            }
            this.icons[i].updateLabel();
        }, this);
    },

    _getStagePosX: function(theme_node, actor, offset) {
        let [absItemX, absItemY] = actor.get_transformed_position();
        let padding = theme_node.get_horizontal_padding() / 2;
        let [result, posX, posY] = this.actor.transform_stage_point(absItemX, 0);
        return Math.round(posX + (padding + actor.width) * (offset || 0));
    },

    determineScrolling: function() {
        if (!this._items.length) {
            return;
        }
        let theme_node = this.actor.get_stage() ? this.actor.get_theme_node() : null;
        if (!theme_node) {return;}

        let [containerWidth, containerHeight] = this.actor.get_transformed_size();
        let padding = theme_node.get_horizontal_padding();

        let rightX = this._getStagePosX(theme_node, this._items[this._items.length - 1], 0.5);
        let rightX2 = this._getStagePosX(theme_node, this._items[this._items.length - 1], 1);
        let leftX = this._getStagePosX(theme_node, this._items[0], 0.7);
        let leftX2 = this._getStagePosX(theme_node, this._items[0], 0);
        let scrollableLeft = leftX < padding/2;
        let scrollableLeft2 = leftX2 < padding/2;
        let scrollableRight = rightX > containerWidth;
        let scrollableRight2 = rightX2 > containerWidth;

        this._scrollableLeft = scrollableLeft2;
        this._leftArrow.opacity = this._leftGradient.opacity = scrollableLeft ? 255 : 0;
        this._leftGradient.reactive = scrollableLeft;
        this._scrollableRight = scrollableRight2;
        this._rightArrow.opacity = this._rightGradient.opacity = scrollableRight ? 255: 0;
        this._rightGradient.reactive = scrollableRight;
        Mainloop.idle_add(Lang.bind(this, function() {
            if (!this._clipBin.get_stage()) {return;}
            if (this._scrollableLeft){
                this._clipBin.lower(this._leftGradient);
            }
            else {
                this._leftGradient.lower(this._clipBin);
            }
            if (this._scrollableRight){
                this._clipBin.lower(this._rightGradient);
            }
            else {
                this._rightGradient.lower(this._clipBin);
            }
        }));
    },

    _scrollTo: function(index, direction, scrollMax_, fast) {        
        let theme_node = this.actor.get_stage() ? this.actor.get_theme_node() : null;
        if (!theme_node) {return;}

        let scrollMax = scrollMax_ ? scrollMax_ : 1;
        let ixScroll = direction > 0 ?
            Math.min(index + scrollMax, this._items.length - 1) : // right
            Math.max(index - scrollMax, 0); // left

        let posX = this._getStagePosX(theme_node, this._items[ixScroll]);
        let [containerWidth, containerHeight] = this.actor.get_transformed_size();
        
        let padding = theme_node.get_horizontal_padding();

        let delay = fast ? 0 : 250;
        let scrollit = Lang.bind(this, function(x) {
            if (this._highlightTimeout3) {
                Mainloop.source_remove(this._highlightTimeout3);
            }
            this._highlightTimeout3 = Mainloop.timeout_add(delay, Lang.bind(this, function() {
                Tweener.addTween(this._list, { anchor_x: x,
                    time: fast ? 0 : POPUP_SCROLL_TIME,
                    transition: 'linear',
                    onComplete: this.determineScrolling,
                    onCompleteScope: this
                });
            }));
        });

        if (direction > 0) {
            let theme_node = this._items[ixScroll].get_theme_node();
            let itemPadding = theme_node.get_horizontal_padding() / 2;
            if (posX + this._items[ixScroll].get_width() + itemPadding >= containerWidth) {
                Tweener.removeTweens(this._list);
                let monitor = g_myMonitor;
                let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
                let x = this._items[ixScroll].allocation.x2 + itemPadding - monitor.width + padding + parentPadding;
                scrollit(x);
            }
        }
        else if (direction < 0) {
            if (posX <= padding) {
                Tweener.removeTweens(this._list);
                let x = (ixScroll == 0 ? this._list.get_children() : this._items)[ixScroll].allocation.x1;
                scrollit(x);
            }
        }
    },

    _maxChildWidth: function (forHeight) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);
        }

        return [maxChildMin, maxChildNat];
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        let separatorWidth = 0;
        if (this._separators.length) {
            let [sepMin, sepNat] = this._separators[0].get_preferred_width(forHeight);
            separatorWidth = this._separators.length * (sepNat + this._list.spacing);
        }

        let totalSpacing = this._list.spacing * Math.max(1, (this._items.length - 1));
        let accItemWidth = 0;
        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            accItemWidth += childMin;
        }
        alloc.min_size = accItemWidth + separatorWidth + totalSpacing;
        alloc.natural_size = alloc.min_size;
        this._minSize = alloc.min_size;
    },

    _allocate: function (actor, box, flags) {
        let childHeight = box.y2 - box.y1;
        let totalSpacing = this._list.spacing * (this._items.length - 1);
        let separatorWidth = 0;
        if (this._separators.length) {
            let [sepMin, sepNat] = this._separators[0].get_preferred_width(childHeight);
            separatorWidth = sepNat;
            totalSpacing += this._separators.length * this._list.spacing;
        }

        let x = 0;
        let children = this._list.get_children();
        let childBox = new Clutter.ActorBox();

        for (let i = 0; i < children.length; i++) {
            if (this._items.indexOf(children[i]) != -1) {
                let [width, height] = children[i].get_size();
                childBox.x1 = x;
                childBox.y1 = 0;
                childBox.x2 = x + width;
                childBox.y2 = childBox.y1 + childHeight;
                children[i].allocate(childBox, flags);

                x += this._list.spacing + width;
            } else if (this._separators.indexOf(children[i]) != -1) {
                // We want the separator to be more compact than the rest.
                childBox.x1 = x;
                childBox.y1 = 0;
                childBox.x2 = x + separatorWidth;
                childBox.y2 = childHeight;
                children[i].allocate(childBox, flags);
                x += this._list.spacing + separatorWidth;
            } else {
                // Something else, eg, AppSwitcher's arrows;
                // we don't allocate it.
            }
        }

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let topPadding = this.actor.get_theme_node().get_padding(St.Side.TOP);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);

        // Clip the area for scrolling
        this._clipBin.set_clip(0, -topPadding, (this.actor.allocation.x2 - this.actor.allocation.x1) - leftPadding - rightPadding, this.actor.height + bottomPadding);
    }
};
Signals.addSignalMethods(AppSwitcher.prototype);

// -------------------------------------------------------------------------------------------

function AppIcon() {
    this._init.apply(this, arguments);
}

AppIcon.prototype = {
    _init: function(window, showThumbnail, showIcons) {
        this.window = window;
        this.showThumbnail = showThumbnail;
        this.showIcons = showIcons;
        this.app = g_windowTracker.get_window_app(window);
        this.actor = new St.BoxLayout({ style_class: 'alt-tab-app',
                                         vertical: true, y_align: St.Align.START });
        this.icon = null;

        this._iconBin = new St.Bin({style_class: 'icon-bin'});
        this.actor.add(this._iconBin, { x_fill: false, y_fill: false, y_align: St.Align.END } );

        this.label = new St.Label();
        this.label.clutter_text.line_wrap = true;
        this._label_bin = new St.Bin({ x_align: St.Align.MIDDLE, y_align: St.Align.START });
        this._label_bin.add_actor(this.label);
        this.actor.add(this._label_bin);

        this.wsLabel = new St.Label();
        this._wsLabel_bin = new St.Bin({ x_align: St.Align.MIDDLE, y_align: St.Align.START });
        this._wsLabel_bin.add_actor(this.wsLabel);
        this.actor.add(this._wsLabel_bin);
    },

    _checkAttention: function() {
        let bbox = this._iconBin;
        let is_urgent = this.window.is_demanding_attention() || this.window.is_urgent();

        if (is_urgent && !bbox.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
            bbox.add_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
        }
        else if (!is_urgent && bbox.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
            bbox.remove_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
        }
    },

    updateLabel: function() {
        if (this.wsLabel.visible) {
            let ws = getWindowWorkspaceIndex(this.window);
            this.wsLabel.set_text("[" + (ws + 1) + "]");
        }

        let title = this.window.get_title();
        title = typeof(title) != 'undefined' ? title : (this.app ? this.app.get_name() : "");
        let hotkey = this.window._alttab_hotkey ? (this.window._alttab_hotkey.index) + ": " : "";
        this.label.set_text(hotkey + (title.length && this.window.minimized ? "[" + title + "]" : title));
    },

    calculateSlotSize: function(sizeIn) {
        return sizeIn;
    },

    calculateIconSize: function(sizeIn) {
        // Icons are sized smaller if they don't belong to the active workspace
        return isOnWorkspaceIndex(this.window, g_activeWsIndex) ? sizeIn : Math.floor(sizeIn * 3 / 4);
    },

    set_size: function(sizeIn, focused) {
        this._initLabelHeight = this._initLabelHeight || this._label_bin.height;
        if (this.icon) {return;}
        this.icon = new St.Group();
        let size = this.calculateIconSize(sizeIn);
        if (!this.showIcons || (
            (g_settings["thumbnails-behind-icons"] == 'behind-identical' && this.app && this.app.get_windows().length > 1)
            || g_settings["thumbnails-behind-icons"] == 'always') )
        {
            if (this._clone_timeoutId) {
                Mainloop.source_remove(this._clone_timeoutId);
            }
            this._clone_timeoutId = Mainloop.timeout_add(focused ? 0 : 25, Lang.bind(this, function() {
                this._clone_timeoutId = 0;
                let thumbnail = new St.Group();
                this.icon.add_actor(thumbnail);
                let scale = size/Math.max(global.screen_width, global.screen_height);
                Main.layoutManager.monitors.forEach(function(monitor, mindex) { 
                    let frame = new St.Group({x: monitor.x*scale, y: monitor.y*scale + sizeIn - size, width: monitor.width*scale, height: monitor.height*scale, style: "border: 1px rgba(127,127,127,1)"});
                    thumbnail.add_actor(frame);
                }, this);
                let monitor = Main.layoutManager.monitors[this.window.get_monitor()];
                let clones = WindowUtils.createWindowClone(this.window, 0, 0, true, false);
                for (i in clones) {
                    let clone = clones[i];
                    thumbnail.add_actor(clone.actor);
                    clone.actor.set_position(clone.x*scale, sizeIn - size + clone.y*scale);
                    clone.actor.set_scale(scale, scale);
                }
                if (this.showIcons) {
                    let isize = Math.min(MAX_ICON_SIZE, Math.max(Math.ceil(size * 3/4), iconSizes[iconSizes.length - 1]));
                    let icon = createApplicationIcon(this.app, isize);
                    thumbnail.add_actor(icon);
                    icon.set_position(Math.floor((sizeIn - isize)/1), size - isize);
                }
                if (this.hkLabel) {
                    thumbnail.lower(this.hkLabel);
                }
            }));
        }
        else {
            let icon = createApplicationIcon(this.app, size);
            this.icon.add_actor(icon);
            icon.set_position(Math.floor((sizeIn - size)/2), 0);
        }
        if (this.window._alttab_hotkey) {
            let sizeQuarter = Math.floor(size/4);
            let label = this.hkLabel = new St.Label({x: 0, y: sizeIn - (sizeQuarter*5), width: size, height: sizeIn, text: this.window._alttab_hotkey.index.toString()});
            label.style = "font-size:" + (sizeQuarter*2) + "px; color: rgb(255,144,144)";
            this.icon.add_actor(label);
        }

        // Make some room for the window title.
        this._label_bin.width = size;
        this._label_bin.height = !g_settings["compact-labels"] ? Math.max(this._initLabelHeight * 2, Math.floor(size/2)) : this._initLabelHeight;
        if (this.window._alttab_ignored) {
            this.icon.opacity = 170;
        }
        this._iconBin.child = this.icon;
        this._iconBin.set_size(sizeIn, size);
        if (g_vars.globalFocusOrder) {
            this.wsLabel.show();
        }
        else {
            this.wsLabel.hide();
            this.wsLabel.height = 0;
        }
    }
};

// -------------------------------------------------------------------------------------------

function ThumbnailHolder() {
    this._init.apply(this, arguments);
}

ThumbnailHolder.prototype = {
    _init : function() {
        this.headerPadding = 4;
        this.actor = new St.Group({ style_class: 'switcher-list', style: 'padding: 4px;', reactive: true });
        let layout = this.layout = new St.BoxLayout({vertical: true, y_align: St.Align.START });
        this.actor.add_actor(layout);
        let header = this.header = new St.BoxLayout({vertical: false});
        layout.add(header, { x_fill: false, y_fill: false, y_align: St.Align.END });
        this.containerHolder = new St.Group();
        this.layout.add(this.containerHolder, { x_fill: false, y_fill: false, y_align: St.Align.END });
        this.actor.connect('button-press-event', Lang.bind(this, function() {this.emit('item-activated', this._window); }));
    },

    addClones : function (window, app, doScale) {
        this._window = window;
        let old_container = this.container;
        this.container = null;
        if (this.header) {
            this.header.destroy_children();
        }
        if (window) {
            let windowMonitorIndex = window.get_monitor();
            this.container = new St.Group();
            this.containerHolder.add_actor(this.container);
            this.container.opacity = 0;
            let headerHeight = 0;
            let displayHeaders = doScale && g_settings["display-thumbnail-headers"];
            this.header.style = 'padding-top: ' + (displayHeaders ? this.headerPadding : 0) + 'px';

            let hPadding = this.actor.get_theme_node().get_horizontal_padding();
            let vBorder = this.actor.get_theme_node().get_border_width(St.Side.TOP) * 2;
            let vPadding = (this.actor.get_theme_node().get_vertical_padding() + this.headerPadding) * 1;
            let binWidth = this.actor.allocation.x2 - this.actor.allocation.x1 - hPadding;
            if (displayHeaders) {
                headerHeight = 32;
                let bin = new St.Group();
                bin.add_actor(createApplicationIcon(app, headerHeight));
                this.header.add(bin, { x_fill: false, y_fill: false, y_align: St.Align.START });
                let label = new St.BoxLayout({vertical: true});
                this.header.add(label, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
                let header_width = this.header.width;
                let title = new St.Label({text: window.title});
                label.add(title, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
                title.width = Math.min(title.width, binWidth - header_width);

                let label2strings = [];
                if (global.screen.n_workspaces > 1) {
                    label2strings.push("[" + Main.getWorkspaceName(getWindowWorkspace(window).index()) + "]");
                }
                if (windowMonitorIndex != g_myMonitorIndex) {
                    label2strings.push("(Monitor " + (windowMonitorIndex + 1) + ")");
                }
                if (label2strings.length) {
                    let label2 = new St.Label({text: label2strings.join(" ")});
                    label.add(label2, { x_fill: false, y_fill: false, y_align: St.Align.MIDDLE });
                }
            }
            let binHeight = this.actor.allocation.y2 - this.actor.allocation.y1 - headerHeight - vPadding - vBorder;
            this.container.set_size(binWidth, binHeight);

            let clones = WindowUtils.createWindowClone(window, 0, 0, true, false);
            let windowMonitor = Main.layoutManager.monitors[windowMonitorIndex];
            let scaleY = doScale ? binHeight/windowMonitor.height : binHeight/clones[0].actor.height;
            let scaleX = doScale ? binWidth/windowMonitor.width : binWidth/clones[0].actor.width;
            let scale = Math.min(1, scaleX, scaleY);

            for (let j = 0; j < clones.length; j++) {
                let clone = clones[j];
                this.container.add_actor(clone.actor);

                let childBox = new Clutter.ActorBox();
                childBox.x1 = Math.floor((hPadding + binWidth-clone.actor.width*scale)/2);
                childBox.y1 = Math.floor(doScale ? vPadding/2 : (vPadding + binHeight-clone.actor.height*scale)/2);
                childBox.x2 = childBox.x1 + clone.actor.width;
                childBox.y2 = childBox.y1 + clone.actor.height;
                clone.actor.allocate(childBox, 0);
                clone.actor.set_scale(scale, scale);
            }
            if (doScale) {
                Tweener.addTween(this.container, { opacity: 255,
                    time: THUMBNAIL_FADE_TIME * 3,
                    transition: 'easeOutQuad'
                });
            }
            else {
                this.container.opacity = 255;
            }
        }

        if (old_container) {
            if (window) {
                Tweener.addTween(old_container, {
                    opacity: 0,
                    time: THUMBNAIL_FADE_TIME * 3,
                    transition: 'easeOutQuad',
                    onComplete: Lang.bind(old_container, old_container.destroy)
                });
            }
            else {
                old_container.destroy();
            }
        }
    }
};
Signals.addSignalMethods(ThumbnailHolder.prototype);

// -------------------------------------------------------------------------------------------

function _drawArrow(area, side) {
    let themeNode = area.get_theme_node();
    let borderColor = themeNode.get_border_color(side);
    let bodyColor = themeNode.get_foreground_color();

    let [width, height] = area.get_surface_size ();
    let cr = area.get_context();

    cr.setLineWidth(1.0);
    Clutter.cairo_set_source_color(cr, borderColor);

    switch (side) {
    case St.Side.TOP:
        cr.moveTo(0, height);
        cr.lineTo(Math.floor(width * 0.5), 0);
        cr.lineTo(width, height);
        break;

    case St.Side.BOTTOM:
        cr.moveTo(width, 0);
        cr.lineTo(Math.floor(width * 0.5), height);
        cr.lineTo(0, 0);
        break;

    case St.Side.LEFT:
        cr.moveTo(width, height);
        cr.lineTo(0, Math.floor(height * 0.5));
        cr.lineTo(width, 0);
        break;

    case St.Side.RIGHT:
        cr.moveTo(0, 0);
        cr.lineTo(width, Math.floor(height * 0.5));
        cr.lineTo(0, height);
        break;
    }

    cr.strokePreserve();

    Clutter.cairo_set_source_color(cr, bodyColor);
    cr.fill();
}

// -------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------

var g_settings_obj;
var g_instanceId;

function init(metadata, instanceId) {
    imports.searchPath.push(metadata.path);
    Connector = imports.connector;
    g_attentionConnector = new Connector.Connector();

    g_uuid = metadata['uuid'];
    g_instanceId = instanceId;
    let version = metadata['version'];
    g_version = version ? '"' + version + '"' : "unknown";
}

function initSettings() {
    if (Settings) {
        let settings = g_settings_obj = (g_instanceId
            ? new Settings.AppletSettings(g_settings, g_uuid, g_instanceId)
            : new Settings.ExtensionSettings(g_settings, g_uuid));

        settings.bindProperty(Settings.BindingDirection.IN,
            "style",
            "style",
            processSwitcherStyle,
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "thumbnails-behind-icons",
            "thumbnails-behind-icons",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "all-workspaces-mode",
            "all-workspaces-mode",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "vertical-alignment",
            "vertical-alignment",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "display-thumbnail-headers",
            "display-thumbnail-headers",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "display-origin-arrow",
            "display-origin-arrow",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "compact-labels",
            "compact-labels",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "preferred-monitor",
            "preferred-monitor",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "full-screen-thumbnails",
            "full-screen-thumbnails",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "zoom-on",
            "zoom-on",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "background-image-enabled",
            "background-image-enabled",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "background-dim-factor",
            "background-dim-factor",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "urgent-notifications",
            "urgent-notifications",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "force-open-on-preferred-monitor",
            "force-open-on-preferred-monitor",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.IN,
            "hide-icon",
            "hide-icon",
            handleHideIcon,
            null);
    }
    else {
        // if we don't have local settings support, we must hard-code our preferences
        g_settings["thumbnails-behind-icons"] = "behind-identical";
        g_settings["all-workspaces-mode"] = false;
        g_settings["vertical-alignment"] = 'center';
        g_settings["full-screen-thumbnails"] = false;
        g_settings["display-thumbnail-headers"] = true;
        g_settings["display-origin-arrow"] = true;
        g_settings["compact-labels"] = false;
        g_settings["zoom-on"] = true;
        g_settings["preferred-monitor"] = ":primary";
        g_settings["background-image-enabled"] = true;
        g_settings["background-dim-factor"] = 0.7;
        g_settings["urgent-notifications"] = true;
        g_settings["force-open-on-preferred-monitor"] = false;
    }

    getSwitcherStyle();
}

function canSaveSettings() {
    let dirty = false;
    let count = 0;
    for (let setting in g_settings) {
        ++count;
        dirty = dirty || g_settings_obj.getValue(setting) !== g_settings[setting];
    }
    return count && dirty;
}

function saveSettings() {
    for (let setting in g_settings) {
        if (g_settings_obj.getValue(setting) !== g_settings[setting]) {
            g_settings_obj.setValue(setting, g_settings[setting]);
            global.log("saved setting: '" + setting + "', value: '" +  g_settings[setting] + "'");
        }
    }
}

function loadSettings() {
    for (let setting in g_settings) {
        let newValue = g_settings_obj.getValue(setting);
        if (g_settings[setting] !== newValue) {
            g_settings[setting] = newValue;
            global.log("loaded setting: '" + setting + "', value: '" +  g_settings[setting] + "'");
            if (setting == "style") {
                processSwitcherStyle();
            }
        }
    }
}

var g_attentionConnector;
function enable() {
    initSettings();

    let handler = function(display, screen, window, binding) {
        let tabPopup = new AltTabPopup();
        let modifiers = binding.get_modifiers();
        let backwards = modifiers & Meta.VirtualModifier.SHIFT_MASK;
        tabPopup.show(backwards, binding.get_name(), binding.get_mask());
    };

    Meta.keybindings_set_custom_handler('switch-windows', handler);
    Meta.keybindings_set_custom_handler('switch-group', handler);

    g_attentionConnector.addConnection(global.display, 'window-demands-attention', Lang.bind(null, _onWindowDemandsAttention, false));
    g_attentionConnector.addConnection(global.display, 'window-marked-urgent', Lang.bind(null, _onWindowDemandsAttention, true));
    g_attentionConnector.addConnection(global.window_manager, 'map', function(cinnamonwm, actor) {
        if (Main.layoutManager.monitors.length < 2) {
            return;
        }
        let window = actor.get_meta_window();
        let parent = window.get_transient_for();
        if (parent) {
            if (window.get_monitor() != parent.get_monitor()) {
                global.log("Alt-Tab Enhanced: moving transient window '%s' from monitor %d to monitor %d (same as parent window)".format(window.title, window.get_monitor() + 1, parent.get_monitor() + 1));
                window.move_to_monitor(parent.get_monitor());
            }
            return;
        }
        if (!g_settings["force-open-on-preferred-monitor"]) {
            return;
        }
        if (window.get_window_type() < Meta.WindowType.DROPDOWN_MENU && !window._alttab_open_seen) {
            window._alttab_open_seen = true;
            // let myMonitorIndex = Main.layoutManager.primaryIndex;
            let [myMonitorIndex] = selectMonitor(false);
            if (isValidWindow(window) && window.get_monitor() != myMonitorIndex) {
                global.log("Alt-Tab Enhanced: moving window '%s' from monitor %d to monitor %d".format(window.title, window.get_monitor() + 1, myMonitorIndex + 1));
                window.move_to_monitor(myMonitorIndex); // first attempt, may be counteracted by other parties
            }
            let count = 0;
            let timerFunction = function() {
                ++count;
                if (isValidWindow(window) && window.get_monitor() != myMonitorIndex) {
                    global.log("Alt-Tab Enhanced: moving window '%s' from monitor %d to monitor %d (attempt %d)".format(window.title, window.get_monitor() + 1, myMonitorIndex + 1, count));
                    window.move_to_monitor(myMonitorIndex);
                    window.foreach_transient(function(transient) {
                        transient.move_to_monitor(myMonitorIndex);
                    });
                }
                if (count < 3) {
                    Mainloop.timeout_add(500, timerFunction);
                }
            };
            Mainloop.timeout_add(500, timerFunction);
        }
    });

}

function disable() {
    Meta.keybindings_set_custom_handler('switch-windows', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    Meta.keybindings_set_custom_handler('switch-group', Lang.bind(Main.wm, Main.wm._startAppSwitcher));
    g_attentionConnector.destroy();
    g_settings_obj.finalize();
}

let g_applet = null;
let g_urgentCount = 0;

// ----------------------------------
function _onWindowDemandsAttention(display, window, urgent) {
    if (window.get_window_type() == Meta.WindowType.DESKTOP) {
        // this seems to happen after monitor setups has changed
        return;
    }
    if (window._mtSource) {
        return;
    }
    let notification = {destroy: function() {}, connect: function () {} };
    let button = null;

    if (g_settings["urgent-notifications"] && Main.messageTray) {
        let source = window._mtSource = new MessageTray.Source(window.title);
        window._mtSource.connect('destroy', Lang.bind(this, function() {
            delete window._mtSource;
        }));
        Main.messageTray.add(source);

        let wsIndex = getWindowWorkspace(window).index();
        let wsText = (wsIndex != global.screen.get_active_workspace_index()) ?
            _(" on workspace %s").format(Main.getWorkspaceName(wsIndex)) :
            "";
        let reason = urgent ?
            _("Window marked urgent") :
            _("Window demanding attention");
        let text = reason + wsText;
        let tracker = Cinnamon.WindowTracker.get_default();
        const size = 64;

        let icon = new St.Group();
        let clones = WindowUtils.createWindowClone(window, size, size, true, true);
        for (i in clones) {
            let clone = clones[i];
            icon.add_actor(clone.actor);
            clone.actor.set_position(clone.x, clone.y);
        }
        let [width, height] = clones[0].actor.get_size();
        clones[0].actor.set_position(Math.floor((size - width)/2), 0);

        let app = tracker.get_window_app(window);
        let isize = Math.ceil(size*(3/4));
        let icon2 = app ? app.create_icon_texture(isize) : null;
        if (icon2) {
            icon.add_actor(icon2);
            icon2.set_position(Math.floor((size - isize)/2), size - isize);
        }
        notification = new MessageTray.Notification(source, window.title, text,
                                                            { icon: icon });
        // CRITICAL makes the notification stay up until closed.
        // HIGH urgency makes the notification go away after a while, possibly ending up in the message tray.
        let urgency = AppletManager.get_role_provider_exists(AppletManager.Roles.NOTIFICATIONS)
            ? MessageTray.Urgency.HIGH
            : MessageTray.Urgency.CRITICAL;
        notification.setUrgency(urgency);
        notification.setTransient(true);
        button = new St.Button({ can_focus: true, label: _("Ignore") });
        button.add_style_class_name('notification-button');
        notification.addActor(button);
        source.notify(notification);
    }

    let wDestroyId = null;
    let timeoutId = null;
    let wFocusId;

    let cleanup = function(destroy) {
        if (destroy) {
            notification.destroy();
        }
        wDestroyId.disconnect();
        wFocusId.disconnect();
        if (timeoutId) {
            Mainloop.source_remove(timeoutId);
        }
        window = null;
        notification = null;

        // the counting is not particularly accurate, but at least it should tend
        // towards zero
        --g_urgentCount;
        if (g_urgentCount <= 0) {
            g_urgentCount = 0;
            if (g_applet) {
                if (g_applet.actor.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
                    g_applet.actor.remove_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
                }
            }
        }
    };

    const TIMEOUT = 3000;
    let timerFunction = function() {
        timeoutId = null;
        let is_alerting = window.is_demanding_attention() || window.is_urgent();
        if (!is_alerting || display.focus_window == window) {
            cleanup(true);
            return;
        }
        timeoutId = Mainloop.timeout_add(TIMEOUT, timerFunction);
    };
    timeoutId = Mainloop.timeout_add(TIMEOUT, timerFunction);

    wDestroyId = Connector.connect(window.get_compositor_private(), 'destroy', function() {
        cleanup(true);
    });

    wFocusId = Connector.connect(display, 'notify::focus-window', function(display) {
        if (display.focus_window == window) {
            cleanup(true);
        }
    });
    notification.connect('clicked', function() {
        Main.activateWindow(window);
    });

    notification.connect('destroy', function() {
        cleanup(false);
    });
    if (button) {
        button.connect('clicked', function() {
            window.unset_demands_attention();
            cleanup(true);
        });
    }

    ++g_urgentCount;
    if (g_applet) {
        if (!g_applet.actor.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
            g_applet.actor.add_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
        }
    }
}

// ----------------------------------

function handleHideIcon()
{
    if (g_settings["hide-icon"] && g_applet.actor.width > 1) {
        g_applet.actor._old_width = g_applet.actor.width;
        g_applet.actor.width = 1;
    } else if (!g_settings["hide-icon"] && g_applet.actor.width < 2){
        g_applet.actor.width = g_applet.actor._old_width;
    }
}

// ----------------------------------

function MyApplet() {
    this._init.apply(this, arguments);
}


MyApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function(metadata, orientation, panel_height, instanceId) {
        this.orientation = orientation;
        Applet.IconApplet.prototype._init.call(this, orientation, panel_height, instanceId);
        this.path = metadata.path;
    },

    on_applet_added_to_panel: function() {
        this.set_applet_icon_path(this.path + "/icon.png");
        this.set_applet_tooltip("Alt-Tab Enhanced");

        let item = new PopupMenu.PopupMenuItem(_("Alt-Tab Enhanced Settings"));
        item.connect('activate', openSettings);
        this._applet_context_menu.addMenuItem(item);

        let itemToggleIcon = new PopupMenu.PopupMenuItem("dummy");
        itemToggleIcon.connect('activate', function() {
            g_settings["hide-icon"] = !g_settings["hide-icon"];
            handleHideIcon();
        });
        this._applet_context_menu.addMenuItem(itemToggleIcon);

        this._applet_context_menu.connect('open-state-changed', Lang.bind(this, function(actor, is_opening) {
            if (is_opening) {
                itemToggleIcon.label.text = g_settings["hide-icon"] ? _("Show icon") : _("Hide icon");
            }
        }));
        g_applet = this;
        enable();
        Mainloop.idle_add(handleHideIcon);
    },

    on_applet_removed_from_panel: function(event) {
        disable();
        g_applet = null;
    },

    on_applet_clicked: function(event) {
        g_vAlignOverride = this.orientation == St.Side.BOTTOM ? 'bottom' : 'top';
        g_monitorOverride = Main.layoutManager.findMonitorForActor(this.actor);
        let tabPopup = new AltTabPopup();
        tabPopup._appletActivated = tabPopup._persistent = true;
        tabPopup.show(false, 'no-switch-windows');
    },
    
    on_orientation_changed: function (orientation) {
        this.orientation = orientation;
    }
};

function main(metadata, orientation, panel_height, instanceId) {
    init(metadata, instanceId);
    return new MyApplet(metadata, orientation, panel_height, instanceId);
}
