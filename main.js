const { app, BrowserWindow, ipcMain, dialog, nativeTheme, session } = require("electron");
const path = require("path");
const fs = require("fs");
const pluginLoader = require("./plugin-loader");
const sandbox = require("./sandbox");
const { validateToolExecution } = require("./safety");

// ============================================================================
// Constants
// ============================================================================

const RESOURCES = __dirname;
const isWin = process.platform === "win32"; // custom titleBar only on Windows

// User data directory: app.getPath('userData') already includes the app name.
// Windows: %APPDATA%/bare  |  macOS: ~/Library/Application Support/bare  |  Linux: ~/.config/bare
// Stores: bare.json, tool-plugin-template.js
const userDataDir = app.getPath('userData');

// ============================================================================
// State
// ============================================================================

let win = null;
// All persistent data lives in userDataDir (%APPDATA%/bare on Windows).
const sessionFile = path.join(userDataDir, "session.json");
const settingsFile = path.join(userDataDir, "bare.json");

/** Default settings — written to settingsFile on first launch or if deleted */
const DEFAULT_SETTINGS = {
	serverType: 'llamacpp',
	serverHost: '127.0.0.1',
	serverPort: '8080',
	model: '',
	theme: 'light',
	restrictToWorkDir: false,
	readOnly: false,
	requireToolPermission: true,
	bareMode: false,
	verbose: false,
	workdirWarningDismissed: false,
	permWarningDismissed: false,
	restrictPromptDismissed: false,
	workDir: '',
};

/** Ensure settings file exists with defaults if missing */
function ensureSettingsFile() {
	if (!fs.existsSync(settingsFile)) {
		try {
			fs.writeFileSync(settingsFile, JSON.stringify({ settings: DEFAULT_SETTINGS }, null, 2), 'utf8');
			console.log('[init] created', settingsFile, 'with defaults');
		} catch (e) {
			console.warn('[init] failed to create settings file:', e.message);
		}
	}
}

/** Copy a bundled file to userDataDir. If force is true, always overwrite (reference files). */
function copyBundledFile(basename, force) {
	const src = path.join(RESOURCES, basename);
	const dst = path.join(userDataDir, basename);
	if (fs.existsSync(src) && (!fs.existsSync(dst) || force)) {
		try {
			fs.copyFileSync(src, dst);
			console.log('[init] copied', basename, 'to', userDataDir);
		} catch (e) {
			console.warn('[init] failed to copy', basename, ':', e.message);
		}
	}
}

/** Ensure user data dir exists and copy bundled files on first launch */
function ensureUserData() {
	fs.mkdirSync(userDataDir, { recursive: true });

	ensureSettingsFile();
	copyBundledFile("tool-plugin-template.js", true);  // always overwrite (reference spec)
	writeDefaultFile("system-prompt-addition.md", "You are Bare, a coding agent.");
}

/** Write a default file to userDataDir if it doesn't exist yet */
function writeDefaultFile(basename, content) {
	const dst = path.join(userDataDir, basename);
	if (!fs.existsSync(dst)) {
		try {
			fs.writeFileSync(dst, content, 'utf8');
			console.log('[init] created', basename, 'in', userDataDir);
		} catch (e) {
			console.warn('[init] failed to create', basename, ':', e.message);
		}
	}
}

/** Path to the tool plugin template in userDataDir */
function getTemplatePath() {
	return path.join(userDataDir, "tool-plugin-template.js");
}

// Load workDir from settings. Falls back to empty string (renderer will prompt user).
function loadWorkDir() {
	const settings = loadSettings();
	return settings?.workDir || '';
}

let workDir = loadWorkDir();

/** Save workDir to bare.json and sync to renderer */
function saveWorkDir(dir) {
	try {
		const current = loadSettings() || { ...DEFAULT_SETTINGS };
		current.workDir = dir;
		fs.writeFileSync(settingsFile, JSON.stringify({ settings: current }, null, 2), "utf8");
		console.log('[main] saveWorkDir wrote', dir, 'to', settingsFile);
		// Notify renderer of the change so window.__settings stays in sync
		if (win && !win.isDestroyed()) {
			win.webContents.send('settings:workdir-changed', dir);
		}
	} catch (e) { console.error('[main] saveWorkDir failed:', e); }
}

