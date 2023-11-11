const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();
const Settings = Extension.imports.settings;
const Utils = Extension.imports.utils;
const Lib = Extension.imports.lib;
const Workspace = Extension.imports.workspace;
const Gestures = Extension.imports.gestures;
const Navigator = Extension.imports.navigator;
const Grab = Extension.imports.grab;
const TopBar = Extension.imports.topbar;
const Scratch = Extension.imports.scratch;
const Easer = Extension.imports.utils.easer;
const StackOverlay = Extension.imports.stackoverlay;
const ClickOverlay = StackOverlay.ClickOverlay;

const { Clutter, St, Graphene, Meta, Gio, GDesktopEnums } = imports.gi;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Signals = imports.signals;
const Background = imports.ui.background;


const workspaceManager = global.workspace_manager;
const display = global.display;

/** @type {Spaces} */
var spaces; // export

let borderWidth = 8;

// Mutter prevints windows from being placed further off the screen than 75 pixels.
var stack_margin = 75; // export

// Some features use this to determine if to sizes is considered equal. ie. `abs(w1 - w2) < sizeSlack`
let sizeSlack = 30;

var PreviewMode = { NONE: 0, STACK: 1, SEQUENTIAL: 2 }; // export
var inPreview = PreviewMode.NONE; // export

// DEFAULT mode is normal/original PaperWM window focus behaviour
var FocusModes = { DEFAULT: 0, CENTER: 1 }; // export

// window sizing direction
var CycleWindowSizesDirection = { FORWARD: 0, BACKWARDS: 1 };

/**
   Scrolled and tiled per monitor workspace.

   The tiling is composed of an array of columns. A column being an array of
   MetaWindows. Ie. the type being [[MetaWindow]].

   A Space also contains a visual representation of the tiling. The structure is
   currently like this:

   A @clip actor which spans the monitor and clips all its contents to the
   monitor. The clip lives along side all other space's clips in an actor
   spanning the whole global.workspaceManager

   An @actor to hold everything that's visible, it contains a @background,
   a @label and a @cloneContainer.

   The @cloneContainer holds clones of all the tiled windows, it's clipped
   by @cloneClip to avoid protruding into neighbouringing monitors.

   The @border surrounds the outside of the monitor so is only visible when
   using the workspace carousel.

   Clones are necessary due to restrictions mutter places on MetaWindowActors.
   WindowActors can only live in the `global.window_group` and can't be
   moved reliably outside the monitor. We create a Clutter.Clone for every window which
   live in @cloneContainer to avoid these problems. Scrolling to a window in
   the tiling is then done by simply moving the @cloneContainer.

   While eg. animating the cloneContainer WindowActors are all hidden, while the
   clones are shown. When animation is done, the MetaWindows are moved to their
   correct position and the WindowActors are shown.

   The clones are also useful when constructing the workspace stack as it's
   easier to scale and move the whole @actor in one go.

   # Coordinate system

   MetaWindows live in the stage (global) coordinate system. NB: This system
   covers all monitors - a window positioned top-left in a monitor might have
   non-zero coordinates.

   The space (technically the @clip) has it's own coordinate system relative to
   its monitor. Ie. 0,0 is the top-left corner of the monitor.

   To transform a stage point to space coordinates: `space.actor.transform_stage_point(aX, aY)`
 */
