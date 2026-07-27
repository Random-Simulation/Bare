// ═══════════════════════════════════════════════════════════
// Activity Groups — collapsible containers that collect
// thinking blocks and tool-call blocks between LLM text output.
//
// Live (pulsing):   "Thinking ×3, reading 4 files, 2 bash commands..."
// Finalized:        "Thought ×3, read 4 files, 2 bash commands..."
// Both expandable into the full current UI.
// ═══════════════════════════════════════════════════════════

const chat = window.chat;

/** Summary label templates — [singular, plural] */
const LABELS = {
    think:   { live: ['Thinking', 'Thinking ×{n}'],     done: ['Thought', 'Thought ×{n}'] },
    read:    { live: ['reading 1 file', 'reading {n} files'],     done: ['read 1 file', 'read {n} files'] },
    write:   { live: ['writing 1 file', 'writing {n} files'],     done: ['wrote 1 file', 'wrote {n} files'] },
    edit:    { live: ['editing 1 file', 'editing {n} files'],     done: ['edited 1 file', 'edited {n} files'] },
    bash:    { live: ['1 bash command', '{n} bash commands'],     done: ['1 bash command', '{n} bash commands'] },
    websearch: { live: ['1 web search', '{n} web searches'],      done: ['1 web search', '{n} web searches'] },
    finish_task: { live: ['finishing task'],                      done: ['finished task'] },
};

/** Pick a label: LABELS[tool][state][count > 1 ? 1 : 0] with {n} substituted */
function pickLabel(tool, count, state) {
    const entry = LABELS[tool];
    if (!entry) return null;
    const labels = entry[state];
    const text = count === 1 ? labels[0] : (labels[1] || labels[0]);
    return text.replace('{n}', count);
}

/** Standard order for summary parts */
const TOOL_ORDER = ['think', 'read', 'write', 'edit', 'bash', 'websearch', 'finish_task'];

/**
 * Represents a single collapsible activity group.
 * Collects thinking + tool-call blocks between LLM output.
 */
export class ActivityGroup {
    constructor() {
        this._counts = {};       // { think: 1, read: 3, bash: 1, ... }
        this._isActive = true;
        this._lastBlock = null;

        // <details> wrapper — collapsed by default (no [open] attribute)
        this.details = document.createElement('details');
        this.details.className = 'chat-item activity-group';

        // Summary line — pulsing while active
        this.summary = document.createElement('summary');
        this.summary.className = 'pulsing';
        this.summary.textContent = 'Processing...';

        // Content area where blocks are inserted
        this.content = document.createElement('div');
        this.content.className = 'activity-group-content';

        this.details.append(this.summary, this.content);
    }

    /** Insert this group into the chat */
    appendToChat() {
        chat.appendChild(this.details);
    }

    /** Insert a block element into this group's content area */
    addBlock(el) {
        this.content.appendChild(el);
        this._lastBlock = el;
    }

    /** Return the last block added (for prevEl tracking by registry) */
    getLastBlock() {
        return this._lastBlock;
    }

    /** Record a think block */
    addThink() {
        this._counts.think = (this._counts.think || 0) + 1;
        this._updateSummary();
    }

    /** Remove a think block (when no thinking happened) */
    removeThink() {
        this._counts.think = Math.max(0, (this._counts.think || 0) - 1);
        this._updateSummary();
    }

    /** Record a tool call starting (live/present tense) */
    addTool(toolName) {
        this._counts[toolName] = (this._counts[toolName] || 0) + 1;
        this._updateSummary();
    }

    /** Update the summary text */
    _updateSummary() {
        const state = this._isActive ? 'live' : 'done';
        const parts = [];

        for (const tool of TOOL_ORDER) {
            const count = this._counts[tool];
            if (!count) continue;
            const label = pickLabel(tool, count, state);
            if (label) parts.push(label);
        }

        this.summary.textContent = parts.join(', ') || 'Processing...';
    }

    /**
     * Finalize the group: switch to past tense, remove pulsing, stay collapsed.
     * Called when LLM text starts streaming.
     */
    finalize() {
        this._isActive = false;
        this.summary.classList.remove('pulsing');
        this._updateSummary();
    }

    /** Check if this group is still active (collecting) */
    get isActive() { return this._isActive; }

    /** Check if this group has any content */
    get isEmpty() {
        return Object.values(this._counts).every(v => v === 0);
    }

    /** Remove the group from the DOM */
    remove() {
        this.details.remove();
    }
}

/** Create a new activity group and append it to chat */
export function createActivityGroup() {
    const group = new ActivityGroup();
    group.appendToChat();
    return group;
}
