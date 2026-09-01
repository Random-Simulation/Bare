import { escHtml, setAutoScroll, getScrollToBottom, saveSession, restoreSession, clearSession } from './utils.js';
import { loadTools, send } from './agentic-loop.js';
import { initSettings } from './settings.js';
import { initToolLog, applyVerboseMode, applyPendingVerboseMode, renderChatFromLog } from './verbose-mode.js';
import { pendingAttachments, collectAttachments, clearAttachmentToasts, initAttachments } from './attachments.js';
import { initShortcuts, showFolderPromptOrWorkDir, resetFolderPrompt, clearTypeMessageToast } from './shortcuts.js';
import { clearPermissionToasts } from './permission-toast.js';
import { initHistoryModal } from './history-modal.js';
import { handleNewSession, handleTempSession, loadHistoryIntoState } from './session-manager.js';
import { addCopyButtons } from './utils.js';

marked.setOptions({ gfm: true, breaks: false });

/* ------------------------------------------------------------------ */
/* DOM refs                                                            */
/* ------------------------------------------------------------------ */
const chat = document.getElementById('chat');
window.chat = chat;
const prompt = document.getElementById('prompt');

const stopBtn = document.createElement('button');
stopBtn.id = 'stop-btn';
stopBtn.title = 'Stop agent';
stopBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="currentColor"><path d="M17 4h-10a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3 -3v-10a3 3 0 0 0 -3 -3z"/></svg>`;
document.getElementById('prompt-wrapper').appendChild(stopBtn);

const submitBtn = document.createElement('button');
submitBtn.id = 'submit-btn';
submitBtn.title = 'Send prompt';
submitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 5l0 14"/><path d="M16 9l-4 -4"/><path d="M8 9l4 -4"/></svg>`;
document.getElementById('prompt-wrapper').appendChild(submitBtn);

const interruptBtn = document.createElement('button');
interruptBtn.id = 'interrupt-btn';
interruptBtn.title = 'Interrupt agent';
interruptBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="currentColor"><path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M14.897 1a4 4 0 0 1 2.664 1.016l.165 .156l4.1 4.1a4 4 0 0 1 1.168 2.605l.006 .227v5.794a4 4 0 0 1 -1.016 2.664l-.156 .165l-4.1 4.1a4 4 0 0 1 -2.603 1.168l-.227 .006h-5.795a3.999 3.999 0 0 1 -2.664 -1.017l-.165 -.156l-4.1 -4.1a4 4 0 0 1 -1.168 -2.604l-.006 -.227v-5.794a4 4 0 0 1 1.016 -2.664l.156 -.165l4.1 -4.1a4 4 0 0 1 2.605 -1.168l.227 -.006h5.793zm-2.887 14l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007zm-.01 -8a1 1 0 0 0 -.993 .883l-.007 .117v4l.007 .117a1 1 0 0 0 1.986 0l.007 -.117v-4l-.007 -.117a1 1 0 0 0 -.993 -.883z" /></svg>`;
document.getElementById('prompt-wrapper').appendChild(interruptBtn);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
let isStreaming = false;
const history = [];
const queuedMessages = [];

// Saved conversation history state (window refs so history-store can read)
window.__history = history;
window.__session = {
  isTemporarySession: false,
  currentHistoryId: null,
  currentHistoryTitle: null,
  awaitingTitle: false,
};
// Stubs used by session-manager.js (filled in after imports)
window.__renderFromLog = (verbose) => renderChatFromLog(verbose);
window.__addCopyButtons = addCopyButtons;

// Mirror isStreaming on window so verbose-mode.js can check it
Object.defineProperty(window, '__isStreaming', {
  get() { return isStreaming; },
  configurable: true,
});