var Space = class Space extends Array {
    /** @type {import('@gi-types/clutter10').Actor} */
    actor;

    /** @type {import('@gi-types/meta').BackgroundActor} */
    background;

    constructor (workspace, container, doInit) {
        super(0);
        this.workspace = workspace;
        this.signals = new Utils.Signals();

        // windows that should be represented by their WindowActor
        this.visible = [];
        this._floating = [];
        this._populated = false;

        // default focusMode (can be overriden by saved user pref in Space.init method)
        this.focusMode = FocusModes.DEFAULT;
        this.focusModeIcon = new TopBar.FocusIcon({
            name: 'panel',
            style_class: 'space-focus-mode-icon',
        })
            .setClickFunction(() => {
                switchToNextFocusMode(this);
            })
            .setVisible(false); // hide by default
        this.showFocusModeIcon();
        this.unfocusXPosition = null; // init

        let clip = new Clutter.Actor({ name: "clip" });
        this.clip = clip;
        let actor = new Clutter.Actor({ name: "space-actor" });

        this._visible = true;
        this.hide(); // We keep the space actor hidden when inactive due to performance

        this.actor = actor;
        let cloneClip = new Clutter.Actor({ name: "clone-clip" });
        this.cloneClip = cloneClip;
        let cloneContainer = new St.Widget({ name: "clone-container" });
        this.cloneContainer = cloneContainer;

        let workspaceIndicator = new St.Widget({
            reactive: true,
            name: 'panel',
            style_class: 'space-workspace-indicator',
        });
        workspaceIndicator.connect('button-press-event', () => Main.overview.toggle());
        this.workspaceIndicator = workspaceIndicator;
        let workspaceLabel = new St.Label();
        workspaceIndicator.add_actor(workspaceLabel);
        this.workspaceLabel = workspaceLabel;
        workspaceLabel.hide();

        let selection = new St.Widget({
            name: 'selection',
            style_class: 'paperwm-selection tile-preview',
        });
        this.selection = selection;

        clip.space = this;
        cloneContainer.space = this;

        container.add_actor(clip);
        clip.add_actor(actor);
        actor.add_actor(workspaceIndicator);
        actor.add_child(this.focusModeIcon);
        actor.add_actor(cloneClip);
        cloneClip.add_actor(cloneContainer);

        this.border = new St.Widget({ name: "border" });
        this.actor.add_actor(this.border);
        this.border.hide();

        let monitor = Main.layoutManager.primaryMonitor;
        let prevSpace = saveState.prevSpaces.get(workspace);
        this.targetX = 0;
        if (prevSpace && prevSpace.monitor) {
            let prevMonitor = Main.layoutManager.monitors[prevSpace.monitor.index];
            if (prevMonitor)
                monitor = prevMonitor;
        }

        this.setSettings(Workspace.getWorkspaceSettings(this.index));
        actor.set_pivot_point(0.5, 0);

        this.selectedWindow = null;
        this.leftStack = 0; // not implemented
        this.rightStack = 0; // not implemented

        this.windowPositionBarBackdrop = new St.Widget({
            name: 'windowPositionBarBackdrop',
            style_class: 'paperwm-window-position-bar-backdrop',
        });
        this.windowPositionBar = new St.Widget({
            name: 'windowPositionBar',
            style_class: 'paperwm-window-position-bar tile-preview',
        });
        this.windowPositionBar.hide(); // default on empty space
        Utils.actor_raise(this.windowPositionBar);
        if (Settings.prefs.show_window_position_bar) {
            this.enableWindowPositionBar();
        }

        // now set monitor for this space
        this.setMonitor(monitor);

        if (doInit)
            this.init();
    }

    init() {
        if (this._populated || Main.layoutManager._startingUp)
            return;

        let workspace = this.workspace;
        let prevSpace = saveState.getPrevSpaceByUUID(this.uuid);
        console.info(`restore by uuid: ${this.uuid}, prevSpace name: ${prevSpace?.name}`);
        this.addAll(prevSpace);
        saveState.prevSpaces.delete(workspace);
        this._populated = true;

        // init window position bar and space topbar elements
        this.windowPositionBarBackdrop.height = TopBar.panelBox.height;
        this.setSpaceTopbarElementsVisible();

        // apply default focus mode
        setFocusMode(getDefaultFocusMode(), this);

        this.getWindows().forEach(w => {
            animateWindow(w);
        });

        this.layout(false);

        this.signals.connect(workspace, "window-added", (ws, metawindow) => add_handler(ws, metawindow));
        this.signals.connect(workspace, "window-removed", (ws, metawindow) => remove_handler(ws, metawindow));
        this.signals.connect(Main.overview, 'showing', this.startAnimate.bind(this));
        this.signals.connect(Main.overview, 'hidden', () => {
            if (!spaces.isActiveSpace(this)) {
                return;
            }
            // warp pointer to monitor that is active
            Utils.warpPointerToMonitor(this.monitor);
            Utils.later_add(Meta.LaterType.IDLE, () => {
                this.moveDone(() => {
                    ensureViewport(display.focus_window, this, { moveto: true, force: true });
                });
            });
        });

        this.signals.connect(gsettings, 'changed::default-focus-mode', () => {
            setFocusMode(getDefaultFocusMode(), this);
        });

        // update space elements when in/out of fullscreen
        this.signals.connect(global.display, 'in-fullscreen-changed', () => {
            this.setSpaceTopbarElementsVisible(true);
        });

        const settings = ExtensionUtils.getSettings();
        this.signals.connect(interfaceSettings, "changed::color-scheme", this.updateBackground.bind(this));
        this.signals.connect(settings, 'changed::default-background', this.updateBackground.bind(this));
        this.signals.connect(settings, 'changed::use-default-background', this.updateBackground.bind(this));
        this.signals.connect(backgroundSettings, 'changed::picture-uri', this.updateBackground.bind(this));
        this.signals.connect(backgroundSettings, "changed::picture-uri-dark", this.updateBackground.bind(this));
    }

    /**
     * Returns the space index (which is equivalent to the workspace index).
     */
    get index() {
        return this.workspace.index();
    }

    /**
     * Activates this space. Safer alternative to space.workspace.activate.  Also allows
     * setting animation on workspaceSwitch.
     * @param {Boolean} animate
     */
    activate(defaultAnimation = true, paperwmAnimation = false) {
        spaces.space_defaultAnimation = defaultAnimation;
        spaces.space_paperwmAnimation = paperwmAnimation;

        this.workspace.activate(global.get_current_time());

        spaces.space_defaultAnimation = true;
        spaces.space_paperwmAnimation = false; // switch to default
    }

    /**
     * Activates this space. Safer alternative to space.workspace.activate_with_focus. Also allows
     * setting animation on workspaceSwitch.
     * @param {Boolean} animate
     */
    activateWithFocus(metaWindow, defaultAnimation = true, paperwmAnimation = false) {
        spaces.space_defaultAnimation = defaultAnimation;
        spaces.space_paperwmAnimation = paperwmAnimation;

        if (metaWindow) {
            this.workspace.activate_with_focus(metaWindow, global.get_current_time());
        }
        else {
            this.workspace.activate(global.get_current_time());
        }
        spaces.space_defaultAnimation = true;
        spaces.space_paperwmAnimation = false; // switch to default
    }

    show() {
        if (this._visible)
            return;
        this._visible = true;
        this.clip.show();
        for (let col of this) {
            for (let w of col) {
                let actor = w.get_compositor_private();
                w.clone.cloneActor.source = actor;
            }
        }
    }

    hide() {
        if (!this._visible)
            return;
        this._visible = false;
        this.clip.hide();
        for (let col of this)
            for (let w of col)
                w.clone.cloneActor.source = null;
    }

    workArea() {
        let workArea = Main.layoutManager.getWorkAreaForMonitor(this.monitor.index);
        workArea.x -= this.monitor.x;
        workArea.y -= this.monitor.y;
        workArea.height -= Settings.prefs.vertical_margin + Settings.prefs.vertical_margin_bottom;
        workArea.y += Settings.prefs.vertical_margin;
        return workArea;
    }

    layoutGrabColumn(column, x, y0, targetWidth, availableHeight, time, grabWindow) {
        let space = this;
        let needRelayout = false;

        function mosh(windows, height, y0) {
            let targetHeights = fitProportionally(
                windows.map(mw => mw.get_frame_rect().height),
                height
            );
            let [w, relayout, y] = space.layoutColumnSimple(windows, x, y0, targetWidth, targetHeights, time);
            needRelayout = needRelayout || relayout;
            return y;
        }

        const k = column.indexOf(grabWindow);
        if (k < 0) {
            throw new Error(`Anchor doesn't exist in column ${grabWindow.title}`);
        }

        const gap = Settings.prefs.window_gap;
        const f = grabWindow.get_frame_rect();
        let yGrabRel = f.y - this.monitor.y;
        targetWidth = f.width;

        const H1 = (yGrabRel - y0) - gap - (k - 1) * gap;
        const H2 = availableHeight - (yGrabRel + f.height - y0) - gap - (column.length - k - 2) * gap;
        k > 0 && mosh(column.slice(0, k), H1, y0);
        let y = mosh(column.slice(k, k + 1), f.height, yGrabRel);
        k + 1 < column.length && mosh(column.slice(k + 1), H2, y);

        return [targetWidth, needRelayout];
    }

    layoutColumnSimple(windows, x, y0, targetWidth, targetHeights, time) {
        let space = this;
        let y = y0;

        let widthChanged = false;
        let heightChanged = false;

        for (let i = 0; i < windows.length; i++) {
            let mw = windows[i];
            let targetHeight = targetHeights[i];

            let f = mw.get_frame_rect();

            let resizable = !mw.fullscreen &&
                mw.get_maximized() !== Meta.MaximizeFlags.BOTH;

            if (mw.preferredWidth) {
                let prop = mw.preferredWidth;
                if (prop.value <= 0) {
                    console.warn("invalid preferredWidth value");
                }
                else if (prop.unit == 'px') {
                    targetWidth = prop.value;
                }
                else if (prop.unit == '%') {
                    let availableWidth = space.workArea().width - Settings.prefs.horizontal_margin * 2 - Settings.prefs.window_gap;
                    targetWidth = Math.floor(availableWidth * Math.min(prop.value / 100.0, 1.0));
                }
                else {
                    console.warn("invalid preferredWidth unit:", `'${prop.unit}'`, "(should be 'px' or '%')");
                }
            }

            if (resizable) {
                const hasNewTarget = mw._targetWidth !== targetWidth || mw._targetHeight !== targetHeight;
                const targetReached = f.width === targetWidth && f.height === targetHeight;

                // Update targets (NB: must happen before resize request)
                mw._targetWidth = targetWidth;
                mw._targetHeight = targetHeight;

                if (!targetReached && hasNewTarget) {
                    // Explanation for `hasNewTarget` check in commit message
                    mw.move_resize_frame(true, f.x, f.y, targetWidth, targetHeight);
                }
            } else {
                mw.move_frame(true, space.monitor.x, space.monitor.y);
                targetWidth = f.width;
                targetHeight = f.height;
            }
            if (mw.maximized_vertically) {
                // NOTE: This should really be f.y - monitor.y, but eg. firefox
                // on wayland reports the wrong y coordinates at this point.
                y -= Settings.prefs.vertical_margin;
            }

            // When resize is synchronous, ie. for X11 windows
            let nf = mw.get_frame_rect();
            if (nf.width !== targetWidth && nf.width !== f.width) {
                widthChanged = true;
            }
            if (nf.height !== targetHeight && nf.height !== f.height) {
                heightChanged = true;
                targetHeight = nf.height; // Use actually height for layout
            }

            let c = mw.clone;
            if (c.x !== x || c.targetX !== x ||
                c.y !== y || c.targetY !== y) {
                // console.debug("  Position window", mw.title, `y: ${c.targetY} -> ${y} x: ${c.targetX} -> ${x}`);
                c.targetX = x;
                c.targetY = y;
                if (time === 0) {
                    c.x = x;
                    c.y = y;
                } else {
                    Easer.addEase(c, {
                        x, y,
                        time,
                        onComplete: this.moveDone.bind(this),
                    });
                }
            }

            y += targetHeight + Settings.prefs.window_gap;
        }
        return [targetWidth, widthChanged || heightChanged, y];
    }

    layout(animate = true, options = {}) {
        // Guard against recursively calling layout
        if (!this._populated)
            return;
        if (this._inLayout)
            return;
        this._inLayout = true;
        this.startAnimate();

        let time = Settings.prefs.animation_time;
        let gap = Settings.prefs.window_gap;
        let x = 0;
        let selectedIndex = this.selectedIndex();
        let workArea = this.workArea();

        // Happens on monitors-changed
        if (workArea.width === 0) {
            this._inLayout = false;
            return;
        }

        // compensate to keep window position bar on all monitors
        if (Settings.prefs.show_window_position_bar) {
            const panelBoxHeight = TopBar.panelBox.height;
            const monitor = Main.layoutManager.primaryMonitor;
            if (monitor !== this.monitor) {
                workArea.y += panelBoxHeight;
                workArea.height -= panelBoxHeight;
            }
        }

        let availableHeight = workArea.height;
        let y0 = workArea.y;
        let fixPointAttempCount = 0;

        for (let i = 0; i < this.length; i++) {
            let column = this[i];
            // Actorless windows are trouble. Layout could conceivable run while a window is dying or being born.
            column = column.filter(mw => mw.get_compositor_private());
            if (column.length === 0)
                continue;

            let selectedInColumn = i === selectedIndex ? this.selectedWindow : null;

            let targetWidth;
            if (i === selectedIndex) {
                targetWidth = selectedInColumn.get_frame_rect().width;
            } else {
                targetWidth = Math.max(...column.map(w => w.get_frame_rect().width));
            }
            targetWidth = Math.min(targetWidth, workArea.width - 2 * Settings.prefs.minimum_margin);

            let resultingWidth, relayout;
            let allocator = options.customAllocators && options.customAllocators[i];
            if (inGrab && column.includes(inGrab.window) && !allocator) {
                [resultingWidth, relayout] =
                    this.layoutGrabColumn(column, x, y0, targetWidth, availableHeight, time,
                        selectedInColumn);
            } else {
                allocator = allocator || allocateDefault;
                let targetHeights = allocator(column, availableHeight, selectedInColumn);
                [resultingWidth, relayout] =
                    this.layoutColumnSimple(column, x, y0, targetWidth, targetHeights, time);
            }

            if (relayout) {
                if (fixPointAttempCount < 5) {
                    i--;
                    fixPointAttempCount++;
                    continue;
                } else {
                    console.warn("Bail at fixpoint, max tries reached");
                }
            }

            x += resultingWidth + gap;
        }
        this._inLayout = false;

        let oldWidth = this.cloneContainer.width;
        let min = workArea.x;
        let auto = (this.targetX + oldWidth >= min + workArea.width && this.targetX <= 0) ||
            this.targetX === min + Math.round((workArea.width - oldWidth) / 2);

        // transforms break on width 1
        let width = Math.max(1, x - gap);
        this.cloneContainer.width = width;

        if (auto && animate) {
            if (width < workArea.width) {
                this.targetX = min + Math.round((workArea.width - width) / 2);
            } else if (this.targetX + width < min + workArea.width) {
                this.targetX = min + workArea.width - width;
            } else if (this.targetX > workArea.min ) {
                this.targetX = workArea.x;
            }
            Easer.addEase(this.cloneContainer,
                {
                    x: this.targetX,
                    time,
                    onComplete: this.moveDone.bind(this),
                });
        }
        if (animate) {
            ensureViewport(this.selectedWindow, this);
        } else {
            this.moveDone();
        }

        this.emit('layout', this);
    }

    queueLayout(animate = true) {
        if (this._layoutQueued)
            return;

        this._layoutQueued = true;
        Utils.later_add(Meta.LaterType.RESIZE, () => {
            this._layoutQueued = false;
            this.layout(animate);
        });
    }

    // Space.prototype.isVisible = function
    isVisible(metaWindow, margin = 0) {
        let clone = metaWindow.clone;
        let x = clone.x + this.cloneContainer.x;
        let workArea = this.workArea();
        let min = workArea.x;

        if (x - margin + clone.width < min ||
            x + margin > min + workArea.width) {
            return false;
        } else {
            return true;
        }
    }

    isFullyVisible(metaWindow) {
        let clone = metaWindow.clone;
        let x = this.visibleX(metaWindow);
        let workArea = this.workArea();
        let min = workArea.x;

        return min <= x && x + clone.width < min + workArea.width;
    }

    visibleRatio(metaWindow) {
        let clone = metaWindow.clone;
        let x = this.visibleX(metaWindow);
        let workArea = this.workArea();
        let min = workArea.x;
        return min <= x && x + clone.width < min + workArea.width;
    }

    isPlaceable(metaWindow) {
        let clone = metaWindow.clone;
        let x = this.visibleX(metaWindow);
        let workArea = Main.layoutManager.getWorkAreaForMonitor(this.monitor.index);
        let min = workArea.x - this.monitor.x;

        if (x + clone.width < min + stack_margin ||
            x > min + workArea.width - stack_margin) {
            return false;
        } else {
            // Fullscreen windows are only placeable on the monitor origin
            if ((metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH && x !== min) ||
                (metaWindow.fullscreen && x !== 0)) {
                return false;
            }
            return true;
        }
    }

    getWindows() {
        return this.reduce((ws, column) => ws.concat(column), []);
    }

    getWindow(index, row) {
        if (row < 0 || index < 0 || index >= this.length)
            return false;

        let column = this[index];
        if (row >= column.length)
            return false;
        return column[row];
    }

    isWindowAtPoint(metaWindow, x, y) {
        let clone = metaWindow.clone;
        let wX = clone.x + this.cloneContainer.x;
        return x >= wX && x <= wX + clone.width &&
            y >= clone.y && y <= clone.y + clone.height;
    }

    getWindowAtPoint(x, y) {
        for (let column of this) {
            for (let w of column) {
                if (this.isWindowAtPoint(w, x, y))
                    return w;
            }
        }
        return null;
    }

    addWindow(metaWindow, index, row) {
        if (!this.selectedWindow)
            this.selectedWindow = metaWindow;
        if (this.indexOf(metaWindow) !== -1)
            return false;

        if (row !== undefined && this[index]) {
            let column = this[index];
            column.splice(row, 0, metaWindow);
        } else {
            this.splice(index, 0, [metaWindow]);
        }

        /*
         * Fix (still needed is 44) for bug where move_frame sometimes triggers
         * another move back to its original position. Make sure tiled windows are
         * always positioned correctly.
         */
        this.signals.connect(metaWindow, 'position-changed', w => {
            if (inGrab)
                return;
            let f = w.get_frame_rect();
            let clone = w.clone;
            let x = this.visibleX(w);
            let y = this.monitor.y + clone.targetY;
            x = Math.min(this.width - stack_margin, Math.max(stack_margin - f.width, x));
            x += this.monitor.x;
            if (f.x !== x || f.y !== y) {
                try {
                    w.move_frame(true, x, y);
                }
                catch (ex) {

                }
            }
        });

        Utils.actor_reparent(metaWindow.clone, this.cloneContainer);

        // Make sure the cloneContainer is in a clean state (centered) before layout
        if (this.length === 1) {
            let workArea = this.workArea();
            this.targetX = workArea.x + Math.round((workArea.width - this.cloneContainer.width) / 2);
        }
        this.emit('window-added', metaWindow, index, row);
        return true;
    }

    removeWindow(metaWindow) {
        let index = this.indexOf(metaWindow);
        if (index === -1)
            return this.removeFloating(metaWindow);

        this.signals.disconnect(metaWindow);

        if (this.selectedWindow === metaWindow) {
            // Select a new window using the stack ordering;
            let windows = this.getWindows();
            let i = windows.indexOf(metaWindow);
            let neighbours = [windows[i - 1], windows[i + 1]].filter(w => w);
            let stack = sortWindows(this, neighbours);
            this.selectedWindow = stack[stack.length - 1];
        }

        let column = this[index];
        let row = column.indexOf(metaWindow);
        column.splice(row, 1);
        if (column.length === 0)
            this.splice(index, 1);

        this.visible.splice(this.visible.indexOf(metaWindow), 1);

        let clone = metaWindow.clone;
        this.cloneContainer.remove_actor(clone);
        // Don't destroy the selection highlight widget
        if (clone.first_child.name === 'selection')
            clone.remove_actor(clone.first_child);
        let actor = metaWindow.get_compositor_private();
        if (actor)
            actor.remove_clip();

        this.layout();
        if (this.selectedWindow) {
            ensureViewport(this.selectedWindow, this);
        } else {
            // can also be undefined here, will set to null explicitly
            this.selectedWindow = null;
        }

        this.emit('window-removed', metaWindow, index, row);
        return true;
    }

    isFloating(metaWindow) {
        return this._floating.indexOf(metaWindow) !== -1;
    }

    addFloating(metaWindow) {
        if (this._floating.indexOf(metaWindow) !== -1 ||
            metaWindow.is_on_all_workspaces())
            return false;
        this._floating.push(metaWindow);
        let clone = metaWindow.clone;
        Utils.actor_reparent(clone, this.actor);
        return true;
    }

    removeFloating(metaWindow) {
        let i = this._floating.indexOf(metaWindow);
        if (i === -1)
            return false;
        this._floating.splice(i, 1);
        this.actor.remove_actor(metaWindow.clone);
        return true;
    }

    /**
     * Returns true iff this space has a currently fullscreened window.
     */
    hasFullScreenWindow() {
        return this.getWindows().some(el => el.fullscreen);
    }

    swap(direction, metaWindow) {
        metaWindow = metaWindow || this.selectedWindow;

        let [index, row] = this.positionOf(metaWindow);
        let targetIndex = index;
        let targetRow = row;
        switch (direction) {
        case Meta.MotionDirection.LEFT:
            targetIndex--;
            break;
        case Meta.MotionDirection.RIGHT:
            targetIndex++;
            break;
        case Meta.MotionDirection.DOWN:
            targetRow++;
            break;
        case Meta.MotionDirection.UP:
            targetRow--;
            break;
        }
        let column = this[index];
        if (targetIndex < 0 || targetIndex >= this.length ||
            targetRow < 0 || targetRow >= column.length)
            return;

        Lib.swap(this[index], row, targetRow);
        Lib.swap(this, index, targetIndex);

        this.layout();
        this.emit('swapped', index, targetIndex, row, targetRow);
        ensureViewport(this.selectedWindow, this, { force: true });
    }

    switchLinear(dir) {
        let index = this.selectedIndex();
        let column = this[index];
        if (!column)
            return false;
        let row = column.indexOf(this.selectedWindow);
        if (Lib.in_bounds(column, row + dir) == false) {
            index += dir;
            if (dir === 1) {
                if (index < this.length)
                    row = 0;
            } else if (index >= 0)
                row = this[index].length - 1;
        } else {
            row += dir;
        }

        let metaWindow = this.getWindow(index, row);
        ensureViewport(metaWindow, this);
        return true;
    }

    switchLeft() { this.switch(Meta.MotionDirection.LEFT); }
    switchRight() { this.switch(Meta.MotionDirection.RIGHT); }
    switchUp() { this.switch(Meta.MotionDirection.UP); }
    switchDown() { this.switch(Meta.MotionDirection.DOWN); }
    switch(direction) {
        let space = this;
        let index = space.selectedIndex();
        if (index === -1) {
            return;
        }
        let row = space[index].indexOf(space.selectedWindow);
        switch (direction) {
        case Meta.MotionDirection.RIGHT:
            index++;
            row = -1;
            break;
        case Meta.MotionDirection.LEFT:
            index--;
            row = -1;
        }
        if (index < 0 || index >= space.length)
            return;

        let column = space[index];

        if (row === -1) {
            let selected =
                sortWindows(this, column)[column.length - 1];
            row = column.indexOf(selected);
        }

        switch (direction) {
        case Meta.MotionDirection.UP:
            row--;
            break;
        case Meta.MotionDirection.DOWN:
            row++;
        }
        if (row < 0 || row >= column.length)
            return;

        let metaWindow = space.getWindow(index, row);
        ensureViewport(metaWindow, space);
    }

    /**
     * Return the x position of the visible element of this window.
     */
    visibleX(metaWindow) {
        return metaWindow.clone.targetX + this.targetX;
    }

    /**
     * Return the y position of the visible element of this window.
     */
    visibleY(metaWindow) {
        return metaWindow.clone.targetY + this.monitor.y;
    }

    positionOf(metaWindow) {
        metaWindow = metaWindow || this.selectedWindow;
        for (let i = 0; i < this.length; i++) {
            if (this[i].includes(metaWindow))
                return [i, this[i].indexOf(metaWindow)];
        }
        return false;
    }

    indexOf(metaWindow) {
        for (let i = 0; i < this.length; i++) {
            if (this[i].includes(metaWindow))
                return i;
        }
        return -1;
    }

    rowOf(metaWindow) {
        let column = this[this.indexOf(metaWindow)];
        return column.indexOf(metaWindow);
    }

    globalToViewport(gx, gy) {
        let [ok, vx, vy] = this.actor.transform_stage_point(gx, gy);
        return [Math.round(vx), Math.round(vy)];
    }

    /** Transform global coordinates to scroll cooridinates (cloneContainer relative) */
    globalToScroll(gx, gy, { useTarget = false } = {}) {
        // Use the smart transform on the actor, as that's the one we scale etc.
        // We can then use straight translation on the scroll which makes it possible to use target instead if wanted.
        let [vx, vy] = this.globalToViewport(gx, gy);
        let sx = vx - (useTarget ? this.targetX : this.cloneContainer.x);
        let sy = vy - this.cloneContainer.y;
        return [Math.round(sx), Math.round(sy)];
    }

    viewportToScroll(vx, vy = 0) {
        return [vx - this.cloneContainer.x, vy - this.cloneContainer.y];
    }

    /**
     * Moves the space viewport to position x.
     * @param {Number} x
     */
    viewportMoveToX(x, animate = true) {
        this.targetX = x;
        this.cloneContainer.x = x;
        this.startAnimate();
        if (animate) {
            Easer.addEase(this.cloneContainer,
                {
                    x,
                    time: Settings.prefs.animation_time,
                    onComplete: this.moveDone.bind(this),
                });
        }
        else {
            this.moveDone.bind(this);
        }
    }

    moveDone(focusedWindowCallback = focusedWindow => {}) {
        if (this.cloneContainer.x !== this.targetX ||
            this.actor.y !== 0 ||
            Navigator.navigating || inPreview ||
            Main.overview.visible ||
            // Block when we're carrying a window in dnd
            (inGrab && inGrab.window)
        ) {
            return;
        }

        this.visible = [];
        const monitor = this.monitor;
        this.getWindows().forEach(w => {
            let actor = w.get_compositor_private();
            if (!actor)
                return;

            let placeable = this.isPlaceable(w);
            if (placeable)
                this.visible.push(w);

            // Guard against races between move_to and layout
            // eg. moving can kill ongoing resize on wayland
            if (Easer.isEasing(w.clone))
                return;

            let unMovable = w.fullscreen ||
                w.get_maximized() === Meta.MaximizeFlags.BOTH;
            if (unMovable)
                return;

            let f = w.get_frame_rect();
            let x = this.visibleX(w);
            let y = this.visibleY(w);
            x = Math.max(stack_margin - f.width, x);
            x = Math.min(this.width - stack_margin, x);
            x += monitor.x;
            // let b = w.get_frame_rect();
            if (f.x !== x || f.y !== y) {
                w.move_frame(true, x, y);
            }
        });

        this.visible.forEach(w => {
            if (Easer.isEasing(w.clone))
                return;
            let actor = w.get_compositor_private();

            // The actor's width/height is not correct right after resize
            let b = w.get_buffer_rect();
            const x = monitor.x - b.x;
            const y = monitor.y - b.y;
            const cw = monitor.width;
            const ch = monitor.height;
            actor.set_clip(x, y, cw, ch);

            showWindow(w);
        });

        this._floating.forEach(showWindow);

        this.fixOverlays();

        if (!Meta.is_wayland_compositor()) {
            // See startAnimate
            Main.layoutManager.untrackChrome(this.background);
        }

        this._isAnimating = false;

        if (this.selectedWindow && this.selectedWindow === display.focus_window) {
            let index = this.indexOf(this.selectedWindow);
            this[index].forEach(w => w.lastFrame = w.get_frame_rect());

            // callback on display.focusWindow window
            focusedWindowCallback(display.focus_window);
        }

        this.emit('move-done');
    }

    startAnimate() {
        if (!this._isAnimating && !Meta.is_wayland_compositor()) {
            // Tracking the background fixes issue #80
            // It also let us activate window clones clicked during animation
            // Untracked in moveDone
            Main.layoutManager.trackChrome(this.background);
        }

        this.visible.forEach(w => {
            let actor = w.get_compositor_private();
            if (!actor)
                return;
            actor.remove_clip();
            if (inGrab && inGrab.window === w)
                return;
            animateWindow(w);
        });

        this._floating.forEach(w => {
            let f = w.get_frame_rect();
            if (!animateWindow(w))
                return;
            w.clone.x = f.x - this.monitor.x;
            w.clone.y = f.y - this.monitor.y;
        });

        this._isAnimating = true;
    }

    fixOverlays(metaWindow) {
        metaWindow = metaWindow || this.selectedWindow;
        let index = this.indexOf(metaWindow);
        let target = this.targetX;
        this.monitor.clickOverlay.reset();
        for (let overlay = this.monitor.clickOverlay.right,
            n = index + 1; n < this.length; n++) {
            let metaWindow = this[n][0];
            let clone = metaWindow.clone;
            let x = clone.targetX + target;
            if (!overlay.target && x + clone.width > this.width) {
                overlay.setTarget(this, n);
                break;
            }
        }

        for (let overlay = this.monitor.clickOverlay.left,
            n = index - 1; n >= 0; n--) {
            let metaWindow = this[n][0];
            let clone = metaWindow.clone;
            let x = clone.targetX + target;
            if (!overlay.target && x < 0) {
                overlay.setTarget(this, n);
                break;
            }
        }
    }

    hideSelection() {
        this.selection.set_style_class_name('background-clear');
    }

    showSelection() {
        this.selection.set_style_class_name('paperwm-selection tile-preview');
    }

    setSelectionActive() {
        this.selection.opacity = 255;
    }

    setSelectionInactive() {
        this.selection.opacity = 140;
    }

    setSettings([uuid, settings]) {
        this.signals.disconnect(this.settings);

        this.settings = settings;
        this.uuid = uuid;
        if (this.background) {
            this.updateColor();
            this.updateBackground();
        }
        this.updateName();
        this.updateShowTopBar();
        this.signals.connect(this.settings, 'changed::name', this.updateName.bind(this));
        this.signals.connect(gsettings, 'changed::use-workspace-name',
            this.updateName.bind(this));
        this.signals.connect(this.settings, 'changed::color',
            this.updateColor.bind(this));
        this.signals.connect(this.settings, 'changed::background',
            this.updateBackground.bind(this));
        this.signals.connect(gsettings, 'changed::default-show-top-bar',
            this.showTopBarChanged.bind(this));
        this.signals.connect(this.settings, 'changed::show-top-bar',
            this.showTopBarChanged.bind(this));
    }

    /**
     * Returns the user show-top-bar setting if it exists, otherwise returns the
     * default-show-top-bar setting.
     * @returns Boolean
     */
    getShowTopBarSetting() {
        let showTopBar = Settings.prefs.default_show_top_bar;
        let userValue = this.settings.get_user_value('show-top-bar');
        if (userValue) {
            showTopBar = userValue.unpack();
        }

        return showTopBar;
    }

    showTopBarChanged() {
        let showTopBar = this.getShowTopBarSetting();

        // remove window position bar actors
        this.actor.remove_actor(this.windowPositionBarBackdrop);
        this.actor.remove_actor(this.windowPositionBar);
        if (showTopBar) {
            this.actor.add_actor(this.windowPositionBarBackdrop);
            this.actor.add_actor(this.windowPositionBar);
        }

        this.updateShowTopBar();
    }

    updateShowTopBar() {
        let showTopBar = this.getShowTopBarSetting();

        if (showTopBar) {
            this.showTopBar = 1;
        } else {
            this.showTopBar = 0;
        }
        this._populated && TopBar.fixTopBar();

        this.layout();
    }

    /**
     * Returns true if this space has the topbar.
     */
    get hasTopBar() {
        return this.monitor && this.monitor === TopBar.panelMonitor();
    }

    updateColor() {
        let color = this.settings.get_string('color');
        if (color === '') {
            let colors = Settings.prefs.workspace_colors;
            let index = this.index % Settings.prefs.workspace_colors.length;
            color = colors[index];
        }
        this.color = color;
        this.border.set_style(`
border: ${borderWidth}px ${this.color};
border-radius: ${borderWidth}px;
`);
        this.metaBackground?.set_color(Clutter.color_from_string(color)[1]);
    }

    updateBackground() {
        let path = this.settings.get_string('background') || Settings.prefs.default_background;
        let useDefault = gsettings.get_boolean('use-default-background');
        if (!path && useDefault) {
            if (interfaceSettings.get_string("color-scheme") === "default") {
                path = backgroundSettings.get_string("picture-uri");
            } else {
                path = backgroundSettings.get_string("picture-uri-dark");
            }
        }

        // destroy old background
        this.metaBackground?.destroy();
        this.metaBackground = null;

        this.metaBackground = new Background.Background({
            monitorIndex: this.monitor.index,
            layoutManager: Main.layoutManager,
            settings: backgroundSettings,
            file: Gio.File.new_for_commandline_arg(path),
            style: GDesktopEnums.BackgroundStyle.ZOOM,
        });

        this.background.content.set({
            background: this.metaBackground,
        });
    }

    updateName() {
        if (Settings.prefs.use_workspace_name) {
            this.workspaceLabel.show();
        } else {
            this.workspaceLabel.hide();
        }
        let name = Workspace.getWorkspaceName(this.settings, this.index);
        Meta.prefs_change_workspace_name(this.index, name);
        this.workspaceLabel.text = name;
        this.name = name;

        if (this.workspace === workspaceManager.get_active_workspace()) {
            TopBar.updateWorkspaceIndicator(this.index);
        }
    }

    /**
     * Enables or disables this space's window position bar.
     * @param {boolean} enable
     */
    enableWindowPositionBar(enable = true) {
        if (enable) {
            [this.windowPositionBarBackdrop, this.windowPositionBar]
                .forEach(i => this.actor.add_actor(i));
            this.updateWindowPositionBar();
        }
        else {
            [this.windowPositionBarBackdrop, this.windowPositionBar]
                .forEach(i => this.actor.remove_actor(i));
        }
    }

    /**
     * Shows or hides this space's window position bar. Useful for temporarily
     * hiding the position bar (e.g. for fullscreen mode).
     * @param {boolean} show
     */
    showWindowPositionBar(show = true) {
        if (show) {
            [this.windowPositionBarBackdrop, this.windowPositionBar]
                .forEach(i => i.show());
        }
        else {
            [this.windowPositionBarBackdrop, this.windowPositionBar]
                .forEach(i => i.hide());
        }
    }

    updateWindowPositionBar() {
        // if pref show-window-position-bar, exit
        if (!Settings.prefs.show_window_position_bar) {
            return;
        }

        // space has a fullscreen window, hide window position bar
        if (this.hasFullScreenWindow()) {
            this.showWindowPositionBar(false);
            return;
        }
        else {
            // if here has no fullscreen window, show as per usual
            this.showWindowPositionBar();
        }

        // show space duplicate elements if not primary monitor
        if (!this.hasTopBar) {
            Utils.actor_raise(this.workspaceIndicator);
            this.workspaceLabel.show();
        }

        // number of columns (a column have one or more windows)
        let cols = this.length;
        if (cols <= 1) {
            this.windowPositionBar.hide();
            return;
        } else {
            this.windowPositionBar.show();
        }

        let width = this.monitor.width;
        this.windowPositionBarBackdrop.width = width;
        let segments = width / cols;
        this.windowPositionBar.width = segments;
        this.windowPositionBar.height = TopBar.panelBox.height;

        // index of currently selected window
        let windex = this.indexOf(this.selectedWindow);
        this.windowPositionBar.x = windex * segments;
    }

    /**
     * A space contains several elements that are duplicated (in the topbar) so that
     * they can be seen in the space "topbar" when switching workspaces. This function
     * sets these elements' visibility when not needed.
     * @param {boolean} visible
     */
    setSpaceTopbarElementsVisible(visible = false, options = {}) {
        const changeTopBarStyle = options?.changeTopBarStyle ?? true;
        const force = options?.force ?? false;
        const setVisible = v => {
            if (v) {
                this.updateSpaceIconPositions();
                this.showWorkspaceIndicator(true, force);
                this.showFocusModeIcon(true, force);
            }
            else {
                this.showWorkspaceIndicator(false, force);
                this.showFocusModeIcon(false, force);
            }
        };

        // if windowPositionBar is disabled ==> don't show elements
        if (!Settings.prefs.show_window_position_bar) {
            setVisible(false);
            return;
        }

        if (changeTopBarStyle) {
            if (visible && this.hasTopBar) {
                TopBar.setTransparentStyle();
            }
            else {
                TopBar.setNoBackgroundStyle();
            }
        }

        // if on different monitor then override to show elements
        if (!this.hasTopBar) {
            visible = true;
        }

        // don't show elements on spaces with actual TopBar (unless inPreview)
        if (this.hasTopBar && !inPreview) {
            visible = false;
        }

        // if current window is fullscreen, don't show
        if (this?.selectedWindow?.fullscreen) {
            visible = false;
        }

        setVisible(visible);
    }

    /**
    * Updates workspace topbar icon positions.
    */
    updateSpaceIconPositions() {
        // get positions of topbar elements to replicate positions in spaces
        const vertex = new Graphene.Point3D({ x: 0, y: 0 });
        const labelPosition = TopBar.menu.label.apply_relative_transform_to_point(Main.panel, vertex);
        this.workspaceLabel.set_position(labelPosition.x, labelPosition.y);

        if (Settings.prefs.show_workspace_indicator) {
            const focusPosition = TopBar.focusButton.apply_relative_transform_to_point(Main.panel, vertex);
            this.focusModeIcon.set_position(focusPosition.x, focusPosition.y);
        } else {
            // using gnome pill, set focus icon at first position
            this.focusModeIcon.set_position(0, 0);
        }
    }

    /**
     * Shows the workspace indicator space element.
     * @param {boolean} show
     */
    showWorkspaceIndicator(show = true, force = false) {
        this.updateName();
        if (show && Settings.prefs.show_workspace_indicator) {
            // if already shown then do nothing
            if (!force && this.workspaceIndicator.is_visible()) {
                return;
            }

            Utils.actor_raise(this.workspaceIndicator);
            this.workspaceIndicator.opacity = 0;
            this.workspaceIndicator.show();
            Easer.addEase(this.workspaceIndicator, {
                opacity: 255,
                time: Settings.prefs.animation_time,
            });
        } else {
            // if already shown then do nothing
            if (!force && !this.workspaceIndicator.is_visible()) {
                return;
            }

            Easer.addEase(this.workspaceIndicator, {
                opacity: 0,
                time: Settings.prefs.animation_time,
                onComplete: () => this.workspaceIndicator.hide(),
            });
        }
    }

    /**
     * Shows the focusModeIcon space element.
     * @param {boolean} show
     */
    showFocusModeIcon(show = true, force = false) {
        if (show && Settings.prefs.show_focus_mode_icon) {
            // if already shown then do nothing
            if (!force && this.focusModeIcon.is_visible()) {
                return;
            }

            Utils.actor_raise(this.focusModeIcon);
            this.focusModeIcon.opacity = 0;
            this.focusModeIcon.show();
            Easer.addEase(this.focusModeIcon, {
                opacity: 255,
                time: Settings.prefs.animation_time,
            });
        } else {
            // if already hidden then do nothing
            if (!force && !this.focusModeIcon.is_visible()) {
                return;
            }
            Easer.addEase(this.focusModeIcon, {
                opacity: 0,
                time: Settings.prefs.animation_time,
                onComplete: () => this.focusModeIcon.hide(),
            });
        }
    }

    createBackground() {
        if (this.background) {
            this.signals.disconnect(this.background);
            this.background.destroy();
        }

        let monitor = this.monitor;

        this.background = new Meta.BackgroundActor(
            Object.assign({
                name: "background",
                monitor: monitor.index,
                reactive: true, // Disable the background menu
            }, { meta_display: display })
        );

        this.actor.insert_child_below(this.background, null);

        this.signals.connect(this.background, 'button-press-event',
            (actor, event) => {
                if (inGrab) {
                    return;
                }

                /**
                 * if user clicks on window, then ensureViewport on that window before exiting
                 */
                let [gx, gy, $] = global.get_pointer();
                let [ok, x, y] = this.actor.transform_stage_point(gx, gy);
                let windowAtPoint = !Gestures.gliding && this.getWindowAtPoint(x, y);
                if (windowAtPoint) {
                    ensureViewport(windowAtPoint, this);
                }

                spaces.selectedSpace = this;
                Navigator.finishNavigation();
            });

        this.signals.connect(
            this.background, 'scroll-event',
            (actor, event) => {
                if (!inGrab && !Navigator.navigating)
                    return;
                let dir = event.get_scroll_direction();
                if (dir === Clutter.ScrollDirection.SMOOTH)
                    return;

                let [gx, gy] = event.get_coords();
                if (!gx) {
                    return;
                }

                switch (dir) {
                case Clutter.ScrollDirection.LEFT:
                case Clutter.ScrollDirection.UP:
                    this.switchLeft();
                    break;
                case Clutter.ScrollDirection.RIGHT:
                case Clutter.ScrollDirection.DOWN:
                    this.switchRight();
                    break;
                }
            });

        this.signals.connect(
            this.background, 'captured-event',
            Gestures.horizontalScroll.bind(this));
    }

    setMonitor(monitor, animate = false) {
        // Remake the background when we move monitors. The size/scale will be
        // incorrect when using fractional scaling.
        if (monitor !== this.monitor) {
            this.monitor = monitor;
            this.createBackground();
            this.updateBackground();
            this.updateColor();

            // update width of windowPositonBarBackdrop (to match monitor)
            this.windowPositionBarBackdrop.width = monitor.width;
        }

        let background = this.background;
        let clip = this.clip;

        this.width = monitor.width;
        this.height = monitor.height;

        let time = animate ? Settings.prefs.animation_time : 0;

        Easer.addEase(this.actor,
            {
                x: 0, y: 0, scale_x: 1, scale_y: 1,
                time,
            });
        Easer.addEase(clip,
            { scale_x: 1, scale_y: 1, time });

        clip.set_position(monitor.x, monitor.y);
        clip.set_size(monitor.width, monitor.height);
        clip.set_clip(0, 0,
            monitor.width,
            monitor.height);

        let scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.border.set_position(-borderWidth * scale, -borderWidth * scale);
        this.border.set_size(monitor.width + scale * borderWidth * 2,
            monitor.height + scale * borderWidth * 2);

        background.set_size(this.width, this.height);

        this.cloneClip.set_size(monitor.width, monitor.height);
        this.cloneClip.set_clip(0, 0,
            this.width, this.height);
        // transforms break if there's no height
        this.cloneContainer.height = this.monitor.height;

        this.layout();
        this.emit('monitor-changed');
    }

    /**
       Add existing windows on workspace to the space. Restore the
       layout of prevSpace if present.
    */
    addAll(prevSpace) {
        // On gnome-shell-restarts the windows are moved into the viewport, but
        // they're moved minimally and the stacking is not changed, so the tiling
        // order is preserved (sans full-width windows..)
        let xz_comparator = windows => {
            // Seems to be the only documented way to get stacking order?
            // Could also rely on the MetaWindowActor's index in it's parent
            // children array: That seem to correspond to clutters z-index (note:
            // z_position is something else)
            let z_sorted = display.sort_windows_by_stacking(windows);
            let xkey = mw => {
                let frame = mw.get_frame_rect();
                if (frame.x <= 0)
                    return 0;
                if (frame.x + frame.width === this.width) {
                    return this.width;
                }
                return frame.x;
            };
            // xorder: a|b c|d
            // zorder: a d b c
            return (a, b) => {
                let ax = xkey(a);
                let bx = xkey(b);
                // Yes, this is not efficient
                let az = z_sorted.indexOf(a);
                let bz = z_sorted.indexOf(b);
                let xcmp = ax - bx;
                if (xcmp !== 0)
                    return xcmp;

                if (ax === 0) {
                    // Left side: lower stacking first
                    return az - bz;
                } else {
                    // Right side: higher stacking first
                    return bz - az;
                }
            };
        };

        if (prevSpace) {
            for (let i = 0; i < prevSpace.length; i++) {
                let column = prevSpace[i];
                for (let j = 0; j < column.length; j++) {
                    let metaWindow = column[j];
                    // Prune removed windows
                    if (metaWindow.get_compositor_private()) {
                        this.addWindow(metaWindow, i, j);
                    } else {
                        column.splice(j, 1); j--;
                    }
                }
                if (column.length === 0) {
                    prevSpace.splice(i, 1); i--;
                }
            }
        }

        let workspace = this.workspace;
        let windows = workspace.list_windows()
            .sort(xz_comparator(workspace.list_windows()));

        windows.forEach((meta_window, i) => {
            if (meta_window.above || meta_window.minimized) {
                // Rough heuristic to figure out if a window should float
                Scratch.makeScratch(meta_window);
                return;
            }
            if (this.indexOf(meta_window) < 0 && add_filter(meta_window)) {
                this.addWindow(meta_window, this.length);
            }
        });

        let tabList = display.get_tab_list(Meta.TabList.NORMAL, workspace)
            .filter(metaWindow => { return this.indexOf(metaWindow) !== -1; });
        if (tabList[0]) {
            this.selectedWindow = tabList[0];
        }
    }

    // Fix for eg. space.map, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes#Species
    static get [Symbol.species]() { return Array; }

    selectedIndex () {
        if (this.selectedWindow) {
            return this.indexOf(this.selectedWindow);
        } else {
            return -1;
        }
    }

    destroy() {
        this.signals.destroy();
        this.signals = null;
        this.background.destroy();
        this.background = null;
        this.cloneContainer.destroy();
        this.cloneContainer = null;
        this.clip.destroy();
        this.clip = null;
    }
};

