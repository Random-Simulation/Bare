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

	// % context usage at which we continue shrinking zones / pruning
	// skeleton after the initial split.
	SKELETON_PRUNE_THRESHOLD: 50,

	// Initial zone sizes (fraction of total messages at pass 1)
	TRUNC_HEAD_PCT: 0.175,   // head = first 17.5%
	TRUNC_TAIL_PCT: 0.225,   // tail = last 22.5%

	// Per-pass shrink amounts (fraction of current total)
	TRUNC_HEAD_SHRINK_PCT: 0.035,  // 3.5% off head per pass
	TRUNC_TAIL_SHRINK_PCT: 0.045,  // 4.5% off tail per pass

	// Fraction of skeleton middle to drop in one prune pass (aggressive)
	TRUNC_SKELETON_PRUNE_PCT: 0.5,
};
