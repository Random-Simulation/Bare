/* ------------------------------------------------------------------ */
/* Context bar — tracks KV cache usage via /slots polling             */
/* ------------------------------------------------------------------ */

const promptWrapper = document.getElementById("prompt-wrapper");
let _ctxToast = null;

// Flag to force 0% display after new session until first prompt is sent.
// llamacpp doesn't clear its context until new tokens are processed,
// so we override the poll data during this gap.
window.__ctxSessionReset = false;

/** Force the context bar to show 0% until resumed. */
window.resetContextBar = () => {
	window.__ctxSessionReset = true;
	clearWarning();
};
/** Resume normal polling display. */
window.resumeContextBar = () => { window.__ctxSessionReset = false; };

/** Check whether context tracking is available (not supported by Ollama). */
function isCtxAvailable() {
	return !['ollama', 'vllm'].includes(window.__settings?.serverType);
}

function clearWarning() {
	if (_ctxToast) { _ctxToast.remove(); _ctxToast = null; }
}

/** Reset llamacpp server slots on startup so old context doesn't bleed through. */
if (isCtxAvailable()) {
	fetch(electron.getApiUrl() + "/slots/reset", { method: "POST" })
		.catch(() => {}); // silently ignore if server isn't running yet
}

// Set the flag immediately so the first poll shows 0%.
window.resetContextBar();

async function pollContext() {
	if (!isCtxAvailable()) return;
	try {
		const res = await fetch(electron.getApiUrl() + "/slots", { cache: "no-store" });
		if (!res.ok) return;
		const slots = await res.json();

		let used = 0;
		let max = 1;

		for (const slot of slots) {
			const decodedTokens = slot.next_token?.[0]?.n_decoded ?? slot.n_decoded ?? slot.n_predicted ?? 0;
			used += (slot.n_prompt_tokens || 0) + decodedTokens;
			if (slot.n_ctx) max = slot.n_ctx;
		}

		const pct = Math.min((used / max) * 100, 100);

		const displayPct = window.__ctxSessionReset ? 0 : pct;
		window.__currentCtxPct = displayPct;

		const fill = getComputedStyle(document.documentElement).getPropertyValue('--ctx-fill').trim();
		const empty = getComputedStyle(document.documentElement).getPropertyValue('--ctx-empty').trim();
		promptWrapper.style.background = `linear-gradient(to right, ${fill} ${displayPct}%, ${empty} ${displayPct}%)`;

		// Show auto-truncation notice when context is getting full
		if (displayPct > 85) {
			clearWarning();
			_ctxToast = addToast('Auto-truncating context...', 'shimmer', 10000);
		} else {
			clearWarning();
		}

	} catch (err) {
		// Silently ignore server disconnects
	}
}

pollContext();
const ctxPollInterval = setInterval(pollContext, 1000);
window.clearCtxPoll = () => clearInterval(ctxPollInterval);