Signals.addSignalMethods(Space.prototype);

// static object
var StackPositions = {
    top: 0.01,
    up: 0.035,
    selected: 0.1,
    down: 0.95,
    bottom: 1.1,
};

/**
   A `Map` to store all `Spaces`'s, indexed by the corresponding workspace.
*/
var Spaces = class Spaces extends Map {
    // Fix for eg. space.map, see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes#Species
    static get [Symbol.species]() { return Map; }
    constructor() {
        super();
        this._initDone = false;
        this.clickOverlays = [];
        this.signals = new Utils.Signals();
        this.stack = [];
        let spaceContainer = new Clutter.Actor({ name: 'spaceContainer' });
        spaceContainer.hide();
        this.spaceContainer = spaceContainer;
        this.space_defaultAnimation = true;
        this.space_paperwmAnimation = false;

        backgroundGroup.add_child(this.spaceContainer);

        // Hook up existing workspaces
        for (let i = 0; i < workspaceManager.n_workspaces; i++) {
            let workspace = workspaceManager.get_workspace_by_index(i);
            this.addSpace(workspace);
        }
        this.signals.connect(workspaceManager, 'notify::n-workspaces',
            Utils.dynamic_function_ref('workspacesChanged', this).bind(this));

        if (workspaceManager.reorder_workspace) {
            // Compatibility: only in recent gnome-shell versions
            this.signals.connect(workspaceManager, 'workspaces-reordered',
                Utils.dynamic_function_ref('workspacesChanged', this).bind(this));
        }

        let OVERRIDE_SCHEMA;
        if (global.screen) {
            OVERRIDE_SCHEMA = 'org.gnome.shell.overrides';
        } else { // 3.30 now uses per desktop settings, instead of ad-hoc overrides
            OVERRIDE_SCHEMA = 'org.gnome.mutter';
        }
        this.overrideSettings = new Gio.Settings({ schema_id: OVERRIDE_SCHEMA });
    }

    init() {
        // Create extra workspaces if required
        Main.wm._workspaceTracker._checkWorkspaces();

        // Monitors aren't set up properly on `enable`, so we need it enable here.
        this.monitorsChanged();
        this.signals.connect(Main.layoutManager, 'monitors-changed', () => {
            displayConfig.upgradeGnomeMonitors(() => this.monitorsChanged());
        });

        this.signals.connect(display, 'window-created',
            (display, metaWindow, user_data) => this.window_created(metaWindow));

        this.signals.connect(display, 'grab-op-begin', (display, mw, type) => grabBegin(mw, type));
        this.signals.connect(display, 'grab-op-end', (display, mw, type) => grabEnd(mw, type));


        this.signals.connect(global.window_manager, 'switch-workspace',
            (wm, from, to, direction) => this.switchWorkspace(wm, from, to));

        this.signals.connect(this.overrideSettings, 'changed::workspaces-only-on-primary', () => {
            displayConfig.upgradeGnomeMonitors(() => this.monitorsChanged());
        });

        // Clone and hook up existing windows
        display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .forEach(w => {
                registerWindow(w);
                // Fixup allocations on reload
                allocateClone(w);
                this.signals.connect(w, 'size-changed', resizeHandler);
            });
        this._initDone = true;

        // Initialize spaces _after_ monitors are set up
        this.forEach(space => space.init());
        this.stack = this.mru();
    }

    /**
       The monitors-changed signal can trigger _many_ times when
       connection/disconnecting monitors.

       Monitors are now upgraded via a dbus proxy connector which upgrades
       Main.layoutManager.monitors with a "connector" property (e.g "eDP-1")
       which is more stable for restoring monitor layouts.
     */
    monitorsChanged() {
        this.onlyOnPrimary = this.overrideSettings.get_boolean('workspaces-only-on-primary');
        this.monitors = new Map();

        // can be called async (after delay) on disable - use activeSpace as check
        if (!this.activeSpace) {
            return;
        }

        this.activeSpace.getWindows().forEach(w => {
            animateWindow(w);
        });

        this.spaceContainer.set_size(global.screen_width, global.screen_height);

        for (let overlay of this.clickOverlays) {
            overlay.destroy();
        }
        this.clickOverlays = [];
        let mru = this.mru();

        let primary = Main.layoutManager.primaryMonitor;
        // get monitors but ensure primary monitor is first
        let monitors = Main.layoutManager.monitors.filter(m => m !== primary);
        monitors.unshift(primary);

        for (let monitor of monitors) {
            let overlay = new ClickOverlay(monitor, this.onlyOnPrimary);
            monitor.clickOverlay = overlay;
            overlay.activate();
            this.clickOverlays.push(overlay);
        }

        let finish = () => {
            /**
             * Gnome may select a workspace that just had it monitor removed (gone).
             * This this case find the next most recent space that's maintained it's
             * monitor, and select that.
             */
            let recent = this.mru().filter(s => !monitorGoneSpaces.includes(s));
            let activeSpace = recent?.[0] ?? this.monitors.get(primary);
            activeSpace.activate(false, false);

            this.selectedSpace = activeSpace;
            this.setMonitors(activeSpace.monitor, activeSpace);
            this.monitors.forEach(space => {
                space.show();
                Utils.actor_raise(space.clip);
            });

            this.spaceContainer.show();
            activeSpace.monitor.clickOverlay.deactivate();
            TopBar.refreshWorkspaceIndicator();
            this.setSpaceTopbarElementsVisible();
            StackOverlay.multimonitorDragDropSupport();
        };

        if (this.onlyOnPrimary) {
            this.forEach(space => {
                space.setMonitor(primary);
            });
            this.setMonitors(primary, mru[0]);
            finish();
            return;
        }

        /**
         * Schedule to restore space targetX after this.  Needs to be
         * scheduled before other loops since prevTargetX will be
         * updated after this.
         */
        Utils.later_add(Meta.LaterType.IDLE, () => {
            if (saveState.hasPrevTargetX()) {
                for (let [uuid, targetX] of saveState.prevTargetX) {
                    let space = this.spaceOfUuid(uuid);
                    if (space && Number.isFinite(targetX)) {
                        space.viewportMoveToX(targetX, false);
                    }
                }
            }

            // save restore state after restored previous targetX's
            saveState.update();

            // run layout on spaces after monitor to ensure windows layout is correct
            this.forEach(space => space.layout(false));
        });

        // add any new / need workspaces that were present from prev state
        let prevNSpaces = saveState?.prevSpaces?.size ?? 0;
        let addSpaces = Math.max(0, prevNSpaces - workspaceManager.n_workspaces);
        console.info(`nPrevSpaces ${prevNSpaces}, current nSpaces ${workspaceManager.n_workspaces}, need to add ${addSpaces}`);
        for (let i = 0; i < addSpaces; i++ ) {
            workspaceManager.append_new_workspace(false, global.get_current_time());
        }

        // Persist as many monitors as possible
        let indexTracker = [];
        if (saveState.hasPrevMonitors()) {
            for (let monitor of monitors) {
                // if processed spaceIndex, skip
                let spaceIndex = saveState.prevMonitors.get(monitor.connector);
                if (indexTracker.includes(spaceIndex)) {
                    continue;
                }
                indexTracker.push(spaceIndex);

                let space = this.spaceOfIndex(spaceIndex);
                if (space) {
                    console.info(`${space.name} restored to monitor ${monitor.connector}`);
                    this.setMonitors(monitor, space);
                    space.setMonitor(monitor);
                    mru = mru.filter(s => s !== space);
                }
            }
        }

        // Populate any remaining monitors
        for (let monitor of monitors) {
            if (this.monitors.get(monitor) === undefined) {
                let space = mru[0];
                if (space === undefined) {
                    continue;
                }
                this.setMonitors(monitor, space);
                space.setMonitor(monitor);
                mru = mru.slice(1);
            }
        }

        /**
         * Reset spaces where their monitors no longer exist.
         * These spaces should be be restored.  We'll track
         * which spaces have their monitor gone.
         */
        let monitorGoneSpaces = [];
        this.forEach(space => {
            if (!monitors.includes(space.monitor)) {
                monitorGoneSpaces.push(space);
                space.setMonitor(primary);
            }
        });

        finish();
    }

    /**
     * Sets this.monitors map and updates prevMonitors map (for restore).
     */
    setMonitors(monitor, space, save = false) {
        this.monitors.set(monitor, space);
        saveState.update(save);
    }

    _updateMonitor() {
        let monitorSpaces = this._getOrderedSpaces(this.selectedSpace.monitor);
        let currentMonitor = this.selectedSpace.monitor;
        monitorSpaces.forEach((space, i) => {
            space.setMonitor(currentMonitor);
        });
    }

    destroy() {
        for (let overlay of this.clickOverlays) {
            overlay.destroy();
        }
        for (let monitor of Main.layoutManager.monitors) {
            delete monitor.clickOverlay;
        }

        display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .forEach(metaWindow => {
                let actor = metaWindow.get_compositor_private();
                actor.remove_clip();

                if (metaWindow.clone) {
                    metaWindow.clone.destroy();
                    metaWindow.clone = null;
                }

                metaWindow._targetHeight = null;
                metaWindow._targetWidth = null;

                if (metaWindow.get_workspace() === workspaceManager.get_active_workspace() && !metaWindow.minimized)
                    actor.show();
                else
                    actor.hide();
            });

        this.signals.destroy();
        this.signals = null;

        // remove spaces
        for (let [workspace, space] of this) {
            this.removeSpace(space);
        }

        this.spaceContainer.destroy();
        this.spaceContainer = null;
    }

    workspacesChanged() {
        let nWorkspaces = workspaceManager.n_workspaces;

        // Identifying destroyed workspaces is rather bothersome,
        // as it will for example report having windows,
        // but will crash when looking at the workspace index

        // Gather all indexed workspaces for easy comparison
        let workspaces = {};
        for (let i = 0; i < nWorkspaces; i++) {
            let workspace = workspaceManager.get_workspace_by_index(i);
            workspaces[workspace] = true;
            if (this.spaceOf(workspace) === undefined) {
                this.addSpace(workspace);
            }
        }

        let nextUnusedWorkspaceIndex = nWorkspaces;
        for (let [workspace, space] of this) {
            if (workspaces[space.workspace] !== true) {
                this.removeSpace(space);

                // Maps in javascript (and thus Spaces) remember insertion order
                // so the workspaces are sorted by index. The relative ordering
                // of the removed workspaces will thus be preserved when resurrected.
                space.settings.set_int('index', nextUnusedWorkspaceIndex);
                nextUnusedWorkspaceIndex++;
            }
        }

        // Ensure the live spaces have correct indices
        for (let [workspace, space] of this) {
            space.settings.set_int('index', workspace.index());
            Meta.prefs_change_workspace_name(workspace.index(), space.name);
        }
    }

    switchMonitor(direction, move, warp = true) {
        let focus = display.focus_window;
        let monitor = focusMonitor();
        let currentSpace = this.monitors.get(monitor);
        let i = display.get_monitor_neighbor_index(monitor.index, direction);
        if (i === -1)
            return;
        let newMonitor = Main.layoutManager.monitors[i];
        if (warp) {
            Utils.warpPointerToMonitor(newMonitor);
        }
        let space = this.monitors.get(newMonitor);

        if (move && focus) {
            let metaWindow = focus.get_transient_for() || focus;

            if (currentSpace && currentSpace.indexOf(metaWindow) !== -1) {
                currentSpace.removeWindow(metaWindow);
                metaWindow.foreach_transient(t => {
                    currentSpace.removeWindow(t);
                });
            } else {
                metaWindow.move_to_monitor(newMonitor.index);
            }
            metaWindow.foreach_transient(t => {
                t.move_to_monitor(newMonitor.index);
            });
            if (space) {
                metaWindow.change_workspace(space.workspace);
                metaWindow.foreach_transient(t => {
                    space.addFloating(t);
                });
                space.activateWithFocus(focus, false, false);
            } else {
                metaWindow.move_to_monitor(newMonitor.index);
            }
        } else {
            space.activate(false, false);
        }
    }

    swapMonitor(direction, backDirection) {
        const monitor = focusMonitor();
        const i = display.get_monitor_neighbor_index(monitor.index, direction);
        if (i === -1)
            return;

        let navFinish = () => Navigator.getNavigator().finish();
        // action on current monitor
        this.selectStackSpace(Meta.MotionDirection.DOWN);
        navFinish();
        // switch to target monitor and action mru
        this.switchMonitor(direction, false, false);
        this.selectStackSpace(Meta.MotionDirection.DOWN);
        navFinish();
        // switch back to orig monitor and action mru
        this.switchMonitor(backDirection, false, false);
        this.selectStackSpace(Meta.MotionDirection.DOWN);
        navFinish();
        // final switch with warp
        this.switchMonitor(direction);

        // ensure after swapping that the space elements are shown correctly
        this.setSpaceTopbarElementsVisible(true, { force: true });
    }

    switchWorkspace(wm, fromIndex, toIndex, animate = false) {
        let to = workspaceManager.get_workspace_by_index(toIndex);
        let from = workspaceManager.get_workspace_by_index(fromIndex);
        let toSpace = this.spaceOf(to);
        let fromSpace = this.spaceOf(from);

        if (inGrab && inGrab.window) {
            inGrab.window.change_workspace(toSpace.workspace);
        }

        for (let metaWindow of toSpace.getWindows()) {
            // Make sure all windows belong to the correct workspace.
            // Note: The 'switch-workspace' signal (this method) runs before mutter decides on focus window.
            // This simplifies other code moving windows between workspaces.
            // Eg.: The DnD-window defer changing its workspace until the workspace actually is activated.
            //      This ensures the DnD window keep focus the whole time.
            metaWindow.change_workspace(toSpace.workspace);
        }

        if (inPreview === PreviewMode.NONE &&
            toSpace.monitor === fromSpace.monitor) {
            // Only start an animation if we're moving between workspaces on the
            // same monitor
            this.initWorkspaceSequence();
        } else {
            this.selectedSpace.setMonitor(this.selectedSpace.monitor);
        }

        this.stack = this.stack.filter(s => s !== toSpace);
        this.stack = [toSpace, ...this.stack];

        let monitor = toSpace.monitor;
        this.setMonitors(monitor, toSpace, true);

        this.setSpaceTopbarElementsVisible();
        let doAnimate = animate || this.space_paperwmAnimation;
        this.animateToSpace(
            toSpace,
            fromSpace,
            doAnimate);

        toSpace.monitor?.clickOverlay.deactivate();

        for (let monitor of Main.layoutManager.monitors) {
            if (monitor === toSpace.monitor)
                continue;
            monitor.clickOverlay.activate();
        }

        inPreview = PreviewMode.NONE;
    }

    /**
     * See Space.setSpaceTopbarElementsVisible function for what this does.
     * @param {boolean} visible
     */
    setSpaceTopbarElementsVisible(visible = false, options = {}) {
        this.forEach(s => {
            s.setSpaceTopbarElementsVisible(visible, options);
        });
    }

    _getOrderedSpaces(monitor) {
        let nWorkspaces = workspaceManager.n_workspaces;
        let out = [];
        for (let i = 0; i < nWorkspaces; i++) {
            let space = this.spaceOf(workspaceManager.get_workspace_by_index(i));
            if (space.monitor === monitor ||
                (space.length === 0 && this.monitors.get(space.monitor) !== space))
                out.push(space);
        }
        return out;
    }

    _animateToSpaceOrdered(toSpace, animate = true) {
        // Always show the topbar when using the workspace stack
        TopBar.fixTopBar();

        toSpace = toSpace || this.selectedSpace;
        let monitorSpaces = this._getOrderedSpaces(toSpace.monitor);

        let currentMonitor = toSpace.monitor;
        this.selectedSpace = toSpace;

        const scale = 1;
        const padding_percentage = 4;
        const to = monitorSpaces.indexOf(toSpace);
        monitorSpaces.forEach((space, i) => {
            space.setMonitor(currentMonitor);
            space.startAnimate();

            Easer.removeEase(space.border);
            space.border.opacity = 255;
            space.border.show();

            space.show();

            let padding = (space.height * scale / 100) * padding_percentage;
            let y = ((space.height + padding) * (i - to)) * scale;
            if (animate) {
                Easer.addEase(space.actor, {
                    time: Settings.prefs.animation_time,
                    y, scale_y: scale, scale_x: scale,
                });
            } else {
                // Remove any lingering onComplete handlers from animateToSpace
                Easer.removeEase(space.actor);

                space.actor.y = y;
                space.actor.scale_y = scale;
                space.actor.scale_x = scale;
            }

            let selected = space.selectedWindow;
            if (selected && selected.fullscreen && space !== toSpace) {
                selected.clone.y = Main.panel.height + Settings.prefs.vertical_margin;
            }
        });
    }

    initWorkspaceSequence() {
        if (inPreview) {
            return;
        }
        inPreview = PreviewMode.SEQUENTIAL;

        if (Main.panel.statusArea.appMenu) {
            Main.panel.statusArea.appMenu.container.hide();
        }

        this.setSpaceTopbarElementsVisible(true);
        this._animateToSpaceOrdered(this.selectedSpace, false);

        let selected = this.selectedSpace.selectedWindow;
        if (selected && selected.fullscreen) {
            Easer.addEase(selected.clone, {
                y: Main.panel.height + Settings.prefs.vertical_margin,
                time: Settings.prefs.animation_time,
            });
        }
    }

    selectSequenceSpace(direction, move) {
        // if in stack preview do not run sequence preview
        if (inPreview === PreviewMode.STACK) {
            return;
        }

        let currentSpace = this.activeSpace;
        let monitorSpaces = this._getOrderedSpaces(currentSpace.monitor);

        let from = monitorSpaces.indexOf(this.selectedSpace);
        let newSpace = this.selectedSpace;
        let to = from;

        if (move && this.selectedSpace.selectedWindow) {
            const navigator = Navigator.getNavigator();
            if (!navigator._moving ||
                (Array.isArray(navigator._moving) && navigator._moving.length === 0)) {
                takeWindow(this.selectedSpace.selectedWindow,
                    this.selectedSpace,
                    { navigator });
            }
        }

        if (direction === Meta.MotionDirection.DOWN) {
            to = from + 1;
        }
        else {
            to = from - 1;
        }

        if (to < 0 || to >= monitorSpaces.length) {
            return;
        }

        if (to === from && Easer.isEasing(newSpace.actor)) {
            return;
        }

        if (!inPreview) {
            this.initWorkspaceSequence();
        }

        newSpace = monitorSpaces[to];
        this.selectedSpace = newSpace;

        // if active (source space) is panelMonitor update indicator
        if (currentSpace.monitor === TopBar.panelMonitor()) {
            TopBar.updateWorkspaceIndicator(newSpace.index);
        }

        const scale = 0.825;
        const padding_percentage = 4;
        let last = monitorSpaces.length - 1;
        monitorSpaces.forEach((space, i) => {
            let padding = (space.height * scale / 100) * padding_percentage;
            let center = (space.height - (space.height * scale)) / 2;
            let space_y;
            if (to === 0) {
                space_y = padding + (space.height + padding) * (i - to) * scale;
            } else if (to == last) {
                space_y = (center * 2 - padding) + (space.height + padding) * (i - to) * scale;
            } else {
                space_y = center + (space.height + padding) * (i - to) * scale;
            }

            space.show();
            Easer.addEase(space.actor, {
                y: space_y,
                time: Settings.prefs.animation_time,
                scale_x: scale,
                scale_y: scale,
            });
        });
    }

    initWorkspaceStack() {
        if (inPreview) {
            return;
        }

        inPreview = PreviewMode.STACK;

        // Always show the topbar when using the workspace stack
        TopBar.fixTopBar();
        const scale = 0.9;
        let space = this.activeSpace;
        let mru = [...this.stack];
        this.monitors.forEach(space => mru.splice(mru.indexOf(space), 1));
        mru = [space, ...mru];

        if (Main.panel.statusArea.appMenu)
            Main.panel.statusArea.appMenu.container.hide();
        let monitor = space.monitor;
        this.selectedSpace = space;

        this.setSpaceTopbarElementsVisible(true);
        let cloneParent = space.clip.get_parent();
        mru.forEach((space, i) => {
            space.startAnimate();

            if (space.length !== 0) {
                let scaleX = monitor.width / space.width;
                let scaleY = monitor.height / space.height;
                space.clip.set_scale(scaleX, scaleY);
                space.clip.set_position(monitor.x, monitor.y);
            } else {
                space.setMonitor(monitor);
            }

            Easer.removeEase(space.border);
            space.border.opacity = 255;
            space.border.show();

            let h;
            if (i === 0) {
                h = 0;
                space.show();
            } else if (i === 1) {
                h = StackPositions.up;
                space.show();
            } else if (i === 2) {
                h = StackPositions.top;
                space.show();
            } else {
                h = StackPositions.top;
                space.hide();
            }

            space.actor.set_position(0, space.height * h);

            space.actor.scale_y = scale - i * 0.01;
            space.actor.scale_x = scale - i * 0.01;

            // Remove any lingering onComplete handlers from animateToSpace
            Easer.removeEase(space.actor);

            if (mru[i - 1] === undefined) {
                return;
            }
            let child = space.clip;
            let sibling = mru[i - 1].clip;
            child !== sibling && cloneParent.set_child_below_sibling(child, sibling);
            let selected = space.selectedWindow;
            if (selected && selected.fullscreen) {
                selected.clone.y = Main.panel.height + Settings.prefs.vertical_margin;
            }
        });

        space.actor.scale_y = 1;
        space.actor.scale_x = 1;

        let selected = space.selectedWindow;
        if (selected && selected.fullscreen) {
            Easer.addEase(selected.clone, {
                y: Main.panel.height + Settings.prefs.vertical_margin,
                time: Settings.prefs.animation_time,
            });
        }
    }

    selectStackSpace(direction, move) {
        // if in sequence preview do not run stack preview
        if (inPreview === PreviewMode.SEQUENTIAL) {
            return;
        }

        const scale = 0.9;
        let space = this.activeSpace;
        let mru = [...this.stack];

        this.monitors.forEach(space => mru.splice(mru.indexOf(space), 1));
        mru = [space, ...mru];

        if (!inPreview) {
            this.initWorkspaceStack();
        }

        let from = mru.indexOf(this.selectedSpace);
        let newSpace = this.selectedSpace;
        let to = from;
        if (move && this.selectedSpace.selectedWindow) {
            takeWindow(this.selectedSpace.selectedWindow,
                this.selectedSpace,
                { navigator: Navigator.getNavigator() });
        }

        if (direction === Meta.MotionDirection.DOWN)
            to = from + 1;
        else
            to = from - 1;

        // wrap around workspaces
        if (to < 0) {
            to = mru.length - 1;
        }
        else if (to >= mru.length) {
            to = 0;
        }

        if (to === from && Easer.isEasing(newSpace.actor)) {
            return;
        }

        newSpace = mru[to];
        this.selectedSpace = newSpace;

        // if active (source space) is panelMonitor update indicator
        if (space.monitor === TopBar.panelMonitor()) {
            TopBar.updateWorkspaceIndicator(newSpace.index);
        }

        mru.forEach((space, i) => {
            let actor = space.actor;
            let h, onComplete = () => {};
            if (to === i)
                h = StackPositions.selected;
            else if (to + 1 === i)
                h = StackPositions.up;
            else if (to - 1 === i)
                h = StackPositions.down;
            else if (i > to)
                h = StackPositions.top;
            else if (i < to)
                h = StackPositions.bottom;

            if (Math.abs(i - to) > 2) {
                onComplete = () => {
                    space.hide();
                };
            } else {
                space.show();
            }
            Easer.addEase(actor,
                {
                    y: h * space.height,
                    time: Settings.prefs.animation_time,
                    scale_x: scale + (to - i) * 0.01,
                    scale_y: scale + (to - i) * 0.01,
                    onComplete,
                });
        });
    }

    animateToSpace(to, from, animate = true, callback) {
        let currentPreviewMode = inPreview;
        inPreview = PreviewMode.NONE;

        TopBar.updateWorkspaceIndicator(to.index);
        this.selectedSpace = to;

        to.show();
        let selected = to.selectedWindow;
        if (selected)
            ensureViewport(selected, to);

        if (from) {
            from.startAnimate();
        }

        let visible = new Map();
        for (let [monitor, space] of this.monitors) {
            visible.set(space, true);
        }

        let time = animate ? Settings.prefs.animation_time : 0;
        let onComplete = () => {
            // Hide any spaces that aren't visible This
            // avoids a nasty preformance degregration in some
            // cases
            for (const space of spaces.values()) {
                if (!visible.get(space)) {
                    space.hide();
                }
            }

            to.border.hide();
            to.border.opacity = 255;
            Utils.actor_raise(to.clip);

            // Fixes a weird bug where mouse input stops
            // working after mousing to another monitor on
            // X11.
            if (!Meta.is_wayland_compositor()) {
                to.startAnimate();
            }

            to.moveDone();
            if (callback) {
                callback();
            }
        };

        if (currentPreviewMode === PreviewMode.SEQUENTIAL) {
            this._animateToSpaceOrdered(to, animate);
            let t = to.actor.get_transition('y');
            if (t) {
                t.connect('stopped', (timeline, finished) => {
                    if (finished) {
                        onComplete();
                    }
                });
            } else {
                // When switching between monitors there's no animation we can
                // connect to
                onComplete();
            }
            return;
        }

        this._updateMonitor();
        Easer.addEase(to.actor,
            {
                x: 0,
                y: 0,
                scale_x: 1,
                scale_y: 1,
                time,
                onComplete,
            });

        // Animate all the spaces above `to` down below the monitor. We get
        // these spaces by looking at siblings of upper most actor, ie. the
        // `clip`. This is done since `this.stack` is already updated.
        let above = to.clip.get_next_sibling();
        while (above) {
            let space = above.space;
            if (!visible.get(space)) {
                Easer.addEase(space.actor,
                    {
                        x: 0, y: space.height + 20,
                        time,
                    });
            }
            above = above.get_next_sibling();
        }
    }

    addSpace(workspace) {
        let space = new Space(workspace, this.spaceContainer, this._initDone);
        this.set(workspace, space);
        this.stack.push(space);
    }

    removeSpace(space) {
        this.delete(space.workspace);
        this.stack.splice(this.stack.indexOf(space), 1);
        space.destroy();
    }

    spaceOfWindow(meta_window) {
        return this.get(meta_window.get_workspace());
    }

    /**
     *
     * @param {import('@gi-types/meta').Workspace} workspace
     * @returns {Space}
     */
    spaceOf(workspace) {
        return this.get(workspace);
    }

    /**
     * Returns the space by it's workspace index value.
     */
    spaceOfIndex(workspaceIndex) {
        let workspace = [...this.keys()].find(w => workspaceIndex === w.index());
        return this.spaceOf(workspace);
    }

    /**
     * Returns the space of a specific uuid.
     */
    spaceOfUuid(uuid) {
        return [...this.values()].find(s => uuid === s.uuid);
    }

    get selectedSpace() {
        return this._selectedSpace ?? this.activeSpace;
    }

    set selectedSpace(space) {
        this._selectedSpace = space;
    }

    /**
     * Returns the currently active space.
     */
    get activeSpace() {
        return this.spaceOf(workspaceManager.get_active_workspace());
    }

    /**
     * Returns true if the space is the currently active space.
     * @param {Space} space
     * @returns
     */
    isActiveSpace(space) {
        return space === this.activeSpace;
    }

    /**
       Return an array of Space's ordered in most recently used order.
     */
    mru() {
        let seen = new Map(), out = [];
        let active = workspaceManager.get_active_workspace();
        out.push(this.get(active));
        seen.set(active, true);

        display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .forEach((metaWindow, i) => {
                let workspace = metaWindow.get_workspace();
                if (!seen.get(workspace)) {
                    out.push(this.get(workspace));
                    seen.set(workspace, true);
                }
            });

        let workspaces = workspaceManager.get_n_workspaces();
        for (let i = 0; i < workspaces; i++) {
            let workspace = workspaceManager.get_workspace_by_index(i);
            if (!seen.get(workspace)) {
                out.push(this.get(workspace));
                seen.set(workspace, true);
            }
        }

        return out;
    }

    /**
     * @param display
     * @param metaWindow {import("@gi-types/meta").Window}
     */
    window_created(metaWindow) {
        if (!registerWindow(metaWindow)) {
            return;
        }

        metaWindow.unmapped = true;

        console.debug('window-created', metaWindow?.title);
        let actor = metaWindow.get_compositor_private();
        animateWindow(metaWindow);

        /*
          We need reliable `window_type`, `wm_class` et. all to handle window insertion correctly.

          On wayland this is completely broken before `first-frame`. It's
          somewhat more stable on X11, but there's at minimum some racing with
          `wm_class` which can break the users winprop rules.
        */
        signals.connectOneShot(actor, 'first-frame', () =>  {
            allocateClone(metaWindow);
            insertWindow(metaWindow, { existing: false });
        });
    }

    /**
     * Checks whether the window position bar should be enabled.
     */
    showWindowPositionBarChanged() {
        if (Settings.prefs.show_window_position_bar) {
            this.forEach(s => {
                s.enableWindowPositionBar();
            });
        }

        if (!Settings.prefs.show_window_position_bar) {
            // should be in normal topbar mode
            this.forEach(s => {
                s.enableWindowPositionBar(false);
            });
        }

        TopBar.fixStyle();
    }
};
Signals.addSignalMethods(Spaces.prototype);

