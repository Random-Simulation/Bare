/* ------------------------------------------------------------------ */
/* Auto-detect local AI servers on common ports                       */
/* ------------------------------------------------------------------ */

/**
 * Server profiles — each probes /v1/models (OpenAI-compatible).
 * Priority order for auto-selection when multiple are found.
 */
const SERVER_PROFILES = [
	{ type: 'vllm',     port: 8000 },
	{ type: 'llamacpp', port: 8080 },
	{ type: 'ollama',   port: 11434 },
	{ type: 'lmstudio', port: 1234 },
];

/** Default host to probe */
const DEFAULT_HOST = '127.0.0.1';

/** Probe timeout in ms — localhost should respond fast */
const PROBE_TIMEOUT = 1000;

/* ------------------------------------------------------------------ */
/** Strip path/extension from model id for display */
function modelName(id) {
	const base = id.split(/[\\/]/).pop();
	return base.replace(/\.[^.]+$/, '');
}

/* ------------------------------------------------------------------ */
/**
 * Probe a single host:port for /v1/models.
 * Returns { type, port, models } or null.
 */
async function probeOne(type, host, port) {
	try {
		const url = `http://${host}:${port}/v1/models`;
		const res = await fetch(url, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT),
			headers: { 'Content-Type': 'application/json' },
		});
		if (!res.ok) return null;

		const data = await res.json();
		const models = (data.data || []).map(m => ({
			value: m.id,
			label: modelName(m.id),
		}));

		return { type, port, models };
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/**
 * Probe all server profiles in parallel and return the first match.
 * @param {string} host  — defaults to 127.0.0.1
 * @returns {Promise<{type, port, models} | null>}
 */
export async function detectServer(host = DEFAULT_HOST) {
	const results = await Promise.all(
		SERVER_PROFILES.map(p => probeOne(p.type, host, p.port)),
	);
	return results.find(r => r !== null) ?? null;
}

/* ------------------------------------------------------------------ */
/**
 * Detect a server and, if found, silently apply the results to
 * window.__settings and the model dropdown UI.
 *
 * Priority: saved serverType wins if its probe succeeded; otherwise
 * falls back to the priority-ordered first match (vllm > llamacpp > ollama).
 *
 * Fire-and-forget — does not block the caller.
 */
export async function detectServerAndApply(host = DEFAULT_HOST) {
	try {
		const savedType = window.__settings?.serverType;

		// Probe all profiles in parallel
		const results = await Promise.all(
			SERVER_PROFILES.map(p => probeOne(p.type, host, p.port)),
		);

		// Filter to only successful probes
		const found = results.filter(r => r !== null);
		if (found.length === 0) return; // nothing detected

		// Decide which server to use:
		// 1. If saved serverType matches one of the detected servers, prefer it
		// 2. Otherwise, use the priority-ordered first match
		let chosen = null;
		if (savedType) {
			const savedMatch = found.find(f => f.type === savedType);
			if (savedMatch) chosen = savedMatch;
		}
		if (!chosen) chosen = found[0]; // priority order

		// Update settings
		window.__settings.serverType = chosen.type;
		window.__settings.serverPort = String(chosen.port);

		// Auto-select first model if none saved, or if saved model isn't in list
		const currentModel = window.__settings.model;
		const modelStillAvailable = chosen.models.some(m => m.value === currentModel);
		if (!currentModel || !modelStillAvailable) {
			window.__settings.model = chosen.models[0].value;
		}

		// Sync UI — this is safe to call even when settings panel is closed
		// (it just updates the custom select data values silently)
		const { applySettingsToUI, populateCustomSelect, setCustomSelectValue } =
			await import('./settings.js');

		// Populate model dropdown with detected models
		if (chosen.models.length > 0) {
			populateCustomSelect('model', chosen.models);
			setCustomSelectValue('model', window.__settings.model);
		}

		// Sync server-type and port fields
		applySettingsToUI();

		console.log(`[server-detect] found ${chosen.type} on port ${chosen.port} (${chosen.models.length} model(s))`);
	} catch (err) {
		console.warn('[server-detect] detection failed:', err.message);
	}
}
