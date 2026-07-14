/* ------------------------------------------------------------------ */
/* Permission toast — persistent toast with Allow / Block / Allow All */
/* Blocks the agentic loop until the user responds.                    */
/* ------------------------------------------------------------------ */

import { extractPartialValue } from './utils.js';

const toastContainer = document.getElementById('toast-container');

/**
 * Tool risk levels — determines which tools trigger a permission prompt.
 * 'high' and 'medium' tools prompt; 'low' tools do not.
 */
const TOOL_RISK = {
	bash: 'high',
	write: 'medium',
	edit: 'medium',
	finish_task: 'low',
	read: 'low',
	websearch: 'low',
	// Custom plugins (anything not in this map) default to 'medium'
};

/** Human-readable labels for tool actions */
const TOOL_LABELS = {
	bash: 'run bash',
	write: 'write a file',
	edit: 'edit a file',
	read: 'read a file',
	websearch: 'search the web',
	finish_task: 'finish the task',
};

/**
 * Get a descriptive string for what the tool is about to do.
 * `args` may be a streaming entry (with partialArgs) or a resolved args object.
 */
function getToolDescription(toolName, args) {
	// Try partial extraction first (streaming entry), fall back to resolved args
	const partialPath = args?.partialArgs != null ? extractPartialValue(args, 'path') : null;
	const partialCommand = args?.partialArgs != null ? extractPartialValue(args, 'command') : null;

	if (toolName === 'bash') {
		const cmd = partialCommand || args.command || '';
		const truncated = cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd;
		return truncated;
	}
	if (toolName === 'write' || toolName === 'edit') {
		const pathVal = partialPath || args.path || '';
		const fname = pathVal.split(/[/\\]/).pop() || pathVal || 'unknown';
		return `"${fname}"`;
	}
	// Custom plugin
	const pathVal = partialPath || args.path || '';
	const fname = pathVal.split(/[/\\]/).pop() || '';
	return fname ? `"${fname}"` : toolName;
}

/**
 * Show a warning confirmation toast before disabling all tool permissions.
 * Returns a Promise that resolves to true (confirmed) or false (cancelled).
 */
function confirmAllowAll() {
	return new Promise((resolve) => {
		const wrapper = document.createElement('div');
		wrapper.className = 'perm-toast perm-toast-warning';

		// Header line
		const header = document.createElement('div');
		header.className = 'perm-toast-header perm-toast-warning-header';
		header.textContent = '⚠ Are you SURE you want to enable ALL tools for Bare?';

		// Body row: warning text + YES/NO buttons side by side
		const bodyRow = document.createElement('div');
		bodyRow.className = 'perm-toast-warning-row';

		const body = document.createElement('span');
		body.className = 'perm-toast-warning-text';
		body.textContent = 'This will enable Bare to work autonomously and carries significant risk. Bare will be able to run command line actions on your computer and be able to write, edit, and delete files. You could lose valuable files or data. This option and read-only mode can be toggled in settings again.';

		const btnRow = document.createElement('span');
		btnRow.className = 'perm-toast-buttons';

		const btnConfirm = document.createElement('button');
		btnConfirm.className = 'perm-btn perm-btn-confirm-all';
		btnConfirm.textContent = 'Yes';

		const btnCancel = document.createElement('button');
		btnCancel.className = 'perm-btn perm-btn-cancel';
		btnCancel.textContent = 'No';

		btnRow.appendChild(btnConfirm);
		btnRow.appendChild(btnCancel);

		bodyRow.appendChild(body);
		bodyRow.appendChild(btnRow);

		wrapper.appendChild(header);
		wrapper.appendChild(bodyRow);

		toastContainer.appendChild(wrapper);

		function dismiss() {
			wrapper.remove();
		}

		btnConfirm.addEventListener('click', () => { dismiss(); resolve(true); });
		btnCancel.addEventListener('click', () => { dismiss(); resolve(false); });
	});
}

/**
 * Create a persistent permission toast with Allow / Block / Allow All buttons.
 * Returns a Promise that resolves to 'allow' | 'block' | 'allow-all'.
 */
export function requestPermission(toolName, args) {
	return new Promise(async (resolve) => {
		const wrapper = document.createElement('div');
		wrapper.className = 'perm-toast';

		const risk = TOOL_RISK[toolName] || 'medium';
		const label = TOOL_LABELS[toolName] || `use ${toolName}`;
		const desc = getToolDescription(toolName, args);

		// Header line
		const header = document.createElement('div');
		header.className = 'perm-toast-header';
		header.textContent = `Allow Bare to ${label}?`;

		// Description line
		const detail = document.createElement('div');
		detail.className = 'perm-toast-detail';
		detail.textContent = desc;

		// Button row
		const btnRow = document.createElement('div');
		btnRow.className = 'perm-toast-buttons';

		const btnAllow = document.createElement('button');
		btnAllow.className = 'perm-btn perm-btn-allow';
		btnAllow.textContent = 'Allow';

		const btnBlock = document.createElement('button');
		btnBlock.className = 'perm-btn perm-btn-block';
		btnBlock.textContent = 'Block';

		const btnAllowAll = document.createElement('button');
		btnAllowAll.className = 'perm-btn perm-btn-allow-all';
		btnAllowAll.textContent = 'Allow All Tools';

		btnRow.appendChild(btnAllow);
		btnRow.appendChild(btnBlock);
		btnRow.appendChild(btnAllowAll);

		wrapper.appendChild(header);
		wrapper.appendChild(detail);
		wrapper.appendChild(btnRow);

		toastContainer.appendChild(wrapper);

		function dismiss() {
			wrapper.remove();
		}

		btnAllow.addEventListener('click', () => { dismiss(); resolve('allow'); });
		btnBlock.addEventListener('click', () => { dismiss(); resolve('block'); });
		btnAllowAll.addEventListener('click', async () => {
			dismiss();
			const confirmed = await confirmAllowAll();
			if (confirmed) {
				resolve('allow-all');
			} else {
				// Cancelled — re-show the original permission prompt
				requestPermission(toolName, args).then(resolve);
			}
		});
	});
}

/**
 * Check if a tool call requires a permission prompt.
 */
export function needsPermission(toolName) {
	const risk = TOOL_RISK[toolName];
	if (risk === 'low') return false;
	if (risk === 'high' || risk === 'medium') return true;
	// Unknown tools (custom plugins) — prompt by default
	return true;
}

/** Remove all permission toasts (e.g. when streaming is stopped). */
export function clearPermissionToasts() {
	toastContainer.querySelectorAll('.perm-toast').forEach(el => el.remove());
}
