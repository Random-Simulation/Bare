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

/** Shell-specific command guidance for the system prompt */
function getShellRules(shellName) {
	if (!shellName || !SHELL_CMDS[shellName]) return [];
	const rules = [`- Shell commands (${shellName}): ${SHELL_CMDS[shellName]}. The bash tool returns combined stdout+stderr.`];
	if (shellName === 'cmd.exe') {
		rules.push('- Keep bash commands single-line where possible (cmd.exe syntax: dir, findstr, %VAR%, 2>nul).');
		rules.push('- For multi-line programs (python, node, etc.), write the code to a file first, then run that file — more reliable and easier to debug than inlining. Inline multi-line is also supported.');
	}
	return rules;
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

	let rules = `## Rules
- Work in the current directory.
- Start with read(.) for agentic work. 
- Before every tool call, write a very short sentence describing what you are about to do.
- Keep files <500 lines, single-purpose in big projects.
- Batch independent tool calls.
- To instantly add a new tool: read the template at {{TOOL_TEMPLATE_PATH}}
- For Math use $/$ KaTeX with LaTeX syntax for all equations.
- On task completion: brief summary, then call finish_task.`;

	const shellRules = getShellRules(shellName);
	if (shellRules.length) rules += '\n' + shellRules.join('\n');

	if (safetyRules.length > 0) {
		rules += '\n\n## Active Safety Restrictions\n' + safetyRules.join('\n');
	}

	return `${addition.replace('system agent', platform + ' desktop agent')}.${workDirLine}\n\n${rules}`;
}
