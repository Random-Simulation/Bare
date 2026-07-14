const childProcess = require('child_process');

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_BASH_TIMEOUT_MS = 15_000;

// Pick the right shell per platform
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const SHELL = isWin ? 'cmd.exe' : isMac ? 'zsh' : 'bash';

module.exports = {
	name: "bash",
	schema: {
		type: "function",
		function: {
			name: "bash",
			description: "Run a shell command. Optional timeout. Not for file I/O.",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Command to run" },
					timeout: { type: "number", description: "Timeout (seconds)" },
				},
				required: ["command"],
			},
		},
	},
	execute: async (args, ctx) => {
		return new Promise((resolve) => {
			const timeout = args.timeout ? parseInt(args.timeout) * 1000 : DEFAULT_BASH_TIMEOUT_MS;
			const proc = childProcess.spawn(args.command, { cwd: ctx.workDir, shell: SHELL });
			let stdout = '';
			let stderr = '';
			let resolved = false;

			const formatResult = (prefix) => {
				const combined = (stdout + stderr).trim();
				const truncated = combined.length > MAX_OUTPUT_LENGTH
					? combined.slice(0, MAX_OUTPUT_LENGTH) + '\n... [truncated]'
					: combined;
				return `${prefix}${truncated ? '\n' + truncated : ''}`;
			};

			const timer = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				proc.kill('SIGTERM');
				resolve(formatResult(`[timeout after ${timeout / 1000}s]`));
			}, timeout);

			proc.stdout.on('data', (data) => { stdout += data.toString().replace(/\r\n/g, '\n'); });
			proc.stderr.on('data', (data) => { stderr += data.toString().replace(/\r\n/g, '\n'); });

			proc.on('close', (code) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				resolve(formatResult(`[exit ${code}]`));
			});

			proc.on('error', (err) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				resolve(`[error] ${err.message}`);
			});
		});
	},
};