/**
 * Return true if a window is tiled (e.g. not floating, not scratch, not transient).
 * @param metaWindow
 */
function isTiled(metaWindow) {
    if (!metaWindow) {
        return false;
    }

    if (!isFloating(metaWindow) &&
        !isScratch(metaWindow) &&
        !isTransient(metaWindow)) {
        return true;
    }
    else {
        return false;
    }
}

/**
 * Transient windows are connected to a parent window and take focus.
 * On Wayland it takes entire focus (can't focus parent window while it's open).
 * @param metaWindow
 * @returns
 */
function isTransient(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    if (metaWindow.get_transient_for()) {
        return true;
    }
    else {
        return false;
    }
}

/**
 * Returns true if a metaWindow has at least one transient window.
 * @param metaWindow
 * @returns
 */
function hasTransient(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    let hasTransient = false;
    metaWindow.foreach_transient(t => {
        hasTransient = true;
    });

    return hasTransient;
}

/**
 * Conveniece method for checking if a window is floating.
 * Will determine what space this window is on.
 * @param metaWindow
 * @returns
 */
function isFloating(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    let space = spaces.spaceOfWindow(metaWindow);
    return space.isFloating?.(metaWindow) ?? false;
}

function isScratch(metaWindow) {
    if (!metaWindow) {
        return false;
    }
    return Scratch.isScratchWindow(metaWindow);
}

