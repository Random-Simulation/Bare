const OS_CMDS = {
	Windows: '`dir`, `copy`, etc.',
	macOS:   '`ls`, `cp`, etc.',
	Linux:   '`ls`, `cp`, etc.',
};

let _platform = 'Windows'; // fallback
let _ready = null;

async function ensurePlatform() {
	if (!_ready) {
		_ready = (async () => {
			try {
				_platform = await window.electron.invoke('app:platform');
			} catch (e) {
				console.warn('[system-prompt] could not detect platform, defaulting to Windows');
			}
		})();
	}
	await _ready;
	return _platform;
}

/** Cached system prompt addition (from user-editable file) */
let _promptAddition = null;

/** Lazily fetch the user-editable system prompt addition */
async function getPromptAddition() {
	if (_promptAddition) return _promptAddition;
	try {
		_promptAddition = await window.electron.invoke('app:system-prompt-addition');
	} catch {
		_promptAddition = 'You are Bare, a coding agent.';
	}
	return _promptAddition;
}

/** Build dynamic safety rules based on current settings */
function getSafetyRules() {
	const rules = [];
	const s = window.__settings;

	if (s?.readOnly) {
		rules.push('- You are in **read-only mode**. You cannot write, edit, or run bash commands. Only read files, search the web, and finish tasks.');
	}

	if (s?.restrictToWorkDir && s?.workDir) {
		rules.push(`- You are restricted to the working directory: **${s.workDir}**. Do not access files or run commands targeting paths outside this directory.`);
	}

	return rules;
}

export async function getSystemPrompt() {
	const platform = await ensurePlatform();
	const addition = await getPromptAddition();
	const safetyRules = getSafetyRules();

	let rules = `## Rules
- Keep files <500 lines, single-purpose. Use imports/exports.
- Batch independent tool calls.
- Work autonomously in the current dir.
- To instantly add a new tool: read the template at {{TOOL_TEMPLATE_PATH}}
- On task completion: brief summary, then call finish_task (not during discussion).
- For Math use $/$ KaTeX with LaTeX syntax for all equations.`;

	if (safetyRules.length > 0) {
		rules += '\n\n## Active Safety Restrictions\n' + safetyRules.join('\n');
	}

	return `${addition} OS: ${platform} (${OS_CMDS[platform] || OS_CMDS.Windows}).

${rules}`;
}
