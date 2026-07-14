const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = path.join(__dirname, 'plugins');
let plugins = new Map();
let watchTimer = null;

/**
 * Scan the plugins/ directory and load all valid plugin files.
 * Clears the require cache so updated plugins are reloaded.
 */
function loadPlugins() {
	plugins.clear();

	if (!fs.existsSync(PLUGINS_DIR)) {
		fs.mkdirSync(PLUGINS_DIR, { recursive: true });
		return plugins;
	}

	const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));

	for (const file of files) {
		const filePath = path.join(PLUGINS_DIR, file);

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
 * Watch the plugins/ directory for file changes.
 * Uses chokidar (loaded via dynamic import) for reliable cross-platform file watching.
 * Debounces at 500ms to avoid firing mid-write.
 * Calls callback() after reloading on each change.
 */
async function watchPlugins(callback) {
	if (!fs.existsSync(PLUGINS_DIR)) {
		fs.mkdirSync(PLUGINS_DIR, { recursive: true });
	}

	try {
		const chokidar = await import('chokidar');
		const watcher = chokidar.watch(PLUGINS_DIR, { ignoreInitial: true, persistent: true });
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

module.exports = { loadPlugins, getPlugins, getSchemas, watchPlugins, PLUGINS_DIR };
