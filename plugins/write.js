const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';

module.exports = {
	name: "write",
	schema: {
		type: "function",
		function: {
			name: "write",
			description: "Create/overwrite a file. Auto-creates parent dirs.",
			parameters: {
				type: "object",
				properties: {
					path:    { type: "string", description: "File path" },
					content: { type: "string", description: "Content" },
				},
				required: ["path", "content"],
			},
		},
	},
	execute: async (args, ctx) => {
		const filePath = path.resolve(ctx.workDir, args.path);
		const dir = path.dirname(filePath);

		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		let content = args.content || '';
		if (isWin) content = content.replace(/\n/g, '\r\n');
		fs.writeFileSync(filePath, content, 'utf-8');

		const lines = content.split('\n').length;
		return `Wrote ${args.path}: ${lines} lines`;
	},
};