function is_override_redirect(metaWindow) {
    // Note: is_overrride_redirect() seem to be false for all wayland windows
    const windowType = metaWindow.windowType;
    return (
        metaWindow.is_override_redirect() ||
        windowType === Meta.WindowType.DROPDOWN_MENU ||
        windowType === Meta.WindowType.TOOLTIP
    );
}

function registerWindow(metaWindow) {
    if (is_override_redirect(metaWindow)) {
        return false;
    }

    if (metaWindow.clone) {
        // Can now happen when setting session-modes to "unlock-dialog" or
        // resetting gnome-shell in-place (e.g. on X11)
        console.warn("window already registered", metaWindow.title);
        return false;
    }

    let actor = metaWindow.get_compositor_private();
    let cloneActor = new Clutter.Clone({ source: actor });
    let clone = new Clutter.Actor();

    clone.add_actor(cloneActor);
    clone.targetX = 0;
    clone.meta_window = metaWindow;

    metaWindow.clone = clone;
    metaWindow.clone.cloneActor = cloneActor;

    signals.connect(metaWindow, "focus", focus_wrapper);
    signals.connect(metaWindow, 'size-changed', allocateClone);
    // Note: runs before gnome-shell's minimize handling code
    signals.connect(metaWindow, 'notify::fullscreen', TopBar.fixTopBar);
    signals.connect(metaWindow, 'notify::minimized', minimizeWrapper);
    signals.connect(actor, 'show', showWrapper);
    signals.connect(actor, 'destroy', destroyHandler);

    return true;
}

