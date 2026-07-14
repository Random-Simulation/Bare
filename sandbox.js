const fs = require('fs');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

/** Human-readable OS name for system prompt */
const OS_NAME = isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux';

/** Shared defaults — apply on every platform */
const sharedDefaults = {
	protectedPaths: [
		'.env',
		'.git/',
		'node_modules/',
		'.gitconfig',
		'.npmrc',
		'.yarnrc',
	],
	blockedPaths: [],
};

/** Linux-only additions */
const linuxDefaults = {
	protectedPaths: [],
	blockedPaths: [
		'/etc/',
		'/dev/',
		'/var/',
		'/usr/',
	],
};

/** macOS-only additions */
const macDefaults = {
	protectedPaths: [],
	blockedPaths: [
		'/System/',
		'/usr/',
		'/var/',
	],
};

/** Windows-only additions */
const windowsDefaults = {
	protectedPaths: [],
	blockedPaths: [
		'\\windows\\',
		'\\program files\\',
		'\\programdata\\',
	],
};

/** Merge two config objects into a single DEFAULTS shape */
function mergeDefaults(base, overlay) {
	return {
		protectedPaths: [...base.protectedPaths, ...(overlay.protectedPaths || [])],
		blockedPaths: [...base.blockedPaths, ...(overlay.blockedPaths || [])],
	};
}

const DEFAULTS = isWindows
	? mergeDefaults(sharedDefaults, windowsDefaults)
	: isMac
		? mergeDefaults(sharedDefaults, macDefaults)
		: mergeDefaults(sharedDefaults, linuxDefaults);

let rules = null;

/**
 * Load sandbox rules from bare.json.
 * Falls back to DEFAULTS if the file doesn't exist or is invalid.
 * Call once at startup with the path to bare.json.
 */
function load(settingsPath) {
	if (rules) return rules;
	try {
		if (settingsPath && fs.existsSync(settingsPath)) {
			const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
			rules = raw.sandbox || DEFAULTS;
		} else {
			rules = DEFAULTS;
		}
	} catch {
		rules = DEFAULTS;
	}
	return rules;
}

/**
 * Normalize a path for cross-platform comparison:
 *   - Convert all backslashes to forward slashes
 *   - Lowercase on Windows (case-insensitive filesystem)
 */
function normalize(str) {
	return isWindows ? str.replace(/\\/g, '/').toLowerCase() : str.replace(/\\/g, '/');
}

/**
 * Check a file path against protected + blocked paths.
 * Returns an error message string if blocked, or null if allowed.
 */
function checkPath(filePath) {
	const r = rules || load();
	const all = [...r.protectedPaths, ...r.blockedPaths];
	const normalized = normalize(filePath);
	for (const p of all) {
		if (normalized.includes(normalize(p))) {
			return `Blocked: path '${p}' is protected`;
		}
	}
	return null;
}

/**
 * Check a bash command string against blocked paths.
 * Returns an error message string if blocked, or null if allowed.
 */
function checkCommand(command) {
	const r = rules || load();
	const normalized = normalize(command);

	// Block commands targeting filesystem root or drive roots
	// Linux: standalone "/" as a command argument (e.g., "rm -rf /")
	if (!isWindows && /(?:^|\s)\/(?:\s|$)/.test(normalized)) {
		return 'Blocked: command targets filesystem root';
	}
	// Windows: standalone drive root like "c:\" or "c:" as a command argument
	if (isWindows && /(?:^|\s)[a-z]:[\/\\]?(?:\s|$)/.test(normalized)) {
		return 'Blocked: command targets drive root';
	}

	// Check against both protected and blocked paths
	const all = [...r.protectedPaths, ...r.blockedPaths];
	for (const p of all) {
		if (normalized.includes(normalize(p))) {
			return `Blocked: command targets protected path '${p}'`;
		}
	}
	return null;
}

module.exports = { load, checkPath, checkCommand, OS_NAME };