/** Load current settings from bare.json (auto-creates with defaults if missing) */
let _settingsParseErrorLogged = false;
function loadSettings() {
	try {
		if (fs.existsSync(settingsFile)) {
			const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
			// Normal structure: { settings: { ... } }
			if (raw.settings && typeof raw.settings === 'object') {
				return raw.settings;
			}
			// Corrupted: user may have deleted the "settings" wrapper.
			// If the top-level looks like a settings object (has known keys), recover it.
			if (raw.serverType !== undefined || raw.workDir !== undefined || raw.theme !== undefined) {
				if (!_settingsParseErrorLogged) {
					console.log('[settings] recovered bare.json (missing settings wrapper) — values preserved');
					_settingsParseErrorLogged = true;
				}
				return { ...DEFAULT_SETTINGS, ...raw };
			}
		}
	} catch (e) {
		// Invalid JSON — back up corrupt file and recreate
		if (fs.existsSync(settingsFile) && !_settingsParseErrorLogged) {
			try {
				const backupPath = settingsFile + '.backup';
				fs.copyFileSync(settingsFile, backupPath);
				console.log('[settings] invalid bare.json — backed up to', backupPath);
			} catch {} // ignore backup failures
			ensureSettingsFile();
			_settingsParseErrorLogged = true;
		}
		return { ...DEFAULT_SETTINGS };
	}
	// File missing — create with defaults
	ensureSettingsFile();
	return { ...DEFAULT_SETTINGS };
}

// ============================================================================
// Plugin lifecycle
// ============================================================================

ensureUserData();

pluginLoader.loadPlugins();

pluginLoader.watchPlugins(() => {
	if (win && !win.isDestroyed()) {
		win.webContents.send("tools:changed");
	}
}); // async, fire-and-forget

// ============================================================================
// IPC handlers
// ============================================================================

ipcMain.handle("tool:execute", async (_event, toolName, args) => {
	const plugins = pluginLoader.getPlugins();
	const plugin = plugins.get(toolName);
	if (!plugin) throw new Error(`Unknown tool: ${toolName}`);

	// All safety checks are in safety.js
	const settings = loadSettings();
	const blocked = validateToolExecution(toolName, args, settings, workDir);
	if (blocked) throw new Error(blocked);

	return plugin.execute(args, { workDir, settingsFile, templatePath: getTemplatePath(), userDataDir });
});

ipcMain.handle("tools:get-schemas", async () => {
	return pluginLoader.getSchemas();
});

ipcMain.handle("app:template-path", async () => {
	return getTemplatePath();
});

// Return the user data directory path (used by read.js for whitelist)
ipcMain.handle("app:user-data-dir", async () => {
	return userDataDir;
});

// System prompt addition: read from user data file, fallback to inline default
ipcMain.handle("app:system-prompt-addition", async () => {
	const filePath = path.join(userDataDir, "system-prompt-addition.md");
	try {
		if (fs.existsSync(filePath)) {
			return fs.readFileSync(filePath, 'utf-8').trim();
		}
	} catch { /* ignore */ }
	return 'You are Bare, a coding agent.';
});

ipcMain.handle("app:platform", async () => {
	return sandbox.OS_NAME;
});

ipcMain.handle("fs:workdir", async (_event, newDir) => {
	if (newDir) {
		workDir = newDir;
		saveWorkDir(newDir);
	}
	return workDir;
});

ipcMain.handle("fs:pick-folder", async () => {
	if (!win) return workDir;
	const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"], defaultPath: workDir });
	console.log('[main] fs:pick-folder result:', result.canceled ? 'canceled' : result.filePaths[0]);
	if (!result.canceled && result.filePaths.length > 0) {
		workDir = result.filePaths[0];
		saveWorkDir(workDir);
		return workDir;
	}
	// Return null when canceled so renderer knows to stay on the prompt
	return null;
});

// -- Session persistence --

function _save(data) {
	try {
		fs.writeFileSync(sessionFile, JSON.stringify(data), "utf8");
	} catch (e) {
		console.error("Failed to save session:", e);
	}
}

ipcMain.handle("session:save", async (_event, data) => { _save(data); });

ipcMain.handle("session:load", async () => {
	try {
		if (fs.existsSync(sessionFile)) {
			return JSON.parse(fs.readFileSync(sessionFile, "utf8"));
		}
	} catch (e) { console.error("Failed to load session:", e); }
	return null;
});

ipcMain.handle("session:clear", async () => {
	try {
		if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
		// Also clear the full session dump if it exists
		const fullSessionFile = path.join(userDataDir, 'full_session.json');
		if (fs.existsSync(fullSessionFile)) fs.unlinkSync(fullSessionFile);
	} catch (e) { console.error("Failed to clear session:", e); }
});

ipcMain.handle("session:save-full", async (_event, data) => {
	try {
		const fullPath = path.join(userDataDir, 'full_session.json');
		fs.writeFileSync(fullPath, JSON.stringify({ history: data.history }, null, 2), "utf8");
	} catch (e) {
		console.error("Failed to save full session:", e);
	}
});

// -- Settings persistence --

