// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Cinnamon = imports.gi.Cinnamon;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;
const Tweener = imports.ui.tweener;

const Util = imports.misc.util;
const WindowUtils = imports.misc.windowUtils;

var Settings = null;
try {
    Settings = imports.ui.settings; // requires Cinnamon 1.7.2 or later
}
catch (e) {}

/* usage:
 * "let connection = connect(someObject, 'some-signal', someFunction [, ...])
 *  ///...
 *  connection.disconnect();
 *  "
 * 
 * @arg-0: target, the object you want to connect to
 * @arg-1 .. @arg-n: arguments to the target's connect function
 *
 * return value: an object that you call disconnect on
 */
var connect = function() {
    let args = [].slice.apply(arguments);
    let target = args.shift();
    let id = target.connect.apply(target, args);
    return {
        disconnect: function() {
            if (target) {
                target.disconnect(id); target = null;
                }
        },
        forget: function() {
            target = null;
        },
        getTarget: function() {
            return target;
        },
        /* Ties the connection to an object, so it is automatically destroyed with the object.
         */
        tie: function(object) {
            object.connect('destroy', Lang.bind(this, this.disconnect));
        }
    };
};

function Connector() {
    this._init.apply(this, arguments);
}

/* A class that takes care of your connections - just remember to
 * call destroy when it is time to disconnect.
 */
Connector.prototype = {
    _init: function() {
        this.connections = [];
    },

    /* usage: "addConnection(someObject, 'some-signal', someFunction [, ...])"
     * 
     * @arg-0: target, the object you want to connect to
     * @arg-1 .. @arg-n: arguments to the target's connect function
     *
     * @return aConnection, the created connection, which you can optionally disconnect or "forget" later on.
     */
    addConnection: function() {
        let connection = connect.apply(0, arguments);
        this.connections.push(connection);
        return connection;
    },

    /* Disconnects all connections.
     */
    destroy: function() {
        if (this.connections) {
            this.connections.forEach(function(connection) {
                connection.disconnect();
            }, this);
            this.connections = null;
        }
    },

    /* Ties the connector to an object, so the connector is automatically destroyed with the object.
     */
    tie: function(object) {
        object.connect('destroy', Lang.bind(this, this.destroy));
    }
};

const POPUP_APPICON_SIZE = 96;
const POPUP_SCROLL_TIME = 0.10; // seconds
const POPUP_DELAY_TIMEOUT = 150; // milliseconds

const APP_ICON_HOVER_TIMEOUT = 200; // milliseconds

const DISABLE_HOVER_TIMEOUT = 500; // milliseconds

const THUMBNAIL_DEFAULT_SIZE = 256;
const THUMBNAIL_POPUP_TIME = 180; // milliseconds
const THUMBNAIL_FADE_TIME = 0.1; // seconds

const PREVIEW_DELAY_TIMEOUT = 180; // milliseconds
var PREVIEW_SWITCHER_FADEOUT_TIME = 0.5; // seconds

const DEMANDS_ATTENTION_CLASS_NAME = "window-list-item-demands-attention";

const iconSizes = [96, 80, 64, 48, 32, 22];

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
    _("Ctrl+Space: Enter \"persistent mode\", in which Alt-Tab will remain open until actively closed"),
    _("m: Move selected window to next monitor"),
    _("n: Minimize selected window"),
    _("h: Hide Alt-Tab so you can see what's underneath (toggle)"),
    _("Ctrl+w: Close selected window. Use with care!"),
    _("+ (Plus): Show windows from all workspaces"),
    _("- (Minus): Show windows from current workspace only"),
    _("Ctrl+g: Toggle \"global mode\", in which windows from all workspaces are mixed, sorted on last use"),
    _("z: Zoom to see all windows at once without scrolling (toggle)"),
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

// this object will be populated with our settings, if settings support is available
var g_settings = {
};

var g_windowsToIgnore = [];
var g_windowsOrdered = [];

var g_globalFocusOrder = false;

let wFocusId = connect(global.display, 'notify::focus-window', function(display) {
    g_windowsOrdered = g_windowsOrdered.filter(function(window) {
        return window && window != display.focus_window && window.get_workspace();
    }, this);
    g_windowsOrdered.unshift(display.focus_window);
});


function AltTabPopup() {
    this._init();
}