/* ------------------------------------------------------------------ */
/* Button visibility                                                   */
/* ------------------------------------------------------------------ */
function updateButtonVisibility() {
  const hasInput = prompt.value.trim().length > 0 || pendingAttachments.length > 0;
  if (isStreaming) {
    // While a message is queued during generation, show the interrupt button
    // in place of the stop button so the queued message can be sent now.
    // (Escape still stops generation at any time.)
    if (queuedMessages.length > 0) {
      interruptBtn.classList.add('visible');
      stopBtn.classList.remove('visible');
      submitBtn.classList.remove('visible');
    } else {
      stopBtn.classList.add('visible');
      interruptBtn.classList.remove('visible');
      submitBtn.classList.remove('visible');
    }
  } else if (hasInput) {
    submitBtn.classList.add('visible');
    stopBtn.classList.remove('visible');
    interruptBtn.classList.remove('visible');
  } else {
    submitBtn.classList.remove('visible');
    stopBtn.classList.remove('visible');
    interruptBtn.classList.remove('visible');
  }
}

submitBtn.addEventListener('click', () => {
  if (prompt.value.trim().length > 0) {
    submitPrompt();
    updateButtonVisibility();
  }
});

/* ------------------------------------------------------------------ */
/* Stop / abort                                                        */
/* ------------------------------------------------------------------ */
stopBtn.addEventListener('click', () => { if (isStreaming) doRequestStop(); });

interruptBtn.addEventListener('click', () => {
  if (isStreaming && queuedMessages.length > 0) {
    // Swap the buttons immediately for feedback; the agentic loop keeps
    // running and injects the queued message at the top of the next turn.
    interruptBtn.classList.remove('visible');
    stopBtn.classList.add('visible');
    interruptForInjection();
  }
});

function requestStop() {
  isStreaming = false;
  applyPendingVerboseMode();
  stopBtn.classList.remove('visible');
  interruptBtn.classList.remove('visible');
  clearPermissionToasts(); // dismiss any pending permission toasts
  if (window.__currentAbort) {
    window.__currentAbort.abort();
    window.__currentAbort = null;
  }
}

// Steering interrupt: abort the in-flight stream WITHOUT stopping the loop.
// isStreaming stays true, so agentic-loop detects __abortReason==='interrupt'
// and salvages the partial turn (text + reasoning) then continues, letting the
// queued message be injected at the top of the next iteration. Triggered by
// the interrupt button (which replaces the stop button while a message is
// queued); otherwise queued messages simply wait for the turn to end.
function interruptForInjection() {
  if (window.__currentAbort) {
    window.__abortReason = 'interrupt';
    window.__currentAbort.abort();
  }
}

function doRequestStop() {
  requestStop();
  updateButtonVisibility();
}

/* ------------------------------------------------------------------ */
/* Scrolling                                                           */
/* ------------------------------------------------------------------ */
const scrollToBottom = getScrollToBottom(chat);

chat.addEventListener('scroll', () => {
  setAutoScroll(chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40);
});

chat.addEventListener('toggle', (e) => {
  if (e.target.matches('details[open]')) {
    requestAnimationFrame(() => {
      const distFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
      setAutoScroll(distFromBottom < 40);
    });
  }
}, true);

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */
window.saveSession = async () => {
	// Temporary sessions are never persisted
	if (window.__session?.isTemporarySession) return;
	if (history.length === 0) return;
	await saveSession(history, chat.innerHTML);
};

/* ------------------------------------------------------------------ */
/* Input handling                                                      */
/* ------------------------------------------------------------------ */
function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `chat-item msg ${role}`;
  div.dataset.seq = ++window.__seq;
  div.dataset.order = ++window.__order;
  div.textContent = text;
  chat.appendChild(div);
  scrollToBottom();
  return div;
}

