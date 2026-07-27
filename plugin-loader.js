const fs = require('fs');
const path = require('path');

// Plugins directory — set by main.js to the user data directory.
// Falls back to the project's plugins/ folder if not configured.
let PLUGINS_DIR = null;
let plugins = new Map();
let watchTimer = null;

/**
 * Set the plugins directory path. Called by main.js at startup.
 * @param {string} dirPath - Absolute path to the plugins directory
 */
function setPluginsDir(dirPath) {
	PLUGINS_DIR = dirPath;
}

/** Return the current plugins directory path. */
function getPluginsDir() {
	return PLUGINS_DIR || path.join(__dirname, 'plugins');
}

/**
 * Scan the plugins directory and load all valid plugin files.
 * Clears the require cache so updated plugins are reloaded.
 */
function loadPlugins() {
	const pluginsDir = getPluginsDir();
	plugins.clear();

	if (!fs.existsSync(pluginsDir)) {
		fs.mkdirSync(pluginsDir, { recursive: true });
		return plugins;
	}

	const files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));

	for (const file of files) {
		const filePath = path.join(pluginsDir, file);

		// Clear require cache so changes are picked up
		try { delete require.cache[require.resolve(filePath)]; } catch { /* ignore */ }

		try {
			const plugin = require(filePath);
			if (plugin.name && plugin.schema && typeof plugin.execute === 'function') {
				plugins.set(plugin.name, plugin);
			} else {
				console.warn(`Plugin ${file}: missing required fields (name, schema, execute)`);
			}
		} catch (err) {
			console.error(`Failed to load plugin ${file}:`, err.message);
		}
	}

	return plugins;
}

/** Return the current plugins Map. */
function getPlugins() {
	return plugins;
}

/**
 * Return an array of all tool schemas from loaded plugins.
 */
function getSchemas() {
	const schemas = [];
	for (const [, plugin] of plugins) {
		schemas.push(plugin.schema);
	}
	return schemas;
}

/**
 * Watch the plugins directory for file changes.
 * Uses chokidar (loaded via dynamic import) for reliable cross-platform file watching.
 * Debounces at 500ms to avoid firing mid-write.
 * Calls callback() after reloading on each change.
 */
async function watchPlugins(callback) {
	const pluginsDir = getPluginsDir();
	if (!fs.existsSync(pluginsDir)) {
		fs.mkdirSync(pluginsDir, { recursive: true });
	}

	try {
		const chokidar = await import('chokidar');
		const watcher = chokidar.watch(pluginsDir, { ignoreInitial: true, persistent: true });
		watcher.on('all', (event) => {
			clearTimeout(watchTimer);
			watchTimer = setTimeout(() => {
				loadPlugins();
				if (callback) callback();
			}, 500);
		});
		return watcher;
	} catch (err) {
		console.warn('Could not watch plugins directory:', err.message);
	}
}

module.exports = { loadPlugins, getPlugins, getSchemas, watchPlugins, setPluginsDir, getPluginsDir };
// Kept for backward compat — resolved dynamically now
Object.defineProperty(module.exports, 'PLUGINS_DIR', {
	get() { return getPluginsDir(); }
});
