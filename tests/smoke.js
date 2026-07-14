const assert = require('assert');
const path = require('path');
const sandbox = require('../sandbox');

// Load sandbox rules from bare.json
sandbox.load(path.join(__dirname, '..'));

let passed = 0;
let failed = 0;

function test(name, fn) {
	try {
		fn();
		passed++;
	} catch (e) {
		failed++;
		console.log(`FAIL: ${name}`);
		console.log(`  ${e.message}`);
	}
}

// --- Sandbox: blocked paths ---
test('blocks .env', () => {
	assert(sandbox.checkPath('.env') !== null);
});

test('blocks .git directory', () => {
	assert(sandbox.checkPath('.git/config') !== null);
});

test('blocks Windows system paths', () => {
	assert(sandbox.checkPath('C:\\Windows\\System32\\config') !== null);
});

test('blocks dangerous commands', () => {
	// Linux: blocks rm -rf /
	if (process.platform !== 'win32') {
		assert(sandbox.checkCommand('rm -rf /') !== null);
	}
	// Windows: blocks commands targeting drive roots
	if (process.platform === 'win32') {
		assert(sandbox.checkCommand('dir c:\\') !== null);
	}
});

// --- Sandbox: allowed paths ---
test('allows normal file paths', () => {
	assert(sandbox.checkPath('my-project/file.txt') === null);
});

test('allows current directory', () => {
	assert(sandbox.checkPath('./readme.md') === null);
});

test('allows normal bash commands', () => {
	assert(sandbox.checkCommand('cat file.txt') === null);
});

// --- Context truncation ---
const { truncateContextIfNeeded } = require('../context-truncation.js');

test('does not truncate when context is low', () => {
	const history = [{ role: 'user', content: 'hi' }];
	assert(truncateContextIfNeeded(history, 50) === false);
});

test('does not truncate short history', () => {
	const history = [{ role: 'user', content: 'hi' }];
	assert(truncateContextIfNeeded(history, 90) === false);
});

// --- Results ---
console.log(`\nSmoke tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