function allocateClone(metaWindow) {
    if (!metaWindow?.clone) {
        return;
    }

    let frame = metaWindow.get_frame_rect();
    let buffer = metaWindow.get_buffer_rect();
    // Adjust the clone's origin to the north-west, so it will line up
    // with the frame.
    let clone = metaWindow.clone;
    let cloneActor = clone.cloneActor;
    cloneActor.set_position(buffer.x - frame.x,
        buffer.y - frame.y);
    cloneActor.set_size(buffer.width, buffer.height);
    clone.set_size(frame.width, frame.height);

    if (metaWindow.clone.first_child.name === 'selection') {
        let selection = metaWindow.clone.first_child;
        let vMax = metaWindow.maximized_vertically;
        let hMax = metaWindow.maximized_horizontally;
        let protrusion = Math.round(Settings.prefs.window_gap / 2);
        selection.x = hMax ? 0 : -protrusion;
        selection.y = vMax ? 0 : -protrusion;
        selection.set_size(frame.width + (hMax ? 0 : Settings.prefs.window_gap),
            frame.height + (vMax ? 0 : Settings.prefs.window_gap));
    }
}

function destroyHandler(actor) {
    signals.disconnect(actor);
}

function resizeHandler(metaWindow) {
    // if navigator is showing, reset/refresh it after a window has resized
    if (Navigator.navigating) {
        Navigator.getNavigator().minimaps.forEach(m => typeof m !== 'number' && m.reset());
    }

    if (inGrab && inGrab.window === metaWindow)
        return;

    const f = metaWindow.get_frame_rect();
    let needLayout = false;
    if (metaWindow._targetWidth !== f.width || metaWindow._targetHeight !== f.height) {
        needLayout = true;
    }
    metaWindow._targetWidth = null;
    metaWindow._targetHeight = null;

    const space = spaces.spaceOfWindow(metaWindow);
    if (space.indexOf(metaWindow) === -1)
        return;

    const selected = metaWindow === space.selectedWindow;
    let animate = true;
    let x;

    // if window is fullscreened, then don't animate background space.container animation etc.
    if (metaWindow?.fullscreen) {
        animate = false;
        x = 0;
    } else {
        x = metaWindow.get_frame_rect().x - space.monitor.x;
    }

    if (!space._inLayout && needLayout) {
        // Restore window position when eg. exiting fullscreen
        if (!Navigator.navigating && selected) {
            move_to(space, metaWindow, {
                x,
                animate,
            });
        }

        // Resizing from within a size-changed signal is troube (#73). Queue instead.
        space.queueLayout(animate);
    }
}

let signals, backgroundGroup, grabSignals;
let gsettings, backgroundSettings, interfaceSettings;
let displayConfig;
let saveState;
let startupTimeoutId, timerId;
var inGrab; // exported
function enable(errorNotification) {
    inGrab = false;

    displayConfig = new Utils.DisplayConfig();
    saveState = saveState ?? new SaveState();

    gsettings = ExtensionUtils.getSettings();
    backgroundSettings = new Gio.Settings({
        schema_id: 'org.gnome.desktop.background',
    });
    interfaceSettings = new Gio.Settings({
        schema_id: "org.gnome.desktop.interface",
    });

    signals = new Utils.Signals();
    grabSignals = new Utils.Signals();

    let setVerticalMargin = () => {
        let vMargin = gsettings.get_int('vertical-margin');
        let gap = gsettings.get_int('window-gap');
        Settings.prefs.vertical_margin = Math.max(Math.round(gap / 2), vMargin);
    };
    setVerticalMargin();

    // setup actions on gap changes
    let onWindowGapChanged = () => {
        setVerticalMargin();
        Utils.timeout_remove(timerId);
        timerId = Mainloop.timeout_add(500, () => {
            spaces.mru().forEach(space => {
                space.layout();
            });
            timerId = null;
            return false; // on return false destroys timeout
        });
    };
    gsettings.connect('changed::vertical-margin', onWindowGapChanged);
    gsettings.connect('changed::vertical-margin-bottom', onWindowGapChanged);
    gsettings.connect('changed::window-gap', onWindowGapChanged);

    backgroundGroup = Main.layoutManager._backgroundGroup;

    spaces = new Spaces();
    let initWorkspaces = () => {
        try {
            spaces.init();
        } catch (e) {
            console.error('#paperwm startup failed');
            console.error(`JS ERROR: ${e}\n${e.stack}`);
            errorNotification(
                "PaperWM",
                `Error occured in paperwm startup:\n\n${e.message}`,
                e.stack);
        }

        // Fix the stack overlay
        spaces.mru().reverse().forEach(s => {
            // if s.selectedWindow exists and is in view, then use option moveto: false
            if (s.selectedWindow) {
                let options = s.isFullyVisible(s.selectedWindow) ? { moveto: false } : { force: true };
                ensureViewport(s.selectedWindow, s, options);
            }
            s.monitor.clickOverlay.show();
        });
        TopBar.fixTopBar();

        // on idle update space topbar elements and name
        Utils.later_add(Meta.LaterType.IDLE, () => {
            spaces.forEach(s => {
                s.setSpaceTopbarElementsVisible();
                s.updateName();
            });
        });
    };

    if (Main.layoutManager._startingUp) {
        // Defer workspace initialization until existing windows are accessible.
        // Otherwise we're unable to restore the tiling-order. (when restarting
        // gnome-shell)
        signals.connectOneShot(Main.layoutManager, 'startup-complete',
            () => displayConfig.upgradeGnomeMonitors(initWorkspaces));
    } else {
        /**
         * Upgrade gnome monitor info objects by add "connector" information, and
         * when done (async) callback to initworkspaces.
         */
        // NOTE: this should happen after Patches.enable() have run, so we do
        // it in a timeout
        startupTimeoutId = Mainloop.timeout_add(0, () => {
            displayConfig.upgradeGnomeMonitors(initWorkspaces);
            startupTimeoutId = null;
            return false; // on return false destroys timeout
        });
    }
}

function disable () {
    Utils.timeout_remove(startupTimeoutId);
    startupTimeoutId = null;
    Utils.timeout_remove(timerId);
    timerId = null;

    grabSignals.destroy();
    grabSignals = null;
    signals.destroy();
    signals = null;

    saveState.prepare();
    displayConfig.downgradeGnomeMonitors();
    displayConfig = null;
    spaces.destroy();
    inGrab = null;
    gsettings = null;
    backgroundGroup = null;
    backgroundSettings = null;
    interfaceSettings = null;
}

/**
 * Saves current state for controlled restarts of PaperWM.
 */
let SaveState = class SaveState {
    constructor() {
        this.prevMonitors = new Map();
        this.prevSpaces = new Map();
        this.prevTargetX = new Map();
    }

    hasPrevMonitors() {
        return this.prevMonitors?.size > 0;
    }

    hasPrevSpaces() {
        return this.prevSpaces?.size > 0;
    }

    hasPrevTargetX() {
        return this.prevTargetX?.size > 0;
    }

    getPrevSpaceByUUID(uuid) {
        return [...this.prevSpaces.values()].find(s => uuid === s.uuid);
    }

    /**
     * Updates save state based on current monitors, spaces, and layouts.
     */
    update(save = true) {
        if (!save) {
            return;
        }

        /**
         * For monitors, since these are upgraded with "connector" field,
         * which we delete on disable. Beefore we delete this field, we want
         * a copy on connector (and index) to restore space to monitor.
         */
        if (spaces?.monitors) {
            for (let [monitor, space] of spaces.monitors) {
                this.prevMonitors.set(monitor.connector, space.index);
            }
        }

        // store space targetx values
        this.prevTargetX = new Map();
        spaces.forEach(s => {
            if (s.getWindows().length > 0 && s.targetX !== 0) {
                this.prevTargetX.set(s.uuid, s.targetX);
            }
        });

        // save spaces (for window restore)
        this.prevSpaces = new Map(spaces);
    }

    /**
     * Prepares state for restoring on next enable.
     */
    prepare() {
        this.update();
        this.prevSpaces.forEach(space => {
            let windows = space.getWindows();
            let selected = windows.indexOf(space.selectedWindow);
            if (selected === -1)
                return;
            // Stack windows correctly for controlled restarts
            for (let i = selected; i < windows.length; i++) {
                windows[i].lower();
            }
            for (let i = selected; i >= 0; i--) {
                windows[i].lower();
            }
        });
    }
};

/**
 * Return the currently focused monitor (or more specifically, the current
 * active space's monitor).
 */
function focusMonitor() {
    return spaces?.activeSpace?.monitor;
}

/**
 * Convenience method to run a callback method when an actor is shown the stage.
 * Uses a `connectOneShot` signal.
 * @param actor
 * @param callback
 */
function callbackOnActorShow(actor, callback) {
    signals.connectOneShot(actor, 'show', callback);
}

/**
   Types of windows which never should be tiled.
 */
function add_filter(meta_window) {
    if (isTransient(meta_window)) {
        // Never add transient windows
        return false;
    }
    if (meta_window.window_type !== Meta.WindowType.NORMAL) {
        // And only add Normal windows
        return false;
    }

    if (meta_window.is_on_all_workspaces()) {
        return false;
    }
    if (Scratch.isScratchWindow(meta_window)) {
        return false;
    }

    return true;
}

/**
   Handle windows leaving workspaces.
 */
function remove_handler(workspace, meta_window) {
    // Note: If `meta_window` was closed and had focus at the time, the next
    // window has already received the `focus` signal at this point.
    // Not sure if we can check directly if _this_ window had focus when closed.

    let space = spaces.spaceOf(workspace);
    space.removeWindow(meta_window);

    let actor = meta_window.get_compositor_private();
    if (!actor) {
        signals.disconnect(meta_window);
        if (meta_window.clone && meta_window.clone.mapped) {
            meta_window.clone.destroy();
            meta_window.clone = null;
        }
    }
}

/**
   Handle windows entering workspaces.
*/
function add_handler(ws, metaWindow) {
    // Do not handle grabbed windows
    if (inGrab && inGrab.window === metaWindow)
        return;

    let actor = metaWindow.get_compositor_private();
    if (actor) {
        // Set position and hookup signals, with `existing` set to true
        insertWindow(metaWindow, { existing: true && !metaWindow.redirected });
        delete metaWindow.redirected;
    }
    // Otherwise we're dealing with a new window, so we let `window-created`
    // handle initial positioning.
}

/**
   Insert the window into its space if appropriate. Requires MetaWindowActor

   This gets called from `Workspace::window-added` if the window already exists,
   and `Display::window-created` through `WindowActor::show` if window is newly
   created to ensure that the WindowActor exists.
*/
function insertWindow(metaWindow, { existing }) {
    // Add newly created windows to the space being previewed
    if (!existing &&
        !metaWindow.is_on_all_workspaces() &&
        metaWindow.get_workspace() !== spaces.selectedSpace.workspace) {
        metaWindow.redirected = true;
        metaWindow.change_workspace(spaces.selectedSpace.workspace);
        return;
    }

    const actor = metaWindow.get_compositor_private();
    const space = spaces.spaceOfWindow(metaWindow);

    const connectSizeChanged = tiled => {
        if (tiled) {
            animateWindow(metaWindow);
        }
        metaWindow.unmapped && signals.connect(metaWindow, 'size-changed', resizeHandler);
        delete metaWindow.unmapped;
    };

    if (!existing) {
        /**
         * Note: Can't trust global.display.focus_window to determine currently focused window.
         * The mru is more flexible. (global.display.focus_window does not always agree with mru[0]).
         */
        let mru = display.get_tab_list(Meta.TabList.NORMAL_ALL, null);
        let focusWindow = mru[0];

        if (focusWindow === metaWindow) {
            focusWindow = mru[1];
        }

        // Scratch if have scratch windows on this space and focused window is also scratch
        let scratchIsFocused =
            Scratch.getScratchWindows().length > 0 &&
            space === spaces.spaceOfWindow(focusWindow) &&
            Scratch.isScratchWindow(focusWindow);
        let addToScratch = scratchIsFocused;

        let winprop = Settings.find_winprop(metaWindow);
        if (winprop) {
            if (winprop.oneshot) {
                Settings.winprops.splice(Settings.winprops.indexOf(winprop), 1);
            }
            if (winprop.scratch_layer) {
                console.debug("#winprops", `Move ${metaWindow?.title} to scratch`);
                addToScratch = true;
            }
            if (winprop.focus) {
                Main.activateWindow(metaWindow);
            }

            // pass winprop properties to metaWindow
            metaWindow.preferredWidth = winprop.preferredWidth;
        }

        if (addToScratch) {
            connectSizeChanged();
            Scratch.makeScratch(metaWindow);
            if (scratchIsFocused) {
                activateWindowAfterRendered(actor, metaWindow);
            }
            return;
        }
    }

    if (metaWindow.is_on_all_workspaces()) {
        // Only connect the necessary signals and show windows on shared
        // secondary monitors.
        connectSizeChanged();
        showWindow(metaWindow);
        return;
    } else if (Scratch.isScratchWindow(metaWindow)) {
        // And make sure scratch windows are stuck
        Scratch.makeScratch(metaWindow);
        return;
    }

    if (!add_filter(metaWindow)) {
        connectSizeChanged();
        space.addFloating(metaWindow);
        // Make sure the window is on the correct monitor
        metaWindow.move_to_monitor(space.monitor.index);
        showWindow(metaWindow);
        // Make sure the window isn't hidden behind the space (eg. dialogs)
        !existing && metaWindow.make_above();
        return;
    }

    if (space.indexOf(metaWindow) !== -1)
        return;

    let clone = metaWindow.clone;
    let ok, x, y;
    // Figure out the matching coordinates before the clone is reparented.
    if (isWindowAnimating(metaWindow)) {
        let point = clone.apply_transform_to_point(new Graphene.Point3D({ x: 0, y: 0 }));
        [ok, x, y] = space.cloneContainer.transform_stage_point(point.x, point.y);
    } else {
        let frame = metaWindow.get_frame_rect();
        [ok, x, y] = space.cloneContainer.transform_stage_point(frame.x, frame.y);
    }
    ok && clone.set_position(x, y);

    if (!space.addWindow(metaWindow, getOpenWindowPositionIndex(space)))
        return;

    metaWindow.unmake_above();
    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH) {
        metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
        toggleMaximizeHorizontally(metaWindow);
    }

    // run a simple layout in pre-prepare layout
    space.layout(false);

    // if only one window on space, then centre it
    const centre = () => {
        if (space.getWindows().length === 1) {
            centerWindowHorizontally(metaWindow);
        }
    };

    /**
     * If window is new, then setup and ensure is in view
     * after actor is shown on stage.
     */
    if (!existing) {
        clone.x = clone.targetX;
        clone.y = clone.targetY;
        space.layout();

        // run focus and resize to ensure new window is correctly shown
        focus_handler(metaWindow);
        resizeHandler(metaWindow);
        connectSizeChanged(true);

        // remove winprop props after window shown
        callbackOnActorShow(actor, () => {
            delete metaWindow.preferredWidth;

            Main.activateWindow(metaWindow);
            ensureViewport(space.selectedWindow, space);

            centre();
        });

        return;
    }

    space.layout();
    animateWindow(metaWindow);
    if (metaWindow === display.focus_window) {
        focus_handler(metaWindow);
    } else if (space === spaces.activeSpace) {
        Main.activateWindow(metaWindow);
    } else {
        ensureViewport(space.selectedWindow, space);
    }

    centre();
}

