const { contextBridge, ipcRenderer } = require("electron");

const API_URL = process.env.API_URL || "http://127.0.0.1:8080";

// Theme is set synchronously by an inline <script> in index.html
// that reads the ?theme= query param from main.js (which reads user data settings).
// The preload no longer needs to read bare.json.

contextBridge.exposeInMainWorld("electron", {
	invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
	getApiUrl: () => API_URL,
	on: (channel, callback) => {
		const listener = (_event, ...args) => callback(...args);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.removeListener(channel, listener);
	},
});
