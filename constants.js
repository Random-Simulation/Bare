/* ------------------------------------------------------------------ */
/* App-wide constants — single source of truth                        */
/* Loaded as a classic script first in index.html so it is available  */
/* to both classic scripts and ES modules.                            */
/* ------------------------------------------------------------------ */
window.BARE = {
	// % context usage at which the warning toast shows and history is
	// auto-truncated (llama.cpp only). Read by ctx-bar.js,
	// agentic-loop.js, and context-truncation.js.
	AUTO_TRUNCATE_THRESHOLD: 87.5,

	// Zone sizes (fraction of total messages at the initial split).
	// Head is fixed forever once set; the tail re-anchors on every
	// subsequent pass (see context-truncation.js).
	TRUNC_HEAD_PCT: 0.175,  // head = first 17.5% (~15% of context)
	TRUNC_TAIL_PCT: 0.25,   // tail = last 25% (~21% of context)
};
