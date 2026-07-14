/* ------------------------------------------------------------------ */
/* Toast API — adds/removes lines in #toast-container                 */
/* ------------------------------------------------------------------ */

const toastContainer = document.getElementById('toast-container');

/**
 * Add a toast line. Auto-removes after `duration` ms (default 3000).
 * @param {string} text  — toast message (HTML-safe)
 * @param {string} type  — 'shimmer' | 'error' | 'warning' | 'info' | 'invisible' | ''
 * @param {number} duration — auto-remove timeout in ms (0 = persistent)
 * @returns {HTMLElement} the toast line element
 */
function addToast(text, type = '', duration = 3000) {
	const line = document.createElement('div');
	line.className = 'toast-line' + (type ? ` ${type}` : '');
	line.textContent = text;
	toastContainer.appendChild(line);

	if (duration > 0) {
		setTimeout(() => {
			line.classList.add('fading');
			setTimeout(() => line.remove(), 300);
		}, duration);
	}
	return line;
}

/** Remove all toasts. */
function clearToasts() {
	toastContainer.innerHTML = '';
}

window.addToast = addToast;
window.clearToasts = clearToasts;
