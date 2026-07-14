const path = require("path");
const sandbox = require("./sandbox");

// ============================================================================
// Safety validation for tool execution
//
// Each check returns null (allowed) or an error message string (blocked).
// Callers should:  const blocked = validateToolExecution(...); if (blocked) throw new Error(blocked);
// ============================================================================

/**
 * Validate a tool call against sandbox rules and user settings.
 *
 * @param {string} toolName  - The tool being called (e.g. 'bash', 'write')
 * @param {object} args      - The tool arguments
 * @param {object} settings  - User settings ({ restrictToWorkDir, readOnly })
 * @param {string} workDir   - The current working directory
 * @returns {string|null}    - Error message if blocked, null if allowed
 */
function validateToolExecution(toolName, args, settings, workDir) {
	// --- Sandbox: protected / blocked paths ---
	if (args.path && (toolName === 'write' || toolName === 'edit')) {
		const blocked = sandbox.checkPath(args.path);
		if (blocked) return blocked;
	}

	// --- Sandbox: blocked bash commands ---
	if (toolName === 'bash' && args.command) {
		const blocked = sandbox.checkCommand(args.command);
		if (blocked) return blocked;
	}

	// --- Read-only mode: block bash, write, edit entirely ---
	if (settings?.readOnly && ['bash', 'write', 'edit'].includes(toolName)) {
		return `Access denied: '${toolName}' is disabled in read-only mode`;
	}

	// --- Enforce workDir boundary if restriction is enabled ---
	if (settings?.restrictToWorkDir && args.path) {
		const resolved = path.resolve(workDir, args.path);
		const normalizedResolved = path.normalize(resolved).toLowerCase();
		const normalizedWorkDir = path.normalize(workDir).toLowerCase();

		if (!normalizedResolved.startsWith(normalizedWorkDir + path.sep)
			&& normalizedResolved !== normalizedWorkDir) {
			return `Access denied: '${args.path}' is outside the working directory`;
		}
	}

	// --- Block bash commands that escape workDir when restriction is enabled ---
	if (settings?.restrictToWorkDir && toolName === 'bash' && args.command) {
		const cmd = args.command;

		// Block 'cd' commands (agent shouldn't navigate outside workDir via shell)
		if (/^\s*cd\b/i.test(cmd)) {
			return 'Access denied: cd is not allowed when working directory is restricted';
		}

		// Block absolute paths outside workDir (Windows style: C:\...)
		const absPathMatch = cmd.match(/([A-Za-z]:[\\/][^\s>"']+)/g);
		if (absPathMatch) {
			const normalizedWorkDir = path.normalize(workDir).toLowerCase();
			for (const rawPath of absPathMatch) {
				const resolved = path.resolve(rawPath);
				const normalizedResolved = path.normalize(resolved).toLowerCase();
				if (!normalizedResolved.startsWith(normalizedWorkDir + path.sep)
					&& normalizedResolved !== normalizedWorkDir) {
					return `Access denied: bash command targets '${rawPath}' outside the working directory`;
				}
			}
		}
	}

	return null;
}

module.exports = { validateToolExecution };
