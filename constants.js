/* ------------------------------------------------------------------ */
/* App-wide constants — single source of truth                        */
/* Loaded as a classic script first in index.html so it is available  */
/* to both classic scripts and ES modules.                            */
/* ------------------------------------------------------------------ */
window.BARE = {
	// % context usage at which the warning toast shows and history is
	// auto-truncated (llama.cpp only). Read by ctx-bar.js,
	// agentic-loop.js, and context-truncation.js.
	AUTO_TRUNCATE_THRESHOLD: 85,

	// Zone sizes (fraction of total messages at the initial split).
	// Head is fixed forever once set; the tail re-anchors on every
	// subsequent pass (see context-truncation.js).
	TRUNC_HEAD_PCT: 0.1,  // head = first 10% (~8.5% of context)
	TRUNC_TAIL_PCT: 0.2,   // tail = last 20% (~17% of context)

	// The skeleton zone is only elided to a single marker every Nth
	// truncation pass; in between, the old tail is stubbed onto the
	// skeleton so historic content stays at stub fidelity longer.
	TRUNC_WIPE_EVERY: 2,
};