/**
 * Gets the window index to add a new window in the space:
 * { RIGHT: 0, LEFT: 1, START: 2, END: 3 };
 */
function getOpenWindowPositionIndex(space) {
    let index = -1; // init (-1 -> at beginning)
    if (space?.selectedWindow) {
        index = space.indexOf(space.selectedWindow);
    }

    const pos = Settings.prefs.open_window_position;
    switch (pos) {
    case Settings.OpenWindowPositions.LEFT:
        return index;
    case Settings.OpenWindowPositions.START:
        return 0;
    case Settings.OpenWindowPositions.END:
        // get number of columns in space
        return space.length + 1;

    default:
        return index + 1;
    }
}

function animateDown(metaWindow) {
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();
    Easer.addEase(metaWindow.clone, {
        y: workArea.y,
        time: Settings.prefs.animation_time,
    });
}

function ensuredX(meta_window, space) {
    let index = space.indexOf(meta_window);
    let last = space.selectedWindow;
    let lastIndex = space.indexOf(last);
    let neighbour = Math.abs(lastIndex - index) <= 1;

    let monitor = space.monitor;
    let frame = meta_window.get_frame_rect();
    let clone = meta_window.clone;

    let x;
    if (neighbour || space.isVisible(meta_window) || meta_window.lastFrame === undefined)
        x = Math.round(clone.targetX) + space.targetX;
    else
        x = meta_window.lastFrame.x - monitor.x;
    let workArea = space.workArea();
    let min = workArea.x;
    let max = min + workArea.width;

    if (space.focusMode == FocusModes.CENTER) {
        // window switching should centre focus
        x = workArea.x + Math.round(workArea.width / 2 - frame.width / 2);
    } else if (meta_window.fullscreen) {
        x = 0;
    } else if (frame.width > workArea.width * 0.9 - 2 * (Settings.prefs.horizontal_margin + Settings.prefs.window_gap)) {
        // Consider the window to be wide and center it
        x = min + Math.round((workArea.width - frame.width) / 2);
    } else if (x + frame.width > max) {
        // Align to the right prefs.horizontal_margin
        x = max - Settings.prefs.horizontal_margin - frame.width;
    } else if (x < min) {
        // Align to the left prefs.horizontal_margin
        x = min + Settings.prefs.horizontal_margin;
    } else if (x + frame.width === max) {
        // When opening new windows at the end, in the background, we want to
        // show some minimup margin
        x = max - Settings.prefs.minimum_margin - frame.width;
    } else if (x === min) {
        // Same for the start (though the case isn't as common)
        x = min + Settings.prefs.minimum_margin;
    }

    return x;
}

/**
   Make sure that `meta_window` is in view, scrolling the space if needed.
 * @param meta_window
 * @param {Space} space
 * @param {Object} options
 * @param {boolean} options.force
 * @param {boolean} options.moveto if true, executes a move_to animated action
 * @returns
 */
function ensureViewport(meta_window, space, options = {}) {
    space = space || spaces.spaceOfWindow(meta_window);
    let force = options?.force ?? false;
    let moveto = options?.moveto ?? true;

    let index = space.indexOf(meta_window);
    if (index === -1 || space.length === 0)
        return undefined;

    if (space.selectedWindow.fullscreen &&
        !meta_window.fullscreen) {
        animateDown(space.selectedWindow);
    }
    let x = ensuredX(meta_window, space);

    space.selectedWindow = meta_window;
    let selected = space.selectedWindow;
    if (!inPreview && selected.fullscreen) {
        let y = 0;
        let ty = selected.clone.get_transition('y');
        if (!space.isVisible(selected)) {
            selected.clone.y = y;
        } else if (!ty || ty.get_interval().final !== y) {
            Easer.addEase(selected.clone,
                {
                    y,
                    time: Settings.prefs.animation_time,
                    onComplete: space.moveDone.bind(space),
                });
        }
    }

    if (moveto) {
        move_to(space, meta_window, {
            x, force,
        });
    }

    selected.raise();
    Utils.actor_raise(selected.clone);
    updateSelection(space, meta_window);
    space.emit('select');
}

function updateSelection(space, metaWindow) {
    if (!metaWindow) {
        return;
    }
    let clone = metaWindow.clone;
    let cloneActor = clone.cloneActor;

    // first set all selections inactive
    // this means not active workspaces are shown as inactive
    setAllWorkspacesInactive();

    // if metawindow has transient window(s) and it's NOT focused,
    // don't update visual selection (since transient is actually focused)
    if (hasTransient(metaWindow) && metaWindow !== display.focus_window) {
        space.setSelectionInactive();
    }
    else {
        // then set the new selection active
        space.setSelectionActive();
    }

    space.updateWindowPositionBar();

    if (space.selection.get_parent() === clone)
        return;
    Utils.actor_reparent(space.selection, clone);
    clone.set_child_below_sibling(space.selection, cloneActor);
    allocateClone(metaWindow);

    // ensure window is properly activated (if not activated)
    if (space === spaces.activeSpace) {
        if (metaWindow !== display.focus_windoww) {
            Main.activateWindow(metaWindow);
        }
    }
}

/**
 * Move the column containing @meta_window to x, y and propagate the change
 * in @space. Coordinates are relative to monitor and y is optional.
 */
function move_to(space, metaWindow, { x, force, animate }) {
    animate = animate ?? true;
    if (space.indexOf(metaWindow) === -1)
        return;

    let clone = metaWindow.clone;
    let target = x - clone.targetX;
    if (target === space.targetX && !force) {
        space.moveDone();
        return;
    }

    space.targetX = target;

    if (Main.overview.visible) {
        // Do the move immediately, and let the overview take care of animation
        space.cloneContainer.x = target;
        space.moveDone();
        return;
    }

    space.startAnimate();
    Easer.addEase(space.cloneContainer,
        {
            x: target,
            time: Settings.prefs.animation_time,
            instant: !animate,
            onComplete: () => space.moveDone(),
        });

    space.fixOverlays(metaWindow);
}

function grabBegin(metaWindow, type) {
    switch (type) {
    case Meta.GrabOp.COMPOSITOR:
    case Meta.GrabOp.FRAME_BUTTON:
        // Don't handle pushModal grabs and SCD button (close/minimize/etc.) grabs
        break;
    case Meta.GrabOp.KEYBOARD_MOVING:
        inGrab = new Grab.MoveGrab(metaWindow, type);
        if (!isTiled(metaWindow)) {
            return;
        }

        // NOTE: Keyboard grab moves the cursor, but it happens after grab
        // signals have run. Simply delay the dnd so it will get the correct
        // pointer coordinates.
        Utils.later_add(Meta.LaterType.IDLE, () => {
            inGrab.begin();
            inGrab.beginDnD();
        });
        break;
    case Meta.GrabOp.MOVING:
    case Meta.GrabOp.MOVING_UNCONSTRAINED: // introduced in Gnome 44
        if (!isTiled(metaWindow)) {
            return;
        }

        inGrab = new Grab.MoveGrab(metaWindow, type);

        if (Utils.getModiferState() & Clutter.ModifierType.CONTROL_MASK) {
            inGrab.begin();
            inGrab.beginDnD();
        } else if (inGrab.initialSpace && inGrab.initialSpace.indexOf(metaWindow) > -1) {
            inGrab.begin();
        }

        break;
    case Meta.GrabOp.RESIZING_NW:
    case Meta.GrabOp.RESIZING_N:
    case Meta.GrabOp.RESIZING_NE:
    case Meta.GrabOp.RESIZING_E:
    case Meta.GrabOp.RESIZING_SW:
    case Meta.GrabOp.RESIZING_S:
    case Meta.GrabOp.RESIZING_SE:
    case Meta.GrabOp.RESIZING_W:
    case Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN:
    case Meta.GrabOp.KEYBOARD_RESIZING_NW:
    case Meta.GrabOp.KEYBOARD_RESIZING_N:
    case Meta.GrabOp.KEYBOARD_RESIZING_NE:
    case Meta.GrabOp.KEYBOARD_RESIZING_E:
    case Meta.GrabOp.KEYBOARD_RESIZING_SW:
    case Meta.GrabOp.KEYBOARD_RESIZING_S:
    case Meta.GrabOp.KEYBOARD_RESIZING_SE:
    case Meta.GrabOp.KEYBOARD_RESIZING_W:
        inGrab = new Grab.ResizeGrab();
        break;
    }
}

function grabEnd(metaWindow, type) {
    if (!inGrab || inGrab.dnd || inGrab.grabbed)
        return;

    inGrab.end();
    inGrab = false;
}

/**
 * Sets the selected window on other workspaces inactive.
 * Particularly noticable with multi-monitor setups.
 */
function setAllWorkspacesInactive() {
    spaces.forEach(s => s.setSelectionInactive());
}

/**
 * Returns the default focus mode (can be user-defined).
 */
function getDefaultFocusMode() {
    // find matching focus mode
    const mode = Settings.prefs.default_focus_mode;
    const modes = FocusModes;
    let result = null;
    Object.entries(modes).forEach(([k, v]) => {
        if (v === mode) {
            result = k;
        }
    });

    // if found return, otherwise return default
    if (result) {
        return modes[result];
    } else {
        return modes.DEFAULT;
    }
}

// `MetaWindow::focus` handling
function focus_handler(metaWindow, user_data) {
    console.debug("focus:", metaWindow?.title);
    if (Scratch.isScratchWindow(metaWindow)) {
        setAllWorkspacesInactive();
        Scratch.makeScratch(metaWindow);
        TopBar.fixTopBar();
        return;
    }

    // If metaWindow is a transient window, return (after deselecting tiled focus indicators)
    if (isTransient(metaWindow)) {
        setAllWorkspacesInactive();
        return;
    }

    let space = spaces.spaceOfWindow(metaWindow);
    space.monitor.clickOverlay.show();

    /**
       Find the closest neighbours. Remove any dead windows in the process to
       work around the fact that `focus` runs before `window-removed` (and there
       doesn't seem to be a better signal to use)
     */
    let windows = space.getWindows();
    let around = windows.indexOf(metaWindow);
    if (around === -1)
        return;

    let neighbours = [];
    for (let i = around - 1; i >= 0; i--) {
        let w = windows[i];
        if (w.get_compositor_private()) {
            neighbours.push(windows[i]);
            break;
        }
        space.removeWindow(w);
    }
    for (let i = around + 1; i < windows.length; i++) {
        let w = windows[i];
        if (w.get_compositor_private()) {
            neighbours.push(windows[i]);
            break;
        }
        space.removeWindow(w);
    }

    /**
       We need to stack windows in mru order, since mutter picks from the
       stack, not the mru, when auto choosing focus after closing a window.
    */
    let stack = sortWindows(space, neighbours);
    stack.forEach(w => w.raise());
    metaWindow.raise();

    /**
     * Call to move viewport to metaWindow, except if in overview - if in
     * overview, we'll ensure viewport on focused window AFTER overview is
     * hidden.
     */
    ensureViewport(metaWindow, space, { moveto: !Main.overview.visible });

    TopBar.fixTopBar();
}
var focus_wrapper = Utils.dynamic_function_ref('focus_handler', this);

/**
   Push all minimized windows to the scratch layer
 */
function minimizeHandler(metaWindow) {
    console.debug('minimized', metaWindow?.title);
    if (metaWindow.minimized) {
        Scratch.makeScratch(metaWindow);
    }
}
var minimizeWrapper = Utils.dynamic_function_ref('minimizeHandler', this);

/**
  `WindowActor::show` handling

  Kill any falsely shown WindowActor.
*/
function showHandler(actor) {
    let metaWindow = actor.meta_window;
    let onActive = metaWindow.get_workspace() === workspaceManager.get_active_workspace();

    if (!metaWindow.clone.get_parent() && !metaWindow.unmapped)
        return;

    if (metaWindow.unmapped) {
        return;
    }

    if (!onActive ||
        isWindowAnimating(metaWindow) ||
        // The built-in workspace-change animation is running: suppress it
        actor.get_parent() !== global.window_group
    ) {
        animateWindow(metaWindow);
    }
}
var showWrapper = Utils.dynamic_function_ref('showHandler', this);

function showWindow(metaWindow) {
    let actor = metaWindow.get_compositor_private();
    if (!actor)
        return false;
    if (metaWindow.clone?.cloneActor) {
        metaWindow.clone.cloneActor.hide();
        metaWindow.clone.cloneActor.source = null;
    }
    actor.show();
    return true;
}

function animateWindow(metaWindow) {
    let actor = metaWindow.get_compositor_private();
    if (!actor)
        return false;
    if (metaWindow.clone?.cloneActor) {
        metaWindow.clone.cloneActor.show();
        metaWindow.clone.cloneActor.source = actor;
    }
    actor.hide();
    return true;
}

function isWindowAnimating(metaWindow) {
    let clone = metaWindow.clone;
    return clone.get_parent() && clone.cloneActor.visible;
}

function toggleMaximizeHorizontally(metaWindow) {
    metaWindow = metaWindow || display.focus_window;

    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH) {
        // ASSUMPTION: MaximizeFlags.HORIZONTALLY is not used
        metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
        metaWindow.unmaximizedRect = null;
        return;
    }

    let maxWidthPrc = Settings.prefs.maximize_width_percent;
    // add some sane limits to width percents: 0.5 <= x <= 1.0
    maxWidthPrc = Math.max(0.5, maxWidthPrc);
    maxWidthPrc = Math.min(1.0, maxWidthPrc);

    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();
    let frame = metaWindow.get_frame_rect();
    let reqWidth = maxWidthPrc * workArea.width - Settings.prefs.minimum_margin * 2;


    // Some windows only resize in increments > 1px so we can't rely on a precise width
    // Hopefully this heuristic is good enough
    let isFullWidth = (reqWidth - frame.width) < sizeSlack;

    if (isFullWidth && metaWindow.unmaximizedRect) {
        let unmaximizedRect = metaWindow.unmaximizedRect;
        metaWindow.move_resize_frame(
            true, unmaximizedRect.x, frame.y,
            unmaximizedRect.width, frame.height);

        metaWindow.unmaximizedRect = null;
    } else {
        let x = workArea.x + space.monitor.x + Settings.prefs.minimum_margin;
        metaWindow.unmaximizedRect = frame;
        metaWindow.move_resize_frame(true, x, frame.y, reqWidth, frame.height);
    }
}

function resizeHInc(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxHeight = workArea.height - Settings.prefs.horizontal_margin * 2 - Settings.prefs.window_gap;
    let step = Math.floor(maxHeight * 0.1);
    let currentHeight = Math.round(frame.height / step) * step;
    let targetHeight = Math.min(currentHeight + step, maxHeight);
    let targetY = frame.y;

    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH) {
        metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(true, frame.x, targetY, frame.width, targetHeight);
}

function resizeHDec(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxHeight = workArea.height - Settings.prefs.horizontal_margin * 2 - Settings.prefs.window_gap;
    let step = Math.floor(maxHeight * 0.1);
    let currentHeight = Math.round(frame.height / step) * step;
    let minHeight = step;
    let targetHeight = Math.max(currentHeight - step, minHeight);
    let targetY = frame.y;

    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH) {
        metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(true, frame.x, targetY, frame.width, targetHeight);
}

function resizeWInc(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxWidth = workArea.width - Settings.prefs.horizontal_margin * 2 - Settings.prefs.window_gap;
    let step = Math.floor(maxWidth * 0.1);
    let currentWidth = Math.round(frame.width / step) * step;
    let targetWidth = Math.min(currentWidth + step, maxWidth);
    let targetX = frame.x;

    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH) {
        metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(true, targetX, frame.y, targetWidth, frame.height);
}

function resizeWDec(metaWindow) {
    metaWindow = metaWindow || display.focus_window;
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    let maxWidth = workArea.width - Settings.prefs.horizontal_margin * 2 - Settings.prefs.window_gap;
    let step = Math.floor(maxWidth * 0.1);
    let currentWidth = Math.round(frame.width / step) * step;
    let minWidth = step;
    let targetWidth = Math.max(currentWidth - step, minWidth);
    let targetX = frame.x;

    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH) {
        metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(true, targetX, frame.y, targetWidth, frame.height);
}

