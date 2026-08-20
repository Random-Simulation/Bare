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
};
