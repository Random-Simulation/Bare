// ============================================================================
// FINISH_TASK TOOL PLUGIN
// ============================================================================
//
// Core control-flow tool. Signals that the agent has completed the user's
// objective. The renderer detects this tool and breaks the agentic loop.
//
// ============================================================================

module.exports = {
	name: "finish_task",
	schema: {
		type: "function",
		function: {
			name: "finish_task",
			description: "Call when the user's objective is fully complete.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
			},
		},
	},
	execute: async (_args, _ctx) => {
		return "Task finished.";
	},
};