function getCycleWindowWidths(metaWindow) {
    let steps = Settings.prefs.cycle_width_steps;
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();

    if (steps[0] <= 1) {
        // Steps are specifed as ratios -> convert to pixels
        // Make sure two windows of "compatible" width will have room:
        let availableWidth = workArea.width - Settings.prefs.horizontal_margin * 2 - Settings.prefs.window_gap;
        steps = steps.map(x => Math.floor(x * availableWidth));
    }

    return steps;
}

function cycleWindowWidth(metawindow) {
    return cycleWindowWidthDirection(metawindow, CycleWindowSizesDirection.FORWARD);
}

function cycleWindowWidthBackwards(metawindow) {
    return cycleWindowWidthDirection(metawindow, CycleWindowSizesDirection.BACKWARDS);
}

function cycleWindowWidthDirection(metaWindow, direction) {
    let frame = metaWindow.get_frame_rect();
    let space = spaces.spaceOfWindow(metaWindow);
    let workArea = space.workArea();
    workArea.x += space.monitor.x;

    let findFn = direction === CycleWindowSizesDirection.FORWARD ? Lib.findNext : Lib.findPrev;

    // 10px slack to avoid locking up windows that only resize in increments > 1px
    let targetWidth = Math.min(
        findFn(frame.width, getCycleWindowWidths(metaWindow), sizeSlack),
        workArea.width
    );

    let targetX = frame.x;

    if (Scratch.isScratchWindow(metaWindow)) {
        if (targetX + targetWidth > workArea.x + workArea.width - Settings.prefs.minimum_margin) {
            // Move the window so it remains fully visible
            targetX = workArea.x + workArea.width - Settings.prefs.minimum_margin - targetWidth;
        }
    }

    if (metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH) {
        metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    // Space.layout will ensure the window is moved if necessary
    metaWindow.move_resize_frame(true, targetX, frame.y, targetWidth, frame.height);
}

function cycleWindowHeight(metawindow) {
    return cycleWindowHeightDirection(metawindow, CycleWindowSizesDirection.FORWARD);
}

function cycleWindowHeightBackwards(metawindow) {
    return cycleWindowHeightDirection(metawindow, CycleWindowSizesDirection.BACKWARDS);
}

function cycleWindowHeightDirection(metaWindow, direction) {
    let steps = Settings.prefs.cycle_height_steps;
    let frame = metaWindow.get_frame_rect();

    let space = spaces.spaceOfWindow(metaWindow);
    let i = space.indexOf(metaWindow);

    let findFn = direction === CycleWindowSizesDirection.FORWARD ? Lib.findNext : Lib.findPrev;

    function calcTargetHeight(available) {
        let targetHeight;
        if (steps[0] <= 1) { // ratio steps
            let targetR = findFn(frame.height / available, steps, sizeSlack / available);
            targetHeight = Math.floor(targetR * available);
        } else { // pixel steps
            targetHeight = findFn(frame.height, steps, sizeSlack);
        }
        return Math.min(targetHeight, available);
    }

    if (i > -1) {
        const allocate = (column, available) => {
            // NB: important to not retrieve the frame size inside allocate. Allocation of
            // metaWindow should stay the same during a potential fixpoint evaluation.
            available -= (column.length - 1) * Settings.prefs.window_gap;
            let targetHeight = calcTargetHeight(available);
            return column.map(mw => {
                if (mw === metaWindow) {
                    return targetHeight;
                } else {
                    return Math.floor((available - targetHeight) / (column.length - 1));
                }
            });
        };

        if (space[i].length > 1) {
            space.layout(false, { customAllocators: { [i]: allocate } });
        }
    } else {
        // Not in tiling
        let workspace = metaWindow.get_workspace();
        let available = workspace.get_work_area_for_monitor(metaWindow.get_monitor()).height;
        let targetHeight = calcTargetHeight(available);
        metaWindow.move_resize_frame(true, frame.x, frame.y, frame.width, targetHeight);
    }
}

function activateNthWindow(n, space) {
    space = space || spaces.activeSpace;
    let nth = space[n][0];
    ensureViewport(nth, space);
}

function activateFirstWindow(mw, space) {
    space = space || spaces.activeSpace;
    activateNthWindow(0, space);
}

function activateLastWindow(mw, space) {
    space = space || spaces.activeSpace;
    activateNthWindow(space.length - 1, space);
}

/**
 * Calls `activateWindow` only after an actor is visible and rendered on the stage.
 * The standard `Main.activateWindow(mw)` should be used in general, but this method
 * may be requried under certain use cases (such as activating a floating window
 * programmatically before it's rendered, see
 * https://github.com/paperwm/PaperWM/issues/448 for details).
 */
function activateWindowAfterRendered(actor, mw) {
    callbackOnActorShow(actor, () => {
        Main.activateWindow(mw);
    });
}

/**
 * Centers the currently selected window.
 */
function centerWindowHorizontally(metaWindow) {
    const frame = metaWindow.get_frame_rect();
    const space = spaces.spaceOfWindow(metaWindow);
    const monitor = space.monitor;
    const workArea = space.workArea();

    const targetX = workArea.x + Math.round((workArea.width - frame.width) / 2);
    const dx = targetX - (metaWindow.clone.targetX + space.targetX);

    let [pointerX, pointerY, mask] = global.get_pointer();
    let relPointerX = pointerX - monitor.x - space.cloneContainer.x;
    let relPointerY = pointerY - monitor.y - space.cloneContainer.y;
    /* don't know why we would want to warp pointer on centering window... disabling
    if (Utils.isPointInsideActor(metaWindow.clone, relPointerX, relPointerY)) {
        Utils.warpPointer(pointerX + dx, pointerY);
    }
    */
    if (space.indexOf(metaWindow) === -1) {
        metaWindow.move_frame(true, targetX + monitor.x, frame.y);
    } else {
        move_to(space, metaWindow, {
            x: targetX,
        });
    }
}

/**
 * Sets the focus mode for a space.
 * @param {FocusModes} mode
 * @param {Space} space
 */
function setFocusMode(mode, space) {
    space = space ?? spaces.activeSpace;
    space.focusMode = mode;
    space.focusModeIcon.setMode(mode);
    if (space.hasTopBar) {
        TopBar.focusButton.setFocusMode(mode);
    }

    const workArea = space.workArea();
    const selectedWin = space.selectedWindow;
    // if centre also center selectedWindow
    if (mode === FocusModes.CENTER) {
        if (selectedWin) {
            // check it closer to min or max of workArea
            const frame = selectedWin.get_frame_rect();
            const winMidpoint = space.visibleX(selectedWin) + frame.width / 2;
            const workAreaMidpoint = workArea.width / 2;
            if (winMidpoint <= workAreaMidpoint) {
                space.unfocusXPosition = 0;
            } else {
                space.unfocusXPosition = workArea.width;
            }
            centerWindowHorizontally(selectedWin);
        }
    }

    // if normal and has saved x position from previous
    if (mode === FocusModes.DEFAULT && space.unfocusXPosition != null) {
        // if window is first, move to left edge
        let position;
        if (space.indexOf(selectedWin) == 0) {
            position = 0;
        }
        // if windows is last, move to right edge
        else if (space.indexOf(selectedWin) == space.length - 1) {
            position = workArea.width;
        }
        else {
            position = space.unfocusXPosition;
        }
        // do the move
        move_to(space, space.selectedWindow, { x: position });
        ensureViewport(space.selectedWindow, space, { force: true });
        space.unfocusXPosition = null;
    }
}

/**
 * Switches to the next focus mode for a space.
 * @param {Space} space
 */
function switchToNextFocusMode(space) {
    space = space ?? spaces.activeSpace;
    const numModes = Object.keys(FocusModes).length;
    // for currMode we switch to 1-based to use it validly in remainder operation
    const currMode = Object.values(FocusModes).indexOf(space.focusMode) + 1;
    const nextMode = currMode % numModes;
    setFocusMode(nextMode, space);
}

/**
 * "Fit" values such that they sum to `targetSum`
 */
function fitProportionally(values, targetSum) {
    let sum = Lib.sum(values);
    let weights = values.map(v => v / sum);

    let fitted = Lib.zip(values, weights).map(
        ([h, w]) => Math.round(targetSum * w)
    );
    let r = targetSum - Lib.sum(fitted);
    fitted[0] += r;
    return fitted;
}

function allocateDefault(column, availableHeight, selectedWindow) {
    if (column.length === 1) {
        return [availableHeight];
    } else {
        // Distribute available height amongst non-selected windows in proportion to their existing height
        const gap = Settings.prefs.window_gap;
        const minHeight = 50;

        function heightOf(mw) {
            return mw._targetHeight || mw.get_frame_rect().height;
        }

        const k = selectedWindow && column.indexOf(selectedWindow);
        const selectedHeight = selectedWindow && heightOf(selectedWindow);

        let nonSelected = column.slice();
        if (selectedWindow)
            nonSelected.splice(k, 1);

        const nonSelectedHeights = nonSelected.map(heightOf);
        let availableForNonSelected = Math.max(
            0,
            availableHeight -
                (column.length - 1) * gap -
                (selectedWindow ? selectedHeight : 0)
        );

        const deficit = Math.max(
            0, nonSelected.length * minHeight - availableForNonSelected);

        let heights = fitProportionally(
            nonSelectedHeights,
            availableForNonSelected + deficit
        );

        if (selectedWindow)
            heights.splice(k, 0, selectedHeight - deficit);

        return heights;
    }
}

function allocateEqualHeight(column, available) {
    available -= (column.length - 1) * Settings.prefs.window_gap;
    return column.map(_ => Math.floor(available / column.length));
}

/*
* pull in the top window from the column to the right. if there is no
* column to the right, push active window into column to the left.
* this allows freshly created windows to be stacked without
* having to change focus
*/
function slurp(metaWindow) {
    let space = spaces.spaceOfWindow(metaWindow);
    let index = space.indexOf(metaWindow);

    let to, from;
    let metaWindowToEnsure = space.selectedWindow;
    let metaWindowToSlurp;

    if (index + 1 < space.length) {
        to = index;
        from = to + 1;
        metaWindowToSlurp = space[from][0];
    } else if (index + 1 === space.length) {
        if (space[index].length > 1)
            return;
        metaWindowToSlurp = metaWindow;
        metaWindowToEnsure = metaWindowToSlurp;
        to = index - 1;
        from = index;
    }

    if (!metaWindowToSlurp || space.length < 2) {
        return;
    }

    space[to].push(metaWindowToSlurp);

    { // Remove the slurped window
        let column = space[from];
        let row = column.indexOf(metaWindowToSlurp);
        column.splice(row, 1);
        if (column.length === 0)
            space.splice(from, 1);
    }

    space.layout(true, {
        customAllocators: { [to]: allocateEqualHeight },
    });
    space.emit("full-layout");
    ensureViewport(metaWindowToEnsure, space, { force: true });
}

function barf(metaWindow) {
    if (!metaWindow)
        return;

    let space = spaces.spaceOfWindow(metaWindow);
    let index = space.indexOf(metaWindow);
    if (index === -1)
        return;

    let column = space[index];
    if (column.length < 2)
        return;

    let bottom = column.splice(-1, 1)[0];
    space.splice(index + 1, 0, [bottom]);

    space.layout(true, {
        customAllocators: { [index]: allocateEqualHeight },
    });
    space.emit("full-layout");
    ensureViewport(space.selectedWindow, space, { force: true });
}

function selectPreviousSpace(mw, space) {
    spaces.selectStackSpace(Meta.MotionDirection.DOWN);
}

function selectPreviousSpaceBackwards(mw, space) {
    spaces.selectStackSpace(Meta.MotionDirection.UP);
}

function movePreviousSpace(mw, space) {
    spaces.selectStackSpace(Meta.MotionDirection.DOWN, true);
}

function movePreviousSpaceBackwards(mw, space) {
    spaces.selectStackSpace(Meta.MotionDirection.UP, true);
}

function selectDownSpace(mw, space) {
    spaces.selectSequenceSpace(Meta.MotionDirection.DOWN);
}

function selectUpSpace(mw, space) {
    spaces.selectSequenceSpace(Meta.MotionDirection.UP);
}

function moveDownSpace(mw, space) {
    spaces.selectSequenceSpace(Meta.MotionDirection.DOWN, true);
}

function moveUpSpace(mw, space) {
    spaces.selectSequenceSpace(Meta.MotionDirection.UP, true);
}

/**
   Detach the @metaWindow, storing it at the bottom right corner while
   navigating. When done, insert all the detached windows again.
   Activates last taken window when navigator operation complete.
 */
function takeWindow(metaWindow, space, { navigator }) {
    space = space || spaces.selectedSpace;
    metaWindow = metaWindow || space.selectedWindow;
    navigator = navigator || Navigator.getNavigator();
    if (!space.removeWindow(metaWindow))
        return;

    if (!navigator._moving) {
        navigator._moving = [];
        signals.connectOneShot(navigator, 'destroy', () => {
            let selectedSpace = spaces.selectedSpace;
            navigator._moving.forEach(w => {
                w.change_workspace(selectedSpace.workspace);
                if (w.get_workspace() === selectedSpace.workspace) {
                    insertWindow(w, { existing: true });

                    // make space selectedWindow (keeps index for next insert)
                    selectedSpace.selectedWindow = w;
                }
            });

            // activate last metaWindow after taken windows inserted
            let firstWindow = navigator._moving.find(v => v !== undefined);
            if (firstWindow) {
                Utils.later_add(Meta.LaterType.IDLE, () => {
                    Main.activateWindow(firstWindow);
                });
            }

            // clean up after move
            navigator._moving = [];
        });
    }

    navigator._moving.push(metaWindow);
    let parent = backgroundGroup;
    parent.add_actor(metaWindow.clone);
    let lowest = navigator._moving[navigator._moving.length - 2];
    lowest && parent.set_child_below_sibling(metaWindow.clone, lowest.clone);
    let point = space.cloneContainer.apply_relative_transform_to_point(
        parent, new Graphene.Point3D({
            x: metaWindow.clone.x,
            y: metaWindow.clone.y,
        }));
    metaWindow.clone.set_position(point.x, point.y);
    let x = Math.round(space.monitor.x +
        space.monitor.width -
        (0.1 * space.monitor.width * (1 + navigator._moving.length)));
    let y = Math.round(space.monitor.y + space.monitor.height * 2 / 3) +
        20 * navigator._moving.length;
    animateWindow(metaWindow);
    Easer.addEase(metaWindow.clone,
        {
            x, y,
            time: Settings.prefs.animation_time,
        });
}

/**
   Sort the @windows based on their clone's stacking order
   in @space.cloneContainer.
 */
function sortWindows(space, windows) {
    if (windows.length === 1)
        return windows;
    let clones = windows.map(w => w.clone);
    return space.cloneContainer.get_children()
        .filter(c => clones.includes(c))
        .map(c => c.meta_window);
}

function rotated(list, dir = 1) {
    return [].concat(
        list.slice(dir),
        list.slice(0, dir)
    );
}

function cycleWorkspaceSettings(dir = 1) {
    let n = workspaceManager.get_n_workspaces();
    let N = Workspace.getWorkspaceList().get_strv('list').length;
    let space = spaces.selectedSpace;
    let wsI = space.index;

    // 2 6 7 8   <-- indices
    // x a b c   <-- settings
    // a b c x   <-- rotated settings

    let uuids = Workspace.getWorkspaceList().get_strv('list');
    // Work on tuples of [uuid, settings] since we need to uuid association
    // in the last step
    let settings = uuids.map(
        uuid => [uuid, Workspace.getWorkspaceSettingsByUUID(uuid)]
    );
    settings.sort((a, b) => a[1].get_int('index') - b[1].get_int('index'));

    let unbound = settings.slice(n);
    let strip = [settings[wsI]].concat(unbound);

    strip = rotated(strip, dir);

    let nextSettings = strip[0];
    unbound = strip.slice(1);

    nextSettings[1].set_int('index', wsI);
    space.setSettings(nextSettings); // ASSUMPTION: ok that two settings have same index here

    // Re-assign unbound indices:
    for (let i = n; i < N; i++) {
        unbound[i - n][1].set_int('index', i);
    }
    return space;
}

// Backward compatibility
function defwinprop(...args) {
    return Settings.defwinprop(...args);
}
