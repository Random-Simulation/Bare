import { friendlyError, getApiUrl, getApiHeaders } from './utils.js';
import { applyVerboseMode, initToolLog } from './verbose-mode.js';

/* ------------------------------------------------------------------ */
/* Settings state                                                     */
/* ------------------------------------------------------------------ */
window.__settings = {
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

/* ------------------------------------------------------------------ */
/* DOM refs                                                           */
/* ------------------------------------------------------------------ */
const settingsOverlay = document.getElementById('settings-overlay');
const serverHostInput = document.getElementById('server-host');
const serverPortInput = document.getElementById('server-port');

/* ------------------------------------------------------------------ */
/* Custom Select helper                                               */
/* ------------------------------------------------------------------ */
export function getCustomSelectValue(name) {
	const btn = document.querySelector(`.custom-select-btn[data-select="${name}"]`);
	return btn?.dataset.value ?? '';
}

export function setCustomSelectValue(name, value) {
	const wrapper = document.querySelector(`.custom-select-btn[data-select="${name}"]`);
	if (!wrapper) return;
	wrapper.dataset.value = value;
	const label = wrapper.querySelector('.custom-select-label');
	// Use JS loop instead of CSS selector — paths with quotes/backslashes break attribute selectors
	const options = wrapper.parentElement.querySelectorAll('.custom-select-option');
	let matchedOption = null;
	options.forEach(opt => {
		if (opt.dataset.value === value) matchedOption = opt;
		opt.classList.toggle('selected', opt.dataset.value === value);
	});
	if (label) label.textContent = matchedOption?.textContent ?? value;
}

export function populateCustomSelect(name, items) {
	// items = [{ value, label }]
	const wrapper = document.querySelector(`.custom-select-btn[data-select="${name}"]`)?.parentElement;
	if (!wrapper) return;
	const dropdown = wrapper.querySelector('.custom-select-dropdown');
	if (!dropdown) return;
	dropdown.innerHTML = '';
	for (const item of items) {
		const div = document.createElement('div');
		div.className = 'custom-select-option';
		div.dataset.value = item.value;
		div.dataset.select = name;
		div.textContent = item.label;
		if (item.value === getCustomSelectValue(name)) {
			div.classList.add('selected');
		}
		dropdown.appendChild(div);
	}
}

function initCustomSelects() {
	// Toggle dropdown open/close (event delegation for dynamically created buttons)
	document.addEventListener('click', (e) => {
		const btn = e.target.closest('.custom-select-btn');
		const option = e.target.closest('.custom-select-option');

		if (btn) {
			e.stopPropagation();
			const wasOpen = btn.classList.contains('open');
			closeAllCustomSelects();
			if (!wasOpen) {
				btn.classList.add('open');
				btn.parentElement.querySelector('.custom-select-dropdown')?.classList.add('open');
			}
			return;
		}

		if (option) {
			e.stopPropagation();
			const name = option.dataset.select;
			const value = option.dataset.value;
			const selectBtn = document.querySelector(`.custom-select-btn[data-select="${name}"]`);
			if (selectBtn) {
				selectBtn.dataset.value = value;
				selectBtn.querySelector('.custom-select-label').textContent = option.textContent;
			}
			option.parentElement.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
			option.classList.add('selected');
			closeAllCustomSelects();

			// Trigger change events
			if (name === 'server-type') handleServerTypeChange(value);
			if (name === 'model') window.__settings.model = value;
			return;
		}

		// Close dropdowns when clicking outside
		closeAllCustomSelects();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') closeAllCustomSelects();
	});
}

function closeAllCustomSelects() {
	document.querySelectorAll('.custom-select-btn').forEach(btn => btn.classList.remove('open'));
	document.querySelectorAll('.custom-select-dropdown').forEach(dd => dd.classList.remove('open'));
}

function handleServerTypeChange(value) {
	window.__settings.serverType = value;
	if (value === 'ollama') {
		serverPortInput.value = '11434';
		window.__settings.serverPort = '11434';
	} else if (value === 'vllm') {
		serverPortInput.value = '8000';
		window.__settings.serverPort = '8000';
	} else if (value === 'llamacpp') {
		serverPortInput.value = '8080';
		window.__settings.serverPort = '8080';
	} else if (value === 'lmstudio') {
		serverPortInput.value = '1234';
		window.__settings.serverPort = '1234';
	} else if (value === 'custom') {
		serverPortInput.value = '8080';
		window.__settings.serverPort = '8080';
	}
}
const testConnectionBtn = document.getElementById('test-connection-btn');
const connectionStatus = document.getElementById('connection-status');
const themeToggle = document.getElementById('theme-toggle');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const restrictWorkdirToggle = document.getElementById('restrict-workdir-toggle');
const workdirWarning = document.getElementById('workdir-warning');
const readOnlyToggle = document.getElementById('read-only-toggle');
const requirePermToggle = document.getElementById('require-perm-toggle');
const permWarning = document.getElementById('perm-warning');
const bareModeToggle = document.getElementById('bare-mode-toggle');
const verboseToggle = document.getElementById('verbose-toggle');

/* ------------------------------------------------------------------ */
/* Theme helpers                                                      */
/* ------------------------------------------------------------------ */
const titleBarOverlayColors = {
	light: { color: '#ffffff', symbolColor: '#111111' },
	dark:  { color: '#0d0d0d', symbolColor: '#f5f5f5' },
};

export function applyTheme(theme) {
	const html = document.documentElement;
	html.setAttribute('data-theme', theme);
	const overlay = titleBarOverlayColors[theme] || titleBarOverlayColors.light;
	window.electron.invoke('theme:apply', { ...overlay, theme, bareMode: window.__settings.bareMode }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* Connection status display — auto-clears after 5s                   */
/* ------------------------------------------------------------------ */
let _statusTimer = null;
function showStatus(text, type = '') {
	if (_statusTimer) clearTimeout(_statusTimer);
	connectionStatus.textContent = text;
	connectionStatus.className = 'connection-status' + (type ? ` ${type}` : '');
	_statusTimer = setTimeout(() => {
		connectionStatus.textContent = '';
		connectionStatus.className = 'connection-status';
	}, 5000);
}

/* ------------------------------------------------------------------ */
/* Settings UI sync                                                   */
/* ------------------------------------------------------------------ */
export function applySettingsToUI() {
	setCustomSelectValue('server-type', window.__settings.serverType || 'llamacpp');
	serverHostInput.value = window.__settings.serverHost || '127.0.0.1';
	serverPortInput.value = window.__settings.serverPort || '8080';
	themeToggle.checked = (window.__settings.theme || 'light') === 'dark';

	// Restore model selection if we have one
	if (window.__settings.model) {
		setCustomSelectValue('model', window.__settings.model);
	}

	// Restore restrict-to-workdir
	if (restrictWorkdirToggle) {
		restrictWorkdirToggle.checked = !!window.__settings.restrictToWorkDir;
	}
	// Hide warning on open; it will only show when the user actively toggles the setting off
	if (workdirWarning) {
		workdirWarning.style.display = 'none';
	}
	// Reset dismissed flag so the toggle handler can show it fresh on first disable
	window.__settings.workdirWarningDismissed = false;

	// Restore read-only mode
	if (readOnlyToggle) {
		readOnlyToggle.checked = !!window.__settings.readOnly;
	}

	// Restore require-tool-permission
	if (requirePermToggle) {
		requirePermToggle.checked = window.__settings.requireToolPermission !== false;
	}

	// Restore bare mode
	if (bareModeToggle) {
		bareModeToggle.checked = !!window.__settings.bareMode;
	}
	applyBareMode(window.__settings.bareMode);

	// Restore verbose mode
	if (verboseToggle) {
		verboseToggle.checked = !!window.__settings.verbose;
	}
	// Show/hide warning based on toggle state (only if not dismissed)
	if (permWarning) {
		permWarning.style.display = (window.__settings.requireToolPermission === false && !window.__settings.permWarningDismissed) ? 'block' : 'none';
	}
}

function readSettingsFromUI() {
	window.__settings.serverType = getCustomSelectValue('server-type') || 'llamacpp';
	window.__settings.serverHost = serverHostInput.value || '127.0.0.1';
	window.__settings.serverPort = serverPortInput.value || '8080';
	window.__settings.model = getCustomSelectValue('model');
	window.__settings.theme = themeToggle.checked ? 'dark' : 'light';
	// restrict-to-workdir
	if (restrictWorkdirToggle) {
		window.__settings.restrictToWorkDir = restrictWorkdirToggle.checked;
	}

	// read-only mode
	if (readOnlyToggle) {
		window.__settings.readOnly = readOnlyToggle.checked;
	}

	// require tool permission
	if (requirePermToggle) {
		window.__settings.requireToolPermission = requirePermToggle.checked;
	}

	// bare mode
	if (bareModeToggle) {
		window.__settings.bareMode = bareModeToggle.checked;
	}

	// verbose mode
	if (verboseToggle) {
		window.__settings.verbose = verboseToggle.checked;
	}
}

/* ------------------------------------------------------------------ */
/* Model name helper — strip path and extension, keep base filename   */
/* ------------------------------------------------------------------ */
function modelName(id) {
	// Handle both paths (e.g. /path/to/model.gguf) and plain names (e.g. llama-3.2-1b)
	const base = id.split(/[\\/]/).pop();          // last path segment
	return base.replace(/\.[^.]+$/, '');             // strip extension
}

/* ------------------------------------------------------------------ */
/* Populate model dropdown from API response                          */
/* ------------------------------------------------------------------ */
async function populateModels(showStatusMsg = false) {
	readSettingsFromUI();
	const url = getApiUrl();

	if (showStatusMsg) {
		showStatus('Testing connection…', 'loading');
		testConnectionBtn.disabled = true;
	}

	try {
		const res = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(3000), headers: getApiHeaders() });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const data = await res.json();
		const models = data.data || [];

		// Populate model dropdown
		const modelItems = models.map(m => ({ value: m.id, label: modelName(m.id) }));
		populateCustomSelect('model', modelItems);

		if (models.length === 0) {
			if (showStatusMsg) showStatus(`✅ Connected — no models loaded`, 'success');
			// Reset label to placeholder
			const modelBtn = document.querySelector('.custom-select-btn[data-select="model"]');
			if (modelBtn) modelBtn.querySelector('.custom-select-label').textContent = 'Select model';
		} else {
			// Restore previously selected model if it exists
			if (window.__settings.model && modelItems.some(m => m.value === window.__settings.model)) {
				setCustomSelectValue('model', window.__settings.model);
			}
			if (showStatusMsg) showStatus(`✅ Connected — ${models.length} model${models.length > 1 ? 's' : ''} available`, 'success');
		}
	} catch (err) {
		if (showStatusMsg) showStatus(`❌ ${friendlyError(err)}`, 'error');
	}

	if (showStatusMsg) testConnectionBtn.disabled = false;
}

/* ------------------------------------------------------------------ */
/* Test connection — hit /v1/models, populate model dropdown          */
/* ------------------------------------------------------------------ */
async function testConnection() {
	await populateModels(true);
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                       */
/* ------------------------------------------------------------------ */
function dimTitleBar(dim) {
	window.electron.invoke('theme:dim', { dim: !!dim, theme: window.__settings.theme || 'light', bareMode: window.__settings.bareMode }).catch(() => {});
}

document.getElementById('settings-btn').addEventListener('click', () => {
	applySettingsToUI();
	settingsOverlay.classList.remove('overlay-hidden');
	dimTitleBar(true);
	// Re-detect servers in case one was started after Bare launched
	import('./server-detect.js').then(m => m.detectServerAndApply());
	populateModels(false);
});

themeToggle.addEventListener('change', () => {
	window.__settings.theme = themeToggle.checked ? 'dark' : 'light';
	applyTheme(window.__settings.theme);
});

initCustomSelects();

restrictWorkdirToggle.addEventListener('change', () => {
	window.__settings.restrictToWorkDir = restrictWorkdirToggle.checked;
	if (workdirWarning) {
		workdirWarning.style.display = (!window.__settings.restrictToWorkDir) ? 'block' : 'none';
	}
	// Replace previous toast so only one shows at a time
	if (window.__workdirToast) { window.__workdirToast.remove(); }
	if (window.__settings.restrictToWorkDir) {
		window.__workdirToast = addToast('Restrict workdir: ON', '', 3000);
	} else {
		window.__workdirToast = addToast('⚠ Bare can now work outside the current directory', 'warning', 5000);
	}
});

readOnlyToggle.addEventListener('change', () => {
	window.__settings.readOnly = readOnlyToggle.checked;
	addToast(`Read-only: ${window.__settings.readOnly ? 'ON' : 'OFF'}`, '', 3000);
});

/* ------------------------------------------------------------------ */
/* BARE Mode — toggle UI visibility                                   */
/* ------------------------------------------------------------------ */
export function applyBareMode(on) {
	document.documentElement.setAttribute('data-bare-mode', on ? 'true' : 'false');
	const theme = window.__settings.theme || 'light';
	window.electron.invoke('bare-mode:apply', { on, theme }).catch(() => {});
}

bareModeToggle.addEventListener('change', () => {
	window.__settings.bareMode = bareModeToggle.checked;
	applyBareMode(window.__settings.bareMode);
	if (window.__settings.bareMode) {
		addToast('BARE mode: ON', 'invisible', 3000);
	} else {
		addToast('BARE mode: OFF', '', 3000);
	}
});

verboseToggle.addEventListener('change', () => {
	window.__settings.verbose = verboseToggle.checked;
	const queued = applyVerboseMode();
	if (!queued) {
		addToast(`Verbose: ${window.__settings.verbose ? 'ON' : 'OFF'}`, '', 3000);
	}
});

requirePermToggle.addEventListener('change', () => {
	window.__settings.requireToolPermission = requirePermToggle.checked;
	// Reset dismissed flag when toggling to unsafe, so warning shows on first disable
	if (!window.__settings.requireToolPermission) {
		window.__settings.permWarningDismissed = false;
	}
	if (permWarning) {
		permWarning.style.display = (window.__settings.requireToolPermission === false && !window.__settings.permWarningDismissed) ? 'block' : 'none';
	}
	// Replace previous toast so only one shows at a time
	if (window.__permToast) { window.__permToast.remove(); }
	if (window.__settings.requireToolPermission) {
		// Turned ON — brief confirmation
		window.__permToast = addToast('Tool permissions: ON', '', 3000);
	} else {
		// Turned OFF — show warning toast
		window.__permToast = addToast('⚠ Bare can now run all tools without permission', 'warning', 5000);
	}
});

function clearSettingsWarnings() {
	if (workdirWarning) workdirWarning.style.display = 'none';
	if (permWarning) permWarning.style.display = 'none';
	// Mark as dismissed so they don't reappear on next open
	window.__settings.workdirWarningDismissed = true;
	window.__settings.permWarningDismissed = true;
	// Persist dismissed flags to bare.json so they survive restart
	window.electron.invoke('settings:save', window.__settings).catch(() => {});
}

document.getElementById('settings-close').addEventListener('click', () => {
	readSettingsFromUI();
	clearSettingsWarnings();
	settingsOverlay.classList.add('overlay-hidden');
	dimTitleBar(false);
});

settingsOverlay.addEventListener('click', (e) => {
	if (e.target === settingsOverlay) {
		readSettingsFromUI();
		clearSettingsWarnings();
		settingsOverlay.classList.add('overlay-hidden');
		dimTitleBar(false);
	}
});

testConnectionBtn.addEventListener('click', testConnection);

saveSettingsBtn.addEventListener('click', async () => {
	readSettingsFromUI();
	applyTheme(window.__settings.theme);
	console.log('[settings] saving:', window.__settings);
	try {
		await window.electron.invoke('settings:save', window.__settings);
		console.log('[settings] saved OK');
	} catch (e) {
		console.error('[settings] save failed:', e);
	}
	clearSettingsWarnings();
	settingsOverlay.classList.add('overlay-hidden');
	dimTitleBar(false);
});

/* ------------------------------------------------------------------ */
/* Load settings on startup                                           */
/* ------------------------------------------------------------------ */
export async function initSettings() {
	// Theme is already applied via data-theme injected into <html> by main process.
	// Sync the JS state from the injected attribute so it's correct immediately.
	const injectedTheme = document.documentElement.getAttribute('data-theme') || 'light';
	if (injectedTheme !== 'light') {
		window.__settings.theme = injectedTheme;
		// Apply title bar overlay for the injected theme (IPC is async but visual
		// body/prompt are already correct from the inline CSS + data-theme).
		applyTheme(injectedTheme);
	}

	const saved = await window.electron.invoke('settings:load');
	if (saved) {
		Object.assign(window.__settings, saved);
		console.log('[settings] loaded:', window.__settings);
		// Only re-apply if the loaded theme differs from what was injected
		const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
		if ((window.__settings.theme || 'light') !== currentTheme) {
			applyTheme(window.__settings.theme || 'light');
		}
		// Re-apply BARE mode overlay now that settings are loaded (main process
		// already set the initial overlay, but this ensures renderer state is in sync).
		applyBareMode(!!window.__settings.bareMode);
		// Initialize tool log and apply verbose mode
		initToolLog();
		applyVerboseMode();
	} else {
		console.log('[settings] no saved settings found');
		initToolLog();
		applyVerboseMode();
	}

	// Fire-and-forget: auto-detect a local AI server in the background.
	// Does not block startup — silently patches settings + model dropdown when done.
	import('./server-detect.js').then(m => m.detectServerAndApply());
}
