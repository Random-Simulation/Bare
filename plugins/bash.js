const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_OUTPUT_LENGTH = 50_000;
const DEFAULT_BASH_TIMEOUT_MS = 15_000;

// Self-contained shell detection — no external dependencies
const SHELL = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'zsh' : 'bash';

/**
 * Prepare how a command should be spawned.
 *
 * On Windows, cmd.exe cannot pass a literal newline through `cmd /c "..."`:
 * the command line is truncated at the first embedded newline, so a
 * multi-line command (e.g. `python -c "..."`) runs only a no-op fragment
 * and returns exit 0 with NO output — the "no stdout from bash" bug.
 *
 * Fix: route MULTI-LINE commands to PowerShell, which natively preserves
 * multi-line quoted strings. Single-line commands keep using cmd.exe
 * (unchanged, fast, cmd semantics).
 *
 *   - A leading `cd [flags] <dir>` is pulled into the process cwd.
 *   - Top-level cmd separators (`&` / `&&`) become PowerShell `;`,
 *     skipping quoted regions and redirects (`2>&1`, `>`, `<`).
 */
function prepareSpawn(command) {
	if (process.platform !== 'win32' || !/\r\n|\n/.test(command)) {
		return { kind: 'shell', command, cwd: null };
	}

	// Pull a leading "cd [flags] <dir>" into the process cwd.
	let cwd = null;
	const m = command.match(/^\s*cd\s+(?:\/[diI]+\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s&\n]+))\s*[&]{1,2}\s*/);
	if (m) {
		cwd = (m[1] || m[2] || m[3]).trim();
		command = command.slice(m[0].length);
	}

	// The plugin merges stdout+stderr itself, so `N>&M` redirects are
	// redundant under PowerShell and only add noisy native-error formatting.
	command = command.replace(/\s*\d+>&\d+/g, '');

	// Convert top-level cmd separators to PowerShell ';'.
	let out = '';
	let inDQ = false, inSQ = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === '"' && !inSQ) { inDQ = !inDQ; out += ch; continue; }
		if (ch === "'" && !inDQ) { inSQ = !inSQ; out += ch; continue; }
		if (ch === '&' && !inDQ && !inSQ) {
			const prev = out[out.length - 1] || '';
			const next = command[i + 1] || '';
			const isRedirect = prev === '>' || prev === '<' || next === '>' || next === '<';
			if (!isRedirect) {
				out += ' ; ';
				if (next === '&') i++; // collapse && into a single ;
				continue;
			}
		}
		out += ch;
	}
	return { kind: 'ps1', command: out, cwd };
}

module.exports = {
	name: "bash",
	schema: {
		type: "function",
		function: {
			name: "bash",
			description: "Run a shell command. On Windows single-line commands use cmd.exe (dir, findstr, %VAR%, 2>nul). Prefer single-line commands; for multi-line programs (e.g. python) write the code to a file first, then run it. Returns combined stdout+stderr. Optional timeout (seconds).",
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
			const plan = prepareSpawn(args.command);

			let proc, tmpFile = null;
			if (plan.kind === 'ps1') {
				tmpFile = path.join(os.tmpdir(), `bare-bash-${crypto.randomBytes(6).toString('hex')}.ps1`);
				fs.writeFileSync(tmpFile, plan.command.replace(/\n/g, '\r\n'), { encoding: 'utf8' });
				proc = childProcess.spawn('powershell.exe',
					['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
					{ cwd: plan.cwd || ctx.workDir });
			} else {
				proc = childProcess.spawn(plan.command, { cwd: ctx.workDir, shell: SHELL });
			}

			const cleanup = () => { if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } } };

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

			const finish = (value) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timer);
				cleanup();
				resolve(value);
			};

			const timer = setTimeout(() => {
				proc.kill('SIGTERM');
				finish(formatResult(`[timeout after ${timeout / 1000}s]`));
			}, timeout);

			proc.stdout.on('data', (data) => { stdout += data.toString().replace(/\r\n/g, '\n'); });
			proc.stderr.on('data', (data) => { stderr += data.toString().replace(/\r\n/g, '\n'); });

			proc.on('close', (code) => finish(formatResult(`[exit ${code}]`)));
			proc.on('error', (err) => finish(`[error] ${err.message}`));
		});
	},
};
