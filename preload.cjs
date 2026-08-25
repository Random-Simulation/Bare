const { contextBridge, ipcRenderer } = require("electron");

// Theme is set synchronously by an inline <script> in index.html
// that reads the ?theme= query param from main.js (which reads user data settings).
// The preload no longer needs to read bare.json.

// Whitelist of IPC channels the renderer may use. The app only ever calls
// these; anything else (e.g. injected script in rendered content) is rejected.
const INVOKE_CHANNELS = new Set([
	'tools:get-schemas',
	'tool:execute',
	'app:template-path',
	'app:user-data-dir',
	'app:system-prompt-addition',
	'app:platform',
	'fs:workdir',
	'fs:pick-folder',
	'session:save',
	'session:load',
	'session:clear',
	'session:save-full',
	'session:load-full',
	'session:clear-full',
	'settings:save',
	'settings:load',
	'sessions:list',
	'sessions:load',
	'sessions:save',
	'sessions:delete',
	'sessions:new',
	'sessions:last',
	'sessions:clear-last',
	'title:generate',
	'theme:apply',
	'theme:dim',
	'titlebar:temp-mode',
]);

const ON_CHANNELS = new Set([
	'tools:changed',
	'settings:workdir-changed',
]);

const API_URL = process.env.API_URL || "http://127.0.0.1:8080";

contextBridge.exposeInMainWorld("electron", {
	invoke: (channel, ...args) => {
		if (!INVOKE_CHANNELS.has(channel)) {
			return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
		}
		return ipcRenderer.invoke(channel, ...args);
	},
	getApiUrl: () => API_URL,
	on: (channel, callback) => {
		if (!ON_CHANNELS.has(channel)) return () => {};
		const listener = (_event, ...args) => callback(...args);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.removeListener(channel, listener);
	},
});
