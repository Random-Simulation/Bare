// Shell-specific command examples for the system prompt
const SHELL_CMDS = {
	'cmd.exe':  '`dir`, `copy`, `del`, `xcopy`, etc.',
	powershell: '`Get-ChildItem`, `Copy-Item`, `Remove-Item`, etc.',
	bash:       '`ls`, `cp`, `rm`, `mv`, etc.',
	zsh:        '`ls`, `cp`, `rm`, `mv`, etc.',
	fish:       '`ls`, `cp`, `rm`, `mv`, etc.',
};

let _platform = 'Windows (cmd.exe)'; // fallback
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
		_promptAddition = 'You are Bare, an autonomous system agent.';
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

	// Inject working directory so the AI knows exactly where it is
	const workDir = window.__settings?.workDir;
	let workDirLine = '';
	if (workDir) {
		workDirLine = `\n\n## Working Directory\n${workDir}\n\nAll file paths are relative to this directory.`;
	}

	// Extract shell name from platform string like "Windows (cmd.exe)"
	const shellMatch = platform.match(/\(([^)]+)\)/);
	const shellName = shellMatch ? shellMatch[1] : null;
	const shellCmds = shellName ? (SHELL_CMDS[shellName] || '') : '';
	const shellHint = shellCmds ? `\n- Shell commands: ${shellCmds}` : '';

	let rules = `## Rules
- Autonomy: Execute full workflows autonomously inside the current directory; infer technical intent.
- Keep files <500 lines, single-purpose. Use imports/exports.
- Batch independent tool calls.
- Before every tool call, write a very short sentence describing what you are about to do.
- To instantly add a new tool: read the template at {{TOOL_TEMPLATE_PATH}}
- For Math use $/$ KaTeX with LaTeX syntax for all equations.${shellHint}
- Verify complex tasks using tools before calling finish_task.
- On task completion: brief summary, then call finish_task.`;

	if (safetyRules.length > 0) {
		rules += '\n\n## Active Safety Restrictions\n' + safetyRules.join('\n');
	}

	return `${addition.replace('system agent', platform + ' desktop agent')}.${workDirLine}\n\n${rules}`;
}
