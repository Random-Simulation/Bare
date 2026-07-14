const fs = require('fs');
const path = require('path');

module.exports = {
	name: "edit",
	schema: {
		type: "function",
		function: {
			name: "edit",
			description: "Replace exact text in a file. oldText must match exactly once — include surrounding context for uniqueness.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "File path" },
					edits: {
						type: "array",
						description: "Edits to apply",
						items: {
							type: "object",
							properties: {
								oldText: { type: "string", description: "Exact text to replace (must be unique)" },
								newText: { type: "string", description: "New text" },
							},
							required: ["oldText", "newText"],
						},
					},
				},
				required: ["path", "edits"],
			},
		},
	},
	execute: async (args, ctx) => {
		const filePath = path.resolve(ctx.workDir, args.path);
		let content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
		const edits = args.edits || [];

		if (edits.length === 0) {
			throw new Error(`no edits provided for ${args.path}`);
		}

		const applied = [];
		const failed = [];

		for (const edit of edits) {
			const oldText = edit.oldText || '';
			const newText = edit.newText || '';

			// Find ALL occurrences of oldText
			const matches = [];
			let searchPos = 0;
			while (true) {
				const idx = content.indexOf(oldText, searchPos);
				if (idx === -1) break;
				matches.push(idx);
				searchPos = idx + 1;
			}

			if (matches.length === 0) {
				// Not found at all — report the exact oldText so the agent can compare
				const snippet = oldText.split('\n').length > 1
					? oldText.split('\n')[0].slice(0, 80) + '...'
					: oldText.slice(0, 120);
				failed.push(`text not found: ${JSON.stringify(snippet)} — reread the file to see the actual content, then retry with the correct oldText`);
				continue;
			}

			if (matches.length > 1) {
				// Multiple matches — reject and tell the agent to be more specific
				const lines = matches.map(idx => {
					let lineNum = 1;
					for (let i = 0; i < idx; i++) {
						if (content[i] === '\n') lineNum++;
					}
					return lineNum;
				});
				failed.push(`ambiguous — matched at lines ${lines.join(', ')} — reread the file and include more surrounding context in oldText to disambiguate`);
				continue;
			}

			// Exactly one match — safe to apply
			content = content.replace(oldText, newText);
			applied.push(edit);
		}

		if (applied.length > 0) {
			fs.writeFileSync(filePath, content, 'utf-8');
		}

		const fname = args.path.split(/[/\\]/).pop();

		if (applied.length === 0 && failed.length > 0) {
			const msg = `${args.path}: all ${failed.length} edit(s) failed — ${failed.join('; ')}`;
			const err = new Error(msg);
			err.ui = `Edit failed — ${fname}`;
			throw err;
		}

		const linesChanged = applied.reduce((sum, e) => sum + e.oldText.split('\n').length, 0);
		let result = `Edited ${args.path}: ${applied.length}/${edits.length} edit(s) applied, replaced ${linesChanged} line(s)`;

		if (failed.length > 0) {
			result += `\nFailed edits: ${failed.join('; ')}`;
		}

		const ui = failed.length > 0
			? `Edited ${fname}`
			: `Edited ${fname}${applied.length > 1 ? ` (${applied.length} edits)` : ''}`;

		return { result, ui };
	},
};