function submitPrompt() {
  // Block sending if no workDir has been chosen
  if (!isStreaming && !window.__settings?.workDir) {
    showFolderPromptOrWorkDir();
    return;
  }
  const text = prompt.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  // Collect attachments before clearing
  const { images, textForAgent, textForDisplay } = collectAttachments();
  const fullText = textForAgent + text;
  const displayText = textForDisplay + text;

  // Dismiss toasts on prompt submission
  clearAttachmentToasts();
  clearTypeMessageToast();
  pendingAttachments.length = 0;

  if (isStreaming) {
    // Queue the message: it is injected at the start of the next LLM turn.
    // The interrupt button (shown in place of the stop button) lets the user
    // send it immediately if they don't want to wait.
    queuedMessages.push({ text: fullText, displayText, images });
    addMsg('user', displayText);
    prompt.value = '';
    prompt.style.height = 'auto';
    updateButtonVisibility();
  } else {
    prompt.value = '';
    prompt.style.height = 'auto';
    updateButtonVisibility();
    window.__streamStartVerbose = !!window.__settings?.verbose;
    send({
      history, queuedMessages,
      chat, prompt, stopBtn,
      text: fullText,
      displayText,
      images,
      isStreaming: () => isStreaming,
      setIsStreaming: (v) => {
        isStreaming = v;
        updateButtonVisibility();
        if (!v) applyPendingVerboseMode();
      },
      requestStop,
      scrollToBottom,
      addMsg,
      onQueueDrained: updateButtonVisibility,
    }).catch(err => {
      console.error('Uncaught error in agentic loop:', err);
      isStreaming = false;
      applyPendingVerboseMode();
      updateButtonVisibility();
      const div = document.createElement('div');
      div.className = 'chat-item msg ai markdown-content';
      div.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-tert').trim();
      div.textContent = `Agent loop crashed unexpectedly: ${err.message}`;
      chat.appendChild(div);
      scrollToBottom();
    });
  }
}

prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitPrompt();
  }
});

prompt.addEventListener('input', () => {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 240) + 'px';
  updateButtonVisibility();
  // Dismiss the "type a message" toast as soon as user starts typing
  clearTypeMessageToast();
});

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

// Wire attachments (drag-and-drop)
initAttachments(updateButtonVisibility);

// Wire shortcuts + toolbar buttons
initShortcuts({
  chat, history, queuedMessages, prompt,
  requestStop, clearSession, scrollToBottom, clearAttachmentToasts,
});

(async () => {
  await loadTools().catch(err => console.error('Failed to load tools:', err));
  await initSettings();

  // Set folder button tooltip to current workdir
  const folderBtn = document.getElementById('folder-btn');
  const initDir = await window.electron.invoke('fs:workdir');
  window.__initDir = initDir;
  folderBtn.title = window.__settings?.workDir
    ? 'Working in "' + initDir.split(/[\\/]/).pop() + '"'
    : 'Choose a Folder to Work in';

  // Show folder prompt / workdir toast after settings are loaded
  setTimeout(() => showFolderPromptOrWorkDir(), 500);

  // Restore the last active saved conversation history on startup.
  // Check if a mid-loop checkpoint (full_session.json) is fresher than the
  // last completed session save — covers the crash/close-mid-loop scenario.
  const last = await window.electron.invoke('sessions:last');
  const checkpoint = await window.electron.invoke('session:load-full');

  if (checkpoint?.history?.length > (last?.history?.length || 0)) {
    // Checkpoint is ahead of the saved session — restore from it
    loadHistoryIntoState({
      id: last?.id || null,
      title: last?.title || 'Untitled Chat',
      history: checkpoint.history,
      eventLog: checkpoint.eventLog || [],
    });
  } else if (last?.history?.length > 0) {
    loadHistoryIntoState(last);
  } else {
    // No saved history — keep existing (legacy session.json) restore behaviour
    const restored = await restoreSession(history, chat);
    // If we have an event log, re-render from it (source of truth)
    if (window.__eventLog?.length > 0) {
      renderChatFromLog(!!window.__settings?.verbose);
    }
  }

  scrollToBottom();
  prompt.focus();
})();

/* ------------------------------------------------------------------ */
/* Session buttons                                                     */
/* ------------------------------------------------------------------ */
const sessionDeps = {
  chat, prompt, history, queuedMessages,
  requestStop: doRequestStop,
  resetFolderPrompt,
};

document.getElementById('new-session-btn').addEventListener('click', async () => {
  if (isStreaming) doRequestStop();
  await handleNewSession(sessionDeps);
  updateButtonVisibility();
});

document.getElementById('temp-session-btn').addEventListener('click', () => {
  if (isStreaming) doRequestStop();
  handleTempSession(sessionDeps);
  updateButtonVisibility();
});

// Wire history modal
initHistoryModal(sessionDeps);

window.electron.on('tools:changed', loadTools);

// Sync workDir changes from main process
window.electron.on('settings:workdir-changed', (dir) => {
  window.__settings.workDir = dir;
  const folderBtn = document.getElementById('folder-btn');
  folderBtn.title = 'Working in "' + dir.split(/[\\/]/).pop() + '"';
});
