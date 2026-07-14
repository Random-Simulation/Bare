const { BrowserWindow } = require("electron");
const fs = require("fs");

// ============================================================================
// Config
// ============================================================================

const PAGE_TIMEOUT = 5000;    // 5s per page — most pages load in 1-2s
const SEARCH_TIMEOUT = 6000;  // 6s for DDG search — usually instant
const MAX_QUERIES = 2;
const RESULTS_PER_QUERY = 2; // pages to scrape per query
const MAX_PARALLEL = 3;       // concurrent scraper windows
const MAX_SEARCH_PARALLEL = 2; // concurrent search windows

// ============================================================================
// Helpers
// ============================================================================

function loadApiConfig(settingsFile) {
	try {
		if (settingsFile && fs.existsSync(settingsFile)) {
			const data = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
			const s = data.settings || {};
			return {
				host: s.serverHost || "127.0.0.1",
				port: s.serverPort || "8080",
				model: s.model || "",
			};
		}
	} catch { /* ignore */ }
	return { host: "127.0.0.1", port: "8080", model: "" };
}

const UA = (() => {
	const base = 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
	if (process.platform === 'darwin') return `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) ${base}`;
	if (process.platform === 'linux') return `Mozilla/5.0 (X11; Linux x86_64) ${base}`;
	return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${base}`;
})();

function createScraper() {
	return new BrowserWindow({
		show: false,
		webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
	});
}

function loadURL(win, url, timeoutMs, jsWaitMs = 0) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
		win.webContents.once("did-finish-load", () => {
			if (jsWaitMs > 0) {
				setTimeout(() => { clearTimeout(t); resolve(); }, jsWaitMs);
			} else {
				clearTimeout(t); resolve();
			}
		});
		win.loadURL(url, { userAgent: UA }).catch((err) => { clearTimeout(t); reject(err); });
	});
}

// ============================================================================
// Search — DuckDuckGo HTML
// ============================================================================

async function searchDDG(win, query) {
	await loadURL(win, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, SEARCH_TIMEOUT);
	const links = await win.webContents.executeJavaScript(`
		[...document.querySelectorAll('.result')].slice(0, ${RESULTS_PER_QUERY})
			.map(n => {
				const a = n.querySelector('.result__title .result__a');
				const s = n.querySelector('.result__snippet');
				return a && a.href ? { title: a.innerText.trim(), url: a.href, snippet: s ? s.innerText.trim() : '' } : null;
			}).filter(Boolean)
	`);
	return links || [];
}

// ============================================================================
// Scrape — headers, meta, paragraphs, tables, JSON-LD
// ============================================================================

async function scrapePage(win, url) {
	await loadURL(win, url, PAGE_TIMEOUT, 1500); // wait 1.5s for JS to render
	return await win.webContents.executeJavaScript(`
		(() => {
			// Meta
			const desc = document.querySelector('meta[name="description"]')?.content || '';
			const title = document.querySelector('meta[property="og:title"]')?.content
				|| document.querySelector('title')?.innerText || '';

			// Headers
			const headers = [...document.querySelectorAll('h1, h2, h3')]
				.map(h => h.innerText.trim()).filter(t => t.length > 0);

			// Body text — 5000 chars
			const text = [...document.querySelectorAll('p, li')]
				.map(p => p.innerText.trim()).filter(t => t.length > 30)
				.join(' ').substring(0, 5000);

			// JSON-LD (brief)
			const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
				.map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
				.filter(Boolean);

			const parts = [];
			if (title) parts.push(\`## \${title}\`);
			if (desc) parts.push(desc);
			if (headers.length) parts.push(headers.map(h => \`### \${h}\`).join('\\n'));
			if (text) parts.push(text);
			if (ld.length) parts.push(JSON.stringify(ld[0]).substring(0, 500));
			return parts.join('\\n\\n');
		})();
	`);
}

// ============================================================================
// Summarize — call local LLM
// ============================================================================

async function summarize(rawContent, intent, settingsFile) {
	const config = loadApiConfig(settingsFile);
	const url = `http://${config.host}:${config.port}/v1/chat/completions`;
	const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

	const body = {
		messages: [
			{ role: "system", content: `Current date: ${date}. Present summaries as fact, don't question the info. Lead with the answer. No intros or conclusions.` },
			{ role: "user", content: [
				`Write a concise summary of these web results. Focus on: ${intent}`,
				"",
				rawContent,
			].join("\n")},
		],
		stream: true,
		max_tokens: 1000,
		
		// 1. Primary Bypass: Forces the server to skip thinking tokens
		thinking_budget_tokens: 0,

		// 2. Fallback Bypass: Tells the Jinja template to drop the <think> tag.
		chat_template_kwargs: {
			"enable_thinking": false
		}
	};
	if (config.model) body.model = config.model;

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	if (!res.ok) throw new Error(`Summarize API error ${res.status}`);

	// Stream — collect chunks, return partial on timeout
	const chunks = [];
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			// Parse SSE lines
			for (const line of text.split('\n')) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') continue;
					try {
						const json = JSON.parse(data);
						const token = json.choices?.[0]?.delta?.content || '';
						if (token) chunks.push(token);
					} catch { /* skip malformed */ }
				}
			}
		}
	} catch (e) {
		// Timeout or network error — return whatever we got
		if (chunks.length === 0) throw e;
	}
	return chunks.join('') || "[Empty summary]";
}