ipcMain.handle("settings:save", async (_event, settings) => {
	try {
		// Always write { settings: ... } to prevent corruption from manual edits
		fs.writeFileSync(settingsFile, JSON.stringify({ settings }, null, 2), "utf8");
		console.log('[settings] saved to', settingsFile, 'workDir=', settings?.workDir);
	} catch (e) {
		console.error('[settings] save failed:', e);
		throw e;
	}
});

ipcMain.handle("settings:load", async () => { return loadSettings(); });

// -- Title bar overlay helpers — Windows only --

let _settingsOpen = false;  // tracks whether settings overlay is visible
let _liveBareMode = false;  // live bareMode state from renderer (file may be stale)

/** Compute overlay colours for a given theme and state */
function _overlayFor(theme, dim, bareMode) {
	const bg = theme === "dark" ? "#0d0d0d" : "#ffffff";
	const dimmedBg = theme === "dark" ? "#090909" : "#b3b3b3";
	const effectiveBg = dim ? dimmedBg : bg;
	if (bareMode) return { color: effectiveBg, symbolColor: effectiveBg };  // BARE: buttons hidden
	if (dim) {
		return {
			color: dimmedBg,
			symbolColor: theme === "dark" ? "#555555" : "#777777",
		};
	}
	return {
		color: bg,
		symbolColor: theme === "dark" ? "#f5f5f5" : "#111111",
	};
}

/** Apply overlay using live state from renderer */
function _applyOverlay(theme, bareMode) {
	if (!isWin || !win || win.isDestroyed()) return;
	const settings = loadSettings();
	const bm = bareMode ?? _liveBareMode ?? !!settings?.bareMode;
	const th = theme || settings?.theme || 'light';
	win.setTitleBarOverlay(_overlayFor(th, _settingsOpen, bm));
}

ipcMain.handle("theme:apply", async (_event, { color, symbolColor, theme, bareMode }) => {
	if (!isWin || !win || win.isDestroyed()) return;
	if (bareMode !== undefined) _liveBareMode = !!bareMode;
	// If settings panel is open, re-dim instead of using normal colours
	if (_settingsOpen) {
		_applyOverlay(theme, bareMode);
		return;
	}
	const bm = _liveBareMode ?? !!loadSettings()?.bareMode;
	if (bm) symbolColor = color;
	win.setTitleBarOverlay({ color, symbolColor });
});

ipcMain.handle("theme:dim", async (_event, { dim, theme, bareMode }) => {
	if (!isWin || !win || win.isDestroyed()) return;
	_settingsOpen = !!dim;
	if (bareMode !== undefined) _liveBareMode = !!bareMode;
	_applyOverlay(theme, bareMode);
});

// -- BARE mode: hide title bar buttons by blending symbol color into bg --
ipcMain.handle("bare-mode:apply", async (_event, { on, theme }) => {
	if (!isWin || !win || win.isDestroyed()) return;
	_liveBareMode = !!on;
	_applyOverlay(theme, on);
});

// ============================================================================
// App lifecycle
// ============================================================================

app.whenReady().then(() => {
	sandbox.load(settingsFile);

	const settings = loadSettings();
	const savedTheme = settings?.theme || (nativeTheme.shouldUseDarkColors ? "dark" : "light");
	const savedBareMode = !!settings?.bareMode;

	const windowOpts = {
		width: 1200,
		height: 900,
		autoHideMenuBar: true,
		backgroundColor: savedTheme === "dark" ? "#0d0d0d" : "#ffffff",
		title: "bare",
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: false,
			preload: path.join(RESOURCES, "preload.cjs"),
			session: session.fromPartition('bare-inmemory'),
		},
	};

	// Custom title bar (hidden + overlay) is Windows-only.
	// macOS/Linux get the native frame with autoHideMenuBar.
	if (isWin) {
		windowOpts.titleBarStyle = "hidden";
		const bg = savedTheme === "dark" ? "#0d0d0d" : "#ffffff";
		const sym = savedBareMode ? bg : (savedTheme === "dark" ? "#f5f5f5" : "#111111");
		windowOpts.titleBarOverlay = { color: bg, symbolColor: sym };
	}

	win = new BrowserWindow(windowOpts);

	// Pass saved theme as a query param so an inline script in <head>
	// can set data-theme synchronously before the first paint.
	const indexPath = path.join(RESOURCES, "index.html");
	const themedUrl = `file://${indexPath}?theme=${savedTheme}`;
	win.loadURL(themedUrl);

	win.webContents.on("before-input-event", (_event, { key }) => {
		if (key === "F10" || key === "F12") {
			win.webContents.toggleDevTools();
		}
	});
});

app.on("will-quit", () => {});
app.on("window-all-closed", () => app.quit());