AltTabPopup.prototype = {
    _init : function() {
        this.actor = new Cinnamon.GenericContainer({ name: 'altTabPopup',
                                                  reactive: true,
                                                  visible: false });

        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._haveModal = false;
        this._modifierMask = 0;

        // Keeps track of the number of "primary" items, which is the number
        // of windows on the current workspace. This information is used to
        // size the icons to a size that fits the current working set.
        this._numPrimaryItems = 0;

        this.thumbnailsVisible = false;

        // Initially disable hover so we ignore the enter-event if
        // the switcher appears underneath the current pointer location
        this._disableHover();

        let connector = new Connector();
        connector.tie(this.actor);
        for (let [i, numws] = [0, global.screen.n_workspaces]; i < numws; ++i) {
            let workspace = global.screen.get_workspace_by_index(i);
                connector.addConnection(workspace, 'window-removed', Lang.bind(this, function(ws, metaWindow) {
                    this._removeWindow(metaWindow);
                }));
        }
        connector.addConnection(global.display, 'window-demands-attention', Lang.bind(this, this._onWindowDemandsAttention));
        connector.addConnection(global.display, 'window-marked-urgent', Lang.bind(this, this._onWindowDemandsAttention));

        // remove zombies
        g_windowsToIgnore = g_windowsToIgnore.filter(function(window) {
            return window.get_workspace() != null;
        });

        Main.uiGroup.add_actor(this.actor);

        this._previewEnabled = false;
        this._iconsEnabled = false;
        this._thumbnailsEnabled = false;
        let styleSettings = global.settings.get_string("alttab-switcher-style");
        let features = styleSettings.split('+');
        let found = false;
        for (let i in features) {
            if (features[i] === 'icons') {
                this._iconsEnabled = true;
                found = true;
            }
            if (features[i] === 'preview') {
                this._previewEnabled = true;
                found = true;
            }
            if (features[i] === 'thumbnails') {
                this._thumbnailsEnabled = true;
                found = true;
            }
        }
        if (!found) {
            this._iconsEnabled = true;
        }
        this._showThumbnails = (this._thumbnailsEnabled || this._previewEnabled);
    },

    _indexOfWindow: function(metaWindow) {
        let index = -1;
        if (!this._appIcons) {
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
            this._select(this._currentApp);
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
        let primary = Main.layoutManager.primaryMonitor;

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
        let vPadding = this.actor.get_theme_node().get_vertical_padding();
        let hPadding = leftPadding + rightPadding;

        // Allocate the appSwitcher
        // We select a size based on an icon size that does not overflow the screen
        let [childMinHeight, childNaturalHeight] = this._appSwitcher.actor.get_preferred_height(primary.width - hPadding);
        let [childMinWidth, childNaturalWidth] = this._appSwitcher.actor.get_preferred_width(childNaturalHeight);
        childBox.x1 = Math.max(primary.x + leftPadding, primary.x + Math.floor((primary.width - childNaturalWidth) / 2));
        childBox.x2 = Math.min(primary.x + primary.width - rightPadding, childBox.x1 + childNaturalWidth);
        childBox.y1 = primary.y + Math.floor((primary.height - childNaturalHeight) / 2);
        childBox.y2 = childBox.y1 + childNaturalHeight;
        this._appSwitcher.actor.allocate(childBox, flags);

        // Allocate the thumbnails
        // We try to avoid overflowing the screen so we base the resulting size on
        // those calculations
        if (this._thumbnails && this._currentApp >= 0) {
            let icon = this._appIcons[this._currentApp].actor;
            let [posX, posY] = icon.get_transformed_position();
            let thumbnailCenter = posX + icon.width / 2;
            let [childMinWidth, childNaturalWidth] = this._thumbnails.actor.get_preferred_width(-1);
            childBox.x1 = Math.max(primary.x + leftPadding, Math.floor(thumbnailCenter - childNaturalWidth / 2));
            if (childBox.x1 + childNaturalWidth > primary.x + primary.width - hPadding) {
                let offset = childBox.x1 + childNaturalWidth - primary.width + hPadding;
                childBox.x1 = Math.max(primary.x + leftPadding, childBox.x1 - offset - hPadding);
            }

            let spacing = this.actor.get_theme_node().get_length('spacing');

            childBox.x2 = childBox.x1 +  childNaturalWidth;
            if (childBox.x2 > primary.x + primary.width - rightPadding)
                childBox.x2 = primary.x + primary.width - rightPadding;
            childBox.y1 = this._appSwitcher.actor.allocation.y2 + spacing;
            this._thumbnails.addClones(primary.y + primary.height - bottomPadding - childBox.y1);
            let [childMinHeight, childNaturalHeight] = this._thumbnails.actor.get_preferred_height(-1);
            childBox.y2 = childBox.y1 + childNaturalHeight;
            this._thumbnails.actor.allocate(childBox, flags);
        }
    },

    set _currentApp(val) {
        this._appSwitcher._curApp = val;
    },

    get _currentApp() {
        return this._appSwitcher._curApp;
    },

    get _appIcons() {
        return this._appSwitcher.icons;
    },

    refresh : function(binding, backward) {
        if (this._appSwitcher) {
            this._destroyThumbnails();
            this._appSwitcher.actor.destroy();
        }
       
        // Find out the currently active window
        let wsWindows = Main.getTabList();
        let [currentWindow, forwardWindow, backwardWindow] = [(wsWindows.length > 0 ? wsWindows[0] : null), null, null];

        let windows = [];
        let [currentIndex, forwardIndex, backwardIndex] = [-1, -1, -1];
        let registry = {};

        let activeWsIndex = global.screen.get_active_workspace_index();
        for (let [i, numws] = [0, global.screen.n_workspaces]; i < numws; ++i) {
            let wlist = Main.getTabList(global.screen.get_workspace_by_index(i)).filter(function(window) {
                // Main.getTabList will sometimes return duplicates. Happens with Skype chat windows marked urgent.
                let seqno = window.get_stable_sequence();
                if (registry[seqno]) {
                    return false;
                }
                registry[seqno] = true;
                return true;
            }, this);

            if (i != activeWsIndex) {
                wlist = wlist.filter(function(window) {
                    // We don't want duplicates. Ignored windows from other workspaces are not welcome.
                    return !window.is_on_all_workspaces() && (!g_globalFocusOrder || g_windowsToIgnore.indexOf(window) < 0);
                }, this);
            }
            if (g_settings.allWorkspacesMode || i == activeWsIndex) {
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

        if (g_globalFocusOrder) {
            windows = windows.sort(function(a, b) {
                let minimizedDiff = (a.minimized ? 1 : 0) - (b.minimized ? 1 : 0);
                if (minimizedDiff) {
                    return minimizedDiff;
                }
                let ignoredDiff = (g_windowsToIgnore.indexOf(a) < 0 ? 0 : 1) - (g_windowsToIgnore.indexOf(b) < 0 ? 0 : 1);
                if (ignoredDiff) {
                    return ignoredDiff;
                }
                let inGlobalListDiff = (g_windowsOrdered.indexOf(a) < 0 ? 1 : 0) - (g_windowsOrdered.indexOf(b) < 0 ? 1 : 0);
                if (inGlobalListDiff) {
                    return inGlobalListDiff;
                }
                let globalDiff = g_windowsOrdered.indexOf(a) - g_windowsOrdered.indexOf(b);
                return globalDiff || windows.indexOf(a) - windows.indexOf(b);
            }, this);
            currentWindow = windows[0];
            forwardWindow = windows[1];
            backwardWindow = windows[windows.length - 1];
        }

        currentIndex = windows.indexOf(currentWindow);
        if (forwardWindow) {forwardIndex = windows.indexOf(forwardWindow)};
        if (backwardWindow) {backwardIndex = windows.indexOf(backwardWindow)};

        // Size the icon bar primarily to fit the windows of the current workspace.
        this._numPrimaryItems_Orig = Math.max(2, wsWindows.length);
        this._numPrimaryItems = this._numPrimaryItems_Orig;
        this._zoomedOut = false;

        this._createAppswitcher(windows);
        
        // Need to force an allocation so we can figure out whether we
        // need to scroll when selecting
        this._appSwitcher.actor.opacity = 0;
        this.actor.show();
        this.actor.get_allocation_box();
        
        if (!this._homeWindow) {
            this._homeWindow = currentWindow;
        }

        // if we are refreshing after already being shown, retain current selection, if possible
        if (this._selectedWindow) {
            forwardIndex = windows.indexOf(this._selectedWindow);
        }
        let haveSelection = this._selectedWindow != null; // this._selectedWindow is modified by _select

        if (g_settings.allWorkspacesMode && !this._thumbnailsEnabled && !g_globalFocusOrder) { // restricted feature
            this._appSwitcher._indicateItem(currentIndex, "_currentFocus", St.Side.TOP);
        }

        // Make the initial selection
        if (this._appIcons.length > 0 && currentIndex >= 0) {
            if (binding == 'no-switch-windows') {
                this._select(currentIndex);
                this._appSwitcher._scrollTo(currentIndex, -1, 2, true);
            } else if (backward) {
                this._select(backwardIndex);
                this._appSwitcher._scrollTo(backwardIndex, 1, 0, true);
            } else {
                if (forwardIndex >= 0) {
                    this._select(forwardIndex);
                    // ensure that all the windows of the current workspace are in view
                    this._appSwitcher._scrollTo(backwardIndex, 1, 3, true);
                    this._appSwitcher._scrollTo(forwardIndex, -1, 2, true);
                }
            }
        }
        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details.) So we check now. (Have to do this after updating
        // selection.)
        if (!this._persistent) {
            let [x, y, mods] = global.get_pointer();
            if (!(mods & this._modifierMask)) {
                return false;
            }
        }

        if (this._appIcons.length > 0) {
            // We delay showing the popup so that fast Alt+Tab users aren't
            // disturbed by the popup briefly flashing.
            this._initialDelayTimeoutId = Mainloop.timeout_add(haveSelection ? 0 : POPUP_DELAY_TIMEOUT,
                Lang.bind(this, function () {
                    this._appSwitcher.actor.opacity = 255;
                    this._initialDelayTimeoutId = 0;
                }));
        }
        
        return true;
    },

    _createAppswitcher: function(windows) {
        if (this._appSwitcher) {
            this._appSwitcher.actor.destroy();
        }
        this._appSwitcher = new AppSwitcher(windows, this._showThumbnails, this._iconsEnabled, this);
        this.actor.add_actor(this._appSwitcher.actor);
        if (!this._iconsEnabled && !this._thumbnailsEnabled) {
            this._appSwitcher.actor.hide();
        }
        this._appSwitcher.connect('item-activated', Lang.bind(this, this._appActivated));
    },
    
    show : function(backward, binding, mask) {
        if (!Main.pushModal(this.actor)) {
            this.destroy();
            return false;
        }
        this._haveModal = true;
        this._modifierMask = primaryModifier(mask);
        if (binding && binding.search(/group/) >= 0) {
            g_settings.allWorkspacesMode = false;
        }
        if (!this.refresh(binding, backward)) {
            this._finish();
            return false;
        }
        
        this.actor.connect('key-press-event', Lang.bind(this, this._keyPressReleaseEvent, KeyState.PRESSED));
        this.actor.connect('key-release-event', Lang.bind(this, this._keyPressReleaseEvent, KeyState.RELEASED));

        this.actor.connect('button-press-event', Lang.bind(this, this._clickedOutside));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScroll));
        return true;
    },

    _nextApp : function() {
        return mod(this._currentApp + 1, this._appIcons.length);
    },
    _previousApp : function() {
        return mod(this._currentApp - 1, this._appIcons.length);
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
            let [x, y, mods] = global.get_pointer();
            let state = mods & this._modifierMask;

            if (state == 0 && !this._persistent) {
                this._finish();
                return true;
            }
        }
        
        let findFirstWorkspaceWindow = Lang.bind(this, function(startIndex) {
            let wsCurIx = this._appIcons[startIndex].window.get_workspace().index();
            for (let i = startIndex; i >= 0; --i) {
                if (this._appIcons[i].window.get_workspace().index() == wsCurIx) {
                    continue;
                }
                return i + 1;
             }
            return 0;
        });

        let switchWorkspace = Lang.bind(this, function(direction) {
            if (this._currentApp < 0) {
                return false;
            }
            let wsCurIx = this._appIcons[this._currentApp].window.get_workspace().index();
            if (direction > 0) {
                for (let [i, iLen] = [this._currentApp + 1, this._appIcons.length]; i < iLen; ++i) {
                    if (i == iLen - 1 || this._appIcons[i].window.get_workspace().index() != wsCurIx) {
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

        let keysym = event.get_key_symbol();
        let event_state = Cinnamon.get_event_state(event);
        let backwards = event_state & Clutter.ModifierType.SHIFT_MASK;
        let ctrlDown = event_state & Clutter.ModifierType.CONTROL_MASK;
        let action = global.display.get_keybinding_action(event.get_key_code(), event_state);

        this._disableHover();
        const SCROLL_AMOUNT = 5;

        if (pressed) {
            if (false) {
            } else if (keysym == Clutter.Escape) {
                this.destroy();
            } else if (keysym == Clutter.Tab) {
                this._select(this._nextApp());
            } else if (keysym == Clutter.ISO_Left_Tab) {
                this._select(this._previousApp());
            } else if (keysym == Clutter.Home || keysym == Clutter.KP_Home) {
                this._select(ctrlDown && this._homeWindow ? this._indexOfWindow(this._homeWindow) : 0);
            } else if (keysym == Clutter.End || keysym == Clutter.KP_End) {
                this._select(this._appIcons.length - 1);
            } else if (keysym == Clutter.Page_Down || keysym == Clutter.KP_Page_Down) {
                this._select(Math.min(this._appIcons.length - 1, this._currentApp + SCROLL_AMOUNT));
            } else if (keysym == Clutter.Page_Up || keysym == Clutter.KP_Page_Up) {
                this._select(Math.max(0, this._currentApp - SCROLL_AMOUNT));
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
                this._select(backwards ? this._previousApp() : this._nextApp());
            } else {
                if (keysym == Clutter.Left) {
                    if (ctrlDown) {
                        if (switchWorkspace(-1)) {
                            return false;
                        }
                    }
                    this._select(this._previousApp());
                }
                else if (keysym == Clutter.Right) {
                    if (ctrlDown) {
                        if (switchWorkspace(1)) {
                            return false;
                        }
                    }
                    this._select(this._nextApp());
                }
            }
            return true;
        }
        else if (released) {
            if (false) {
            } else if (keysym == Clutter.F1) {
                this._showHelp();
            } else if (keysym == Clutter.KEY_space && !this._persistent) {
                this._persistent = true;
            } else if (keysym == Clutter.z) {
                this._toggleZoom();
            } else if (keysym == Clutter.plus || keysym == Clutter.minus) {
                let newMode = keysym == Clutter.plus;
                if (g_settings.allWorkspacesMode != newMode) {
                    g_settings.allWorkspacesMode = newMode;
                    this.refresh();
                }
            } else if (keysym == Clutter.h) { // toggle hide
                if (this._hiding) {
                    this._hiding = false;
                    this._appSwitcher.actor.opacity = 255;
                }
                else {
                    this._hiding = true;
                    this._appSwitcher.actor.opacity = 25;
                }
            } else if (keysym == Clutter.g && ctrlDown) {
                if (global.screen.n_workspaces > 1) {
                    g_globalFocusOrder = !g_globalFocusOrder;
                    if (g_globalFocusOrder) {
                        g_settings.allWorkspacesMode = true; // enable together, but disable separately
                    }
                    this.refresh();
                }
            } else if (keysym == Clutter.w && ctrlDown) {
                if (this._currentApp >= 0) {
                    this._appIcons[this._currentApp].window.delete(global.get_current_time());
                }
            } else if (keysym == Clutter.i && ctrlDown) {
                if (this._currentApp >= 0) {
                    if (g_windowsToIgnore.indexOf(this._appIcons[this._currentApp].window) < 0) {
                        this._appIcons[this._currentApp].ignored = true;
                        g_windowsToIgnore.push(this._appIcons[this._currentApp].window);
                    }
                }
            } else if (keysym == Clutter.m && !ctrlDown) {
                let monitorCount = Main.layoutManager.monitors.length;
                if (this._currentApp >= 0 && monitorCount > 1) {
                    let window = this._appIcons[this._currentApp].window;
                    let index = window.get_monitor();
                    let newIndex = (index + monitorCount + 1) % monitorCount;
                    window.move_to_monitor(newIndex);
                    this._select(this._currentApp); // refresh
                }
            } else if (keysym == Clutter.n && !ctrlDown) {
                if (this._currentApp >= 0) {
                    let window = this._appIcons[this._currentApp].window;
                    (window.minimized ? window.unminimize : window.minimize).call(window, global.get_current_time());
                    this._select(this._currentApp); // refresh
                }
            }
            return true;
        }
        
        return false;
    },

    _showHelp : function() {
        this._persistent = true;
        let dialog = new ModalDialog.ModalDialog();

        let label = new St.Label({text: _("Alt-Tab Quick Help")});
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
                label: _("Open Window Settings"),
                focused: false,
                action: function() {
                    altTab.destroy();
                    dialog.close();
                    Util.spawnCommandLine("cinnamon-settings windows");
                }
            },
            {
                label: _("Close"),
                focused: true,
                action: function() {
                    dialog.close();
                }
            }
        ]);
        dialog.open();
    },

    _onScroll : function(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP) {
            this._select(this._previousApp());
        } else if (direction == Clutter.ScrollDirection.DOWN) {
            this._select(this._nextApp());
        }
    },

    _clickedOutside : function(actor, event) {
        this.destroy();
    },

    _activateWindow : function(window) {
        let wsNow = global.screen.get_active_workspace();
        Main.activateWindow(window);
        if (window.get_workspace() != wsNow) {
            Main.wm.showWorkspaceOSD();
        }
    },

    _appActivated : function(appSwitcher, n) {
        // If the user clicks on the selected app, activate the
        // selected window; otherwise (e.g., they click on an app while
        // !mouseActive) activate the clicked-on app.
        this._activateWindow(this._appIcons[n].window);
        this.destroy();
    },

    _windowActivated : function(thumbnailList, n) {
        this._activateWindow(this._appIcons[this._currentApp].window);
        this.destroy();
    },

    _windowEntered : function(thumbnailList, n) {
        if (!this._mouseActive)
            return;

        this._select(this._currentApp, n);
    },

    _disableHover : function() {
        this._mouseActive = false;

        if (this._motionTimeoutId)
            Mainloop.source_remove(this._motionTimeoutId);

        this._motionTimeoutId = Mainloop.timeout_add(DISABLE_HOVER_TIMEOUT, Lang.bind(this, this._mouseTimedOut));
    },

    _mouseTimedOut : function() {
        this._motionTimeoutId = 0;
        this._mouseActive = true;
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
        this.actor.destroy();
    },

    _onDestroy : function() {
        this._popModal();

        if (this._motionTimeoutId)
            Mainloop.source_remove(this._motionTimeoutId);
        if (this._thumbnailTimeoutId)
            Mainloop.source_remove(this._thumbnailTimeoutId);
        if (this._initialDelayTimeoutId)
            Mainloop.source_remove(this._initialDelayTimeoutId);
        if (this._displayPreviewTimeoutId)
            Mainloop.source_remove(this._displayPreviewTimeoutId);
    },
    
    _clearPreview: function() {
        if (this._previewClones) {
            this._previewClones.destroy();
            this._previewClones = null;
        }
    },
    
    _doWindowPreview: function() {
        if (!this._previewEnabled || this._appIcons.length < 1 || this._currentApp < 0)
        {
            return;
        }

        let showPreview = function() {
            this._displayPreviewTimeoutId = null;
            if (!this._haveModal || this._currentApp < 0) {return;}

            let childBox = new Clutter.ActorBox();

            let window = this._appIcons[this._currentApp].window;
            let previewClones = new St.Group();
            this.actor.add_actor(previewClones);

            let clones = WindowUtils.createWindowClone(window, null, true, false);
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
            previewClones.lower(this._appSwitcher.actor);
            if (window.minimized) {
                previewClones.opacity = 192;
            }
            let app = this._appIcons[this._currentApp].app;
            const size = 64;
            let icon = app ? app.create_icon_texture(size) : null;
            if (icon) {
                previewClones.add_actor(icon);
                let x1 = childBox.x1 = clones[0].x;
                childBox.x2 = x1 + size;
                let y1 = childBox.y1 = clones[0].y;
                childBox.y2 = y1 + size;
                icon.allocate(childBox, 0);
            }

            this._clearPreview();
            this._previewClones = previewClones;

            if (this._previewBackdrop) {return;}

            let backdrop = Meta.BackgroundActor.new_for_screen(global.screen);
            if (!backdrop) {
                backdrop = this._previewBackdrop = new St.Bin();
                backdrop.style = "background-color: rgba(0,0,0,0.9)";
            }

            if (backdrop) {
                this._previewBackdrop = backdrop;
                this.actor.add_actor(backdrop);
                backdrop.lower(this._appSwitcher.actor);
                backdrop.lower(previewClones);
                childBox.x1 = this.actor.x;
                childBox.x2 = this.actor.x + this.actor.width;
                childBox.y1 = this.actor.y;
                childBox.y2 = this.actor.y + this.actor.height;
                backdrop.allocate(childBox, 0);
            }
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
    _select : function(app) {
        if (app != this._currentApp) {
            this._destroyThumbnails();
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

        this._appIcons[app].updateLabel();
        this._appSwitcher.highlight(app, false);
        this._doWindowPreview();
        if (this._thumbnailsEnabled && this._iconsEnabled) {
            this._appSwitcher._indicateItem(-1, "_currentThumbnail");
            if (this._thumbnailTimeoutId) {
                Mainloop.source_remove(this._thumbnailTimeoutId);
            }
            this._thumbnailTimeoutId = Mainloop.timeout_add(
                THUMBNAIL_POPUP_TIME, Lang.bind(this, function() {
                    if (!this._thumbnails)
                        this._createThumbnails();
                    this._thumbnails.highlight(0, false);
                    this._appSwitcher._indicateItem(app, "_currentThumbnail", St.Side.BOTTOM);
            }));
        }
    },

    _destroyThumbnails : function() {
        if (!this._thumbnails) {
            return;
        }
        this.thumbnailsVisible = false;
        this._thumbnails.actor.destroy();
        this._thumbnails = null;
    },

    _createThumbnails : function() {
        this._thumbnails = new ThumbnailList (this._appIcons[this._currentApp].cachedWindows);
        this._thumbnails.connect('item-activated', Lang.bind(this, this._windowActivated));

        this.actor.add_actor(this._thumbnails.actor);

        // Need to force an allocation so we can figure out whether we
        // need to scroll when selecting
        this._thumbnails.actor.get_allocation_box();

        this._thumbnails.actor.opacity = 0;
        Tweener.addTween(this._thumbnails.actor,
                         { opacity: 255,
                           time: THUMBNAIL_FADE_TIME,
                           transition: 'easeOutQuad',
                           onComplete: Lang.bind(this, function () { this.thumbnailsVisible = true; })
                         });
    }
};

function SwitcherList(squareItems) {
    this._init(squareItems);
}

SwitcherList.prototype = {
    _init : function(squareItems) {
        this.actor = new Cinnamon.GenericContainer({ style_class: 'switcher-list' });
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocateTop));
        this.actor.connect('destroy', Lang.bind(this, function() {
            if (this._highlightTimeout) {Mainloop.source_remove(this._highlightTimeout);}
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

        this._clipBin = new St.Bin({style_class: 'cbin'});
        this._clipBin.child = this._list;
        this.actor.add_actor(this._clipBin);

        this._leftGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-left', vertical: true});
        this._rightGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-right', vertical: true});
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
        this._squareItems = squareItems;
        this._minSize = 0;
        this._scrollableRight = true;
        this._scrollableLeft = false;
    },

    _allocateTop: function(actor, box, flags) {
        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);

        let childBox = new Clutter.ActorBox();
        let scrollable = this._minSize > box.x2 - box.x1;

        this._clipBin.allocate(box, flags);

        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = this._leftGradient.width;
        childBox.y2 = this.actor.height;
        this._leftGradient.allocate(childBox, flags);
        this._leftGradient.opacity = (this._scrollableLeft && scrollable) ? 255 : 0;

        childBox.x1 = (this.actor.allocation.x2 - this.actor.allocation.x1) - this._rightGradient.width;
        childBox.y1 = 0;
        childBox.x2 = childBox.x1 + this._rightGradient.width;
        childBox.y2 = this.actor.height;
        this._rightGradient.allocate(childBox, flags);
        this._rightGradient.opacity = (this._scrollableRight && scrollable) ? 255 : 0;

        let arrowWidth = Math.floor(leftPadding / 3);
        let arrowHeight = arrowWidth * 2;
        childBox.x1 = leftPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._leftArrow.allocate(childBox, flags);
        this._leftArrow.opacity = this._leftGradient.opacity;

        arrowWidth = Math.floor(rightPadding / 3);
        arrowHeight = arrowWidth * 2;
        childBox.x1 = this.actor.width - rightPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._rightArrow.allocate(childBox, flags);
        this._rightArrow.opacity = this._rightGradient.opacity;
    },

    addItem : function(item, label) {
        let bbox = new St.Button({ style_class: 'item-box',
                                   reactive: true });
        item._bbox = bbox;
        bbox.set_child(item);
        this._list.add_actor(bbox);

        let n = this._items.length;
        bbox.connect('clicked', Lang.bind(this, function() { this._onItemClicked(n); }));

        bbox.label_actor = label;

        this._items.push(bbox);
    },

    _onItemClicked: function (index) {
        this._itemActivated(index);
    },

    addSeparator: function () {
        if (!g_globalFocusOrder) {
            let box = new St.Bin({ style_class: 'separator' });
            this._separators.push(box);
            this._list.add_actor(box);
        }
    },

    highlight: function(index, justOutline) {
        if (this._highlightTimeout) {
            Mainloop.source_remove(this._highlightTimeout); this._highlightTimeout = 0;
        }
        this._highlightTimeout = Mainloop.timeout_add(25, Lang.bind(this, function() {
            this._highlightTimeout = 0;

            let prevIndex = this._highlighted;
            // If previous index is negative, we are probably initializing, and we want
            // to show as many of the current workspace's windows as possible.

            let direction = prevIndex == -1 ? 1 : index - prevIndex;
            if (this._highlighted != -1) {
                this._items[this._highlighted].remove_style_pseudo_class('outlined');
                this._items[this._highlighted].remove_style_pseudo_class('selected');
            }
            this._highlighted = index;
            if (this._highlighted != -1) {
                if (justOutline)
                    this._items[this._highlighted].add_style_pseudo_class('outlined');
                else
                    this._items[this._highlighted].add_style_pseudo_class('selected');
            }
            // If we're close to either the left or the right edge, we want to scroll
            // the edge-most items into view.
            let scrollMax = Math.min(5, Math.floor(this._items.length/4));
            this._scrollTo(index, direction, scrollMax, prevIndex == -1);
        }));
    },

    _scrollTo: function(index, direction, scrollMax_, fast) {
        let scrollMax = scrollMax_ ? scrollMax_ : 1;
        let ixScroll = direction > 0 ?
            Math.min(index + scrollMax, this._items.length - 1) : // right
            Math.max(index - scrollMax, 0); // left

        let [absItemX, absItemY] = this._items[ixScroll].get_transformed_position();
        let [result, posX, posY] = this.actor.transform_stage_point(absItemX, 0);
        let [containerWidth, containerHeight] = this.actor.get_transformed_size();

        if (direction > 0) {
            if (ixScroll == this._items.length - 1) {
                this._scrollableRight = false;
                this._rightArrow.opacity = this._rightGradient.opacity = 0;
            }
            if (posX + this._items[ixScroll].get_width() >= containerWidth) {
                Tweener.removeTweens(this._list);
                this._scrollableLeft = true;
                let monitor = Main.layoutManager.primaryMonitor;
                let padding = this.actor.get_theme_node().get_horizontal_padding();
                let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
                let x = this._items[ixScroll].allocation.x2 - monitor.width + padding + parentPadding;
                Tweener.addTween(this._list, { anchor_x: x,
                    time: fast ? 0 : POPUP_SCROLL_TIME,
                    transition: 'linear'
                });
            }
        }
        else if (direction < 0) {
            if (ixScroll == 0) {
                this._scrollableLeft = false;
                this._leftArrow.opacity = this._leftGradient.opacity = 0;
            }
            let padding = this.actor.get_theme_node().get_horizontal_padding();
            if (posX <= padding) {
                Tweener.removeTweens(this._list);
                this._scrollableRight = true;
                let x = (ixScroll == 0 ? this._list.get_children() : this._items)[ixScroll].allocation.x1;
                Tweener.addTween(this._list, { anchor_x: x,
                    time: fast ? 0 : POPUP_SCROLL_TIME,
                    transition: 'linear'
                });
            }
        }
    },

    _itemActivated: function(n) {
        this.emit('item-activated', n);
    },

    _maxChildWidth: function (forHeight) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);

            if (this._squareItems) {
                let [childMin, childNat] = this._items[i].get_preferred_height(-1);
                maxChildMin = Math.max(childMin, maxChildMin);
                maxChildNat = Math.max(childNat, maxChildNat);
            }
        }

        return [maxChildMin, maxChildNat];
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        let separatorWidth = 0;
        if (this._separators.length) {
            let [sepMin, sepNat] = this._separators[0].get_preferred_width(forHeight);
            separatorWidth = Math.max(1, this._separators.length - 1) * (sepNat + this._list.spacing);
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

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_height(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);
        }

        if (this._squareItems) {
            let [childMin, childNat] = this._maxChildWidth(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = maxChildMin;
        }

        alloc.min_size = maxChildMin;
        alloc.natural_size = maxChildNat;
    },

    _allocate: function (actor, box, flags) {
        let childHeight = box.y2 - box.y1;

        let [maxChildMin, maxChildNat] = this._maxChildWidth(childHeight);
        let totalSpacing = this._list.spacing * (this._items.length - 1);

        let separatorWidth = 0;
        if (this._separators.length) {
            let [sepMin, sepNat] = this._separators[0].get_preferred_width(childHeight);
            separatorWidth = sepNat;
            totalSpacing += Math.max(1, this._separators.length - 1) * this._list.spacing;
        }

        let childWidth = Math.floor(Math.max(0, box.x2 - box.x1 - totalSpacing - separatorWidth) / this._items.length);

        let x = 0;
        let children = this._list.get_children();
        let childBox = new Clutter.ActorBox();

        let primary = Main.layoutManager.primaryMonitor;
        let parentRightPadding = this.actor.get_parent().get_theme_node().get_padding(St.Side.RIGHT);
        if (this.actor.allocation.x2 == primary.x + primary.width - parentRightPadding) {
            if (this._squareItems)
                childWidth = childHeight;
            else {
                let ixxi = (this._highlighted + this._items.length) % this._items.length;
                let [childMin, childNat] = this._items[ixxi].get_preferred_width(childHeight);
                childWidth = childMin;
            }
        }

        for (let i = 0; i < children.length; i++) {
            if (this._items.indexOf(children[i]) != -1) {
                let [childMin, childNat] = children[i].get_preferred_height(childWidth);
                let [width, height] = children[i].get_size();
                let vSpacing = Math.floor((childHeight - childNat) / 2);
                childBox.x1 = x;
                childBox.y1 = vSpacing;
                childBox.x2 = x + width;
                childBox.y2 = childBox.y1 + height;
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

Signals.addSignalMethods(SwitcherList.prototype);

function AppIcon() {
    this._init.apply(this, arguments);
}

AppIcon.prototype = {
    _init: function(window, showThumbnail, showIcons) {
        this.window = window;
        this.ignored = g_windowsToIgnore.indexOf(window) >= 0;
        this.showThumbnail = showThumbnail;
        this.showIcons = showIcons;
        let tracker = Cinnamon.WindowTracker.get_default();
        this.app = tracker.get_window_app(window);
        this.actor = new St.BoxLayout({ style_class: 'alt-tab-app',
                                         vertical: true, y_align: St.Align.START });
        this.actor.connect('destroy', Lang.bind(this, function() {
            if (this._urgencyTimeout) {
                Mainloop.source_remove(this._urgencyTimeout);
            }
        }));
        this.icon = null;

        this._iconBin = new St.Bin();
        this.actor.add(this._iconBin, { x_fill: false, y_fill: false, y_align: St.Align.END } );

        this.label = new St.Label();
        this.label.clutter_text.line_wrap = true;
        this._label_bin = new St.Bin({ x_align: St.Align.MIDDLE, y_align: St.Align.START });
        this._label_bin.add_actor(this.label);
        this.actor.add(this._label_bin);

        this.wsLabel = new St.Label();
        this.wsLabel.clutter_text.line_wrap = true;
        this._wsLabel_bin = new St.Bin({ x_align: St.Align.MIDDLE, y_align: St.Align.START });
        this._wsLabel_bin.add_actor(this.wsLabel);
        this.actor.add(this._wsLabel_bin);

        this.updateLabel();
    },

    _checkAttention: function() {
        if (!this.actor._bbox) {return;}
        if (this._urgencyTimeout) {
            Mainloop.source_remove(this._urgencyTimeout);
            this._urgencyTimeout = 0;
        }
        let bbox = this.actor._bbox;
        let is_urgent = this.window.is_demanding_attention() || this.window.is_urgent();

        if (is_urgent && !bbox.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
            bbox.add_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
        }
        else if (!is_urgent && bbox.has_style_class_name(DEMANDS_ATTENTION_CLASS_NAME)) {
            bbox.remove_style_class_name(DEMANDS_ATTENTION_CLASS_NAME);
        }
        if (is_urgent) {
            this._urgencyTimeout = Mainloop.timeout_add(5000, Lang.bind(this, this._checkAttention));
        }
    },

    updateLabel: function() {
        let ws = this.window.get_workspace().index();
        this.wsLabel.set_text("(" + (ws + 1) + ")");

        let title = this.window.get_title();
        title = typeof(title) != 'undefined' ? title : (this.app ? this.app.get_name() : "");
        this.label.set_text(title.length && this.window.minimized ? "[" + title + "]" : title);
    },

    calculateSlotSize: function(sizeIn) {
        // Icons are sized smaller if they don't belong to the active workspace
        return this.window.get_workspace() == global.screen.get_active_workspace() ? sizeIn : Math.floor(sizeIn * 3 / 4);
    },

    _createApplicationIcon: function(size) {
        return this.app ?
            this.app.create_icon_texture(size) :
            new St.Icon({ icon_name: 'application-default-icon',
                icon_type: St.IconType.FULLCOLOR,
                icon_size: size
            });
    },

    set_size: function(sizeIn, focused) {
        let size = this.calculateSlotSize(sizeIn);
        if (this.icon) {this.icon.destroy();}
        if (!this.showIcons || (this.showThumbnail && g_settings.thumbnailsBehindIdenticalIcons && this.app && this.app.get_windows().length > 1)) {
            this.icon = new St.Group();
            let clones = WindowUtils.createWindowClone(this.window, size, true, true);
            for (i in clones) {
                let clone = clones[i];
                this.icon.add_actor(clone.actor);
                clone.actor.set_position(clone.x, clone.y);
            }
            if (this.showIcons) {
                let [width, height] = clones[0].actor.get_size();
                clones[0].actor.set_position(Math.floor((size - width)/2), 0);
                let isize = Math.max(Math.ceil(size * 3/4), iconSizes[iconSizes.length - 1]);
                let icon = this._createApplicationIcon(isize);
                this.icon.add_actor(icon);
                icon.set_position(Math.floor((size - isize)/2), size - isize);
            }
        }
        else {
            this.icon = this._createApplicationIcon(size);
        }
        // Make some room for the window title.
        this._label_bin.set_size(Math.floor(size * 1.2), Math.max(50, Math.floor(size/2)));
        if (this.ignored) {
            this.icon.opacity = 170;
        }
        this._iconBin.child = this.icon;
        this._iconBin.set_size(Math.floor(size * 1.2), sizeIn);
        if (g_globalFocusOrder) {
            this.wsLabel.show();
        }
        else {
            this.wsLabel.hide();
            this.wsLabel.height = 0;
        }
    }
};

function AppSwitcher() {
    this._init.apply(this, arguments);
}

AppSwitcher.prototype = {
    __proto__ : SwitcherList.prototype,

    _init : function(windows, showThumbnails, showIcons, altTabPopup) {
        SwitcherList.prototype._init.call(this, false);

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

        this.icons = [];
        let lastWsIndex = 0;
        workspaceIcons.forEach(function(icon) {
            let wsIndex = icon.window.get_workspace().index();
            for (let i = wsIndex - lastWsIndex; g_settings.allWorkspacesMode && i > 0; --i) {
                this.addSeparator();
                lastWsIndex = wsIndex;
            }
            this._addIcon(icon);
        }, this);

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

        let themeNode = this._items[modelIndex].get_theme_node();
        let iconPadding = themeNode.get_horizontal_padding() * 2;
        let iconVPadding = themeNode.get_vertical_padding() * 2;
        let iconBorder = themeNode.get_border_width(St.Side.LEFT) + themeNode.get_border_width(St.Side.RIGHT);
        let [iconMinHeight, iconNaturalHeight] = this.icons[modelIndex].label.get_preferred_height(-1);
        let iconSpacing = iconPadding + iconBorder;
        let totalSpacing = this._list.spacing * (this._items.length - 1);
        if (this._separators.length)
           totalSpacing += Math.max(1, this._separators.length - 1) * (this._separators[0].width + this._list.spacing);

        // We just assume the whole screen here due to weirdness happing with the passed width
        let primary = Main.layoutManager.primaryMonitor;
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let availWidth = primary.width - parentPadding - this.actor.get_theme_node().get_horizontal_padding() * 2;
        let height = 0;

        for(let i =  0; i < iconSizes.length; i++) {
            this._iconSize = iconSizes[i];
            height = this._iconSize + iconNaturalHeight + iconVPadding;
            let width = this._iconSize + iconSpacing;
            let w = 0;
            if (this._altTabPopup._numPrimaryItems != this.icons.length) {
                w = width * this._altTabPopup._numPrimaryItems + totalSpacing;
            }
            else {
                w = totalSpacing;
                for(let ii = 0; ii < this.icons.length; ii++) {
                    w += this.icons[ii].calculateSlotSize(this._iconSize) + iconSpacing;
                }
            }
            if (w < availWidth) {
                    break;
            }
        }   

        if (this._items.length == 1) {
            this._iconSize = iconSizes[0];
            height = iconSizes[0] + iconNaturalHeight + iconVPadding;
        }

        for(let i = 0; i < this.icons.length; i++) {
            if (this.icons[i].icon != null)
                break;
            this.icons[i].set_size(this._iconSize);
        }

        alloc.min_size = height;
        alloc.natural_size = height;
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

        let arrow = this[id] = new St.DrawingArea({ style_class: 'switcher-arrow' });
        arrow.connect('repaint', Lang.bind(this, function() {
            _drawArrow(arrow, direction);
        }));
        this._list.add_actor(arrow);

        // First, find the tallest item in the list
        let height = 0;
        for (let i = 0; i < this._items.length; i++) {
            height = Math.max(height, this._items[i].allocation.y2);
        }

        let childBox = new Clutter.ActorBox();
        let [arrowWidth, arrowHeight] = this._getArrowDimensions();
        let itemBox = this._items[index].allocation;
        childBox.x1 = Math.floor(itemBox.x1 + (itemBox.x2 - itemBox.x1 - arrowWidth) / 2);
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y1 = height - arrowHeight * 2;
        childBox.y2 = childBox.y1 + arrowHeight;
        arrow.allocate(childBox, 0);
    },

    highlight : function(n, justOutline) {
        if (this._prevApp != -1) {
            this.icons[this._prevApp].set_size(this._iconSize);
        }

        SwitcherList.prototype.highlight.call(this, n, justOutline);
        this._prevApp = this._curApp = n;
 
        if (this._curApp != -1 && this._altTabPopup._iconsEnabled) {
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
        this.addItem(appIcon.actor, appIcon.label);
        appIcon._checkAttention();
    }
};

function ThumbnailList(windows) {
    this._init(windows);
}

ThumbnailList.prototype = {
    __proto__ : SwitcherList.prototype,

    _init : function(windows) {
        SwitcherList.prototype._init.call(this);

        this._labels = new Array();
        this._thumbnailBins = new Array();
        this._clones = new Array();
        this._windows = windows;

        for (let i = 0; i < windows.length; i++) {
            let box = new St.BoxLayout({ style_class: 'thumbnail-box',
                                         vertical: true });

            let bin = new St.Bin({ style_class: 'thumbnail' });

            box.add_actor(bin);
            this._thumbnailBins.push(bin);
            this.addItem(box, null);
        }
    },

    addClones : function (availHeight) {
        if (!this._thumbnailBins.length)
            return;
        let totalPadding = this._items[0].get_theme_node().get_vertical_padding();
        totalPadding += this.actor.get_theme_node().get_vertical_padding();
        let [labelMinHeight, labelNaturalHeight] = this._labels.length > 0 ?
            this._labels[0].get_preferred_height(-1) : [0, 0];
        let spacing = this._items[0].child.get_theme_node().get_length('spacing');

        availHeight = Math.min(availHeight - labelNaturalHeight - totalPadding - spacing, THUMBNAIL_DEFAULT_SIZE);
        let binHeight = availHeight - spacing;
        binHeight = Math.min(THUMBNAIL_DEFAULT_SIZE, binHeight);

        for (let i = 0; i < this._thumbnailBins.length; i++) {
            let metaWindow = this._windows[i];
            let container = new St.Group();
            let clones = WindowUtils.createWindowClone(metaWindow, binHeight, true, true);
            for (let j = 0; j < clones.length; j++) {
              let clone = clones[j];
              container.add_actor(clone.actor);
              clone.actor.set_position(clone.x, clone.y);
            }
            this._thumbnailBins[i].set_height(binHeight);
            this._thumbnailBins[i].add_actor(container);
            this._clones.push(container);
        }

        // Make sure we only do this once
        this._thumbnailBins = new Array();
    }
};

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

function init(metadata) {
    if (Settings) {
        // yes, we have local settings support!
        let settings = new Settings.ExtensionSettings(g_settings, metadata['uuid']);

        settings.bindProperty(Settings.BindingDirection.IN,
            "thumbnails-behind-identical-icons",
            "thumbnailsBehindIdenticalIcons",
            function() {},
            null);
        settings.bindProperty(Settings.BindingDirection.BIDIRECTIONAL,
            "all-workspaces-mode",
            "allWorkspacesMode",
            function() {},
            null);
    }
    else {
        // if we don't have local settings support, we must hard-code our preferences
        g_settings.thumbnailsBehindIdenticalIcons = true;
        g_settings.allWorkspacesMode = false;
    }
}

function enable() {
    Meta.keybindings_set_custom_handler('switch-windows', function(display, screen, window, binding) {
        let tabPopup = new AltTabPopup();
        let modifiers = binding.get_modifiers();
        let backwards = modifiers & Meta.VirtualModifier.SHIFT_MASK;
        tabPopup.show(backwards, binding.get_name(), binding.get_mask());
    });
}

function disable() {
    Meta.keybindings_set_custom_handler('switch-windows',
        Lang.bind(Main.wm, Main.wm._startAppSwitcher));
}