// ============================================================================
// Plugin
// ============================================================================

// Generate schema with today's date baked into the description.
// This is evaluated at module load time, so the date stays current across reloads.
const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

module.exports = {
	name: "websearch",
	schema: {
		type: "function",
		function: {
			name: "websearch",
			description:
				`Sparingly — only when needed or asked. Web search & summarize. Today: ${today}. Treat results as fact.`,
			parameters: {
				type: "object",
				properties: {
					queries: {
						type: "array",
						items: { type: "string" },
						description: "Search queries (max 2 used)",
					},
					intent: {
						type: "string",
						description: "What you want to know (used for focused summary)",
					},
				},
				required: ["queries", "intent"],
			},
		},
	},
	execute: async (args, ctx) => {
		// Headless Linux check — hidden BrowserWindows need a display server
		if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
			throw new Error('websearch requires a display server (X11/Wayland). Install Xvfb or run with a desktop environment.');
		}

		const queries = Array.isArray(args.queries) ? args.queries.slice(0, MAX_QUERIES) : [args.queries];
		const intent = args.intent || "overview of the topic";

		const trace = [];
		const log = (m) => { console.log(`[web] ${m}`); trace.push(m); };

		// Phase 1: Search — parallel (up to MAX_SEARCH_PARALLEL windows)
		let allLinks = [];
		for (let i = 0; i < queries.length; i += MAX_SEARCH_PARALLEL) {
			const batch = queries.slice(i, i + MAX_SEARCH_PARALLEL);
			const promises = batch.map(async (q) => {
				const w = createScraper();
				try {
					log(`Searching: "${q}"`);
					const links = await searchDDG(w, q);
					log(`Found ${links.length} results`);
					return links;
				} catch (e) {
					log(`Search failed for "${q}": ${e.message}`);
					return [];
				} finally {
					w.destroy();
				}
			});
			const batchResults = await Promise.all(promises);
			allLinks = allLinks.concat(...batchResults);
		}

		if (!allLinks.length) {
			return `[NO_RESULTS]\nQueries: ${queries.join(", ")}\n${trace.join("\n")}`;
		}

		// Phase 2: Scrape — parallel (multiple windows, batched)
		const seen = new Set();
		const urlsToScrape = allLinks
			.filter(l => {
				if (l.url.match(/\.(pdf|jpg|jpeg|png|mp4|avi|zip|docx?)(\?.*)?$/i)) return false;
				if (seen.has(l.url)) return false;
				seen.add(l.url);
				return true;
			})
			.slice(0, RESULTS_PER_QUERY * MAX_QUERIES);

		const results = [];
		log(`Scraping ${urlsToScrape.length} pages (parallel, max ${MAX_PARALLEL})`);

		for (let i = 0; i < urlsToScrape.length; i += MAX_PARALLEL) {
			const batch = urlsToScrape.slice(i, i + MAX_PARALLEL);
			const promises = batch.map(async (link) => {
				const w = createScraper();
				try {
					log(`Scraping: ${link.title}`);
					const content = await scrapePage(w, link.url);
					if (content && content.trim().length > 50) {
						return `--- ${link.title} (${link.url}) ---\n${content.trim()}`;
					}
				} catch (e) {
					log(`Scrape failed: ${link.title} — ${e.message}`);
				} finally {
					w.destroy();
				}
				return null;
			});
			const batchResults = await Promise.all(promises);
			results.push(...batchResults.filter(Boolean));
		}

		if (!results.length) {
			return `[NO_CONTENT]\nScraped ${urlsToScrape.length} pages but got no usable text.\n${trace.join("\n")}`;
		}

		// Phase 3: Summarize
		log(`Got ${results.length} pages, summarizing...`);
		try {
			const summary = await summarize(results.join("\n\n"), intent, ctx.settingsFile);
			return summary;
		} catch (e) {
			// Fallback: return raw content if summarization fails
			log(`Summarization failed (${e.message}), returning raw content`);
			return results.join("\n\n");
		}
	},
};
