const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif"]);
const IMAGE_MIME_MAP = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".tiff": "image/tiff",
	".tif": "image/tiff",
};
const DEFAULT_READ_LIMIT = 2_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format bytes to a human-readable string (e.g. "1.2 KB") */
function fmtSize(bytes) {
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
	return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** List directory contents and return a compact text summary */
function listDirectory(dirPath, originalPath) {
	const entries = fs.readdirSync(dirPath, { withFileTypes: true });

	// Sort: directories first, then files, both alphabetically (case-insensitive)
	entries.sort((a, b) => {
		if (a.isDirectory() !== b.isDirectory()) {
			return a.isDirectory() ? -1 : 1;
		}
		return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
	});

	const lines = [`Directory: ${originalPath}`];
	lines.push('─'.repeat(Math.max(originalPath.length + 12, 24)));

	for (const entry of entries) {
		const name = entry.name;
		if (entry.isDirectory()) {
			lines.push(`  ${name}/`);
		} else {
			try {
				const stat = fs.statSync(path.join(dirPath, name));
				lines.push(`  ${name}  ${fmtSize(stat.size)}`);
			} catch {
				lines.push(`  ${name}  (unreadable)`);
			}
		}
	}

	lines.push(`(${entries.length} item${entries.length !== 1 ? 's' : ''})`);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

module.exports = {
	name: "read",
	schema: {
		type: "function",
		function: {
			name: "read",
			description: "Read a file or list current directory with (.) Optional offset/limit for text files.",
			parameters: {
				type: "object",
				properties: {
					path:   { type: "string", description: "File or dir path (relative). '.' = current dir." },
					offset: { type: "number", description: "Start line (1-indexed, text files only)" },
					limit:  { type: "number", description: "Max lines to read (text files only)" },
				},
				required: ["path"],
			},
		},
	},
	execute: async (args, ctx) => {
		const fullPath = path.resolve(ctx.workDir, args.path);
		const ext = path.extname(fullPath).toLowerCase();

		// Block paths that escape the working directory (e.g. '..')
		// Exception: allow reading the tool plugin template from userDataDir
		const normalizedWork = path.normalize(ctx.workDir).toLowerCase();
		const normalizedFull = path.normalize(fullPath).toLowerCase();
		const normalizedTemplate = ctx.templatePath ? path.normalize(ctx.templatePath).toLowerCase() : '';
		const isTemplatePath = normalizedFull === normalizedTemplate;
		if (!isTemplatePath && normalizedFull !== normalizedWork && !normalizedFull.startsWith(normalizedWork + path.sep)) {
			throw new Error(`access denied: '${args.path}' is outside the working directory`);
		}

		// Stat once up front — determines if file, directory, or missing
		let stat;
		try {
			stat = fs.statSync(fullPath);
		} catch (err) {
			if (err.code === 'ENOENT') {
				throw new Error(`not found: '${args.path}'`);
			}
			throw err;
		}

		// --- Directory: list contents ---
		if (stat.isDirectory()) {
			return listDirectory(fullPath, args.path);
		}

		// --- Image file: return base64 reference ---
		if (IMAGE_EXTENSIONS.has(ext)) {
			const mimeType = IMAGE_MIME_MAP[ext];
			if (!mimeType) throw new Error(`unsupported image format: '${args.path}'`);

			const binary = fs.readFileSync(fullPath);
			const base64 = binary.toString('base64');
			const fname = path.basename(args.path);
			return `__IMAGE__|${fname}|${mimeType}|${base64}`;
		}

		// --- Text file: return content (with optional offset/limit) ---
		let content;
		try {
			content = fs.readFileSync(fullPath, 'utf-8');
		} catch (err) {
			throw new Error(`cannot read file '${args.path}': ${err.message}`);
		}

		content = content.replace(/\r\n/g, '\n');
		const lines = content.split('\n');
		const offset = args.offset ? parseInt(args.offset) - 1 : 0;
		const limit = args.limit ? parseInt(args.limit) : DEFAULT_READ_LIMIT;

		return lines.slice(offset, offset + limit).join('\n');
	},
};
