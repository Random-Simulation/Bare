import { escHtml, setAutoScroll, getScrollToBottom, saveSession, restoreSession, clearSession } from './utils.js';
import { loadTools, send } from './agentic-loop.js';
import { initSettings } from './settings.js';
import { initToolLog, applyVerboseMode, applyPendingVerboseMode, renderChatFromLog } from './verbose-mode.js';
import { pendingAttachments, collectAttachments, clearAttachmentToasts, initAttachments } from './attachments.js';
import { initShortcuts, showFolderPromptOrWorkDir, resetFolderPrompt, clearTypeMessageToast } from './shortcuts.js';
import { clearPermissionToasts } from './permission-toast.js';

marked.setOptions({ gfm: true, breaks: false });

/* ------------------------------------------------------------------ */
/* DOM refs                                                            */
/* ------------------------------------------------------------------ */
const chat = document.getElementById('chat');
window.chat = chat;
const prompt = document.getElementById('prompt');

const stopBtn = document.createElement('button');
stopBtn.id = 'stop-btn';
stopBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17 4h-10a3 3 0 0 0 -3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3 -3v-10a3 3 0 0 0 -3 -3z"/></svg>`;
document.getElementById('prompt-wrapper').appendChild(stopBtn);

const submitBtn = document.createElement('button');
submitBtn.id = 'submit-btn';
submitBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M12 5l0 14"/><path d="M16 9l-4 -4"/><path d="M8 9l4 -4"/></svg>`;
document.getElementById('prompt-wrapper').appendChild(submitBtn);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
let isStreaming = false;
const history = [];
const queuedMessages = [];

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
    stopBtn.classList.add('visible');
    submitBtn.classList.remove('visible');
  } else if (hasInput) {
    submitBtn.classList.add('visible');
    stopBtn.classList.remove('visible');
  } else {
    submitBtn.classList.remove('visible');
    stopBtn.classList.remove('visible');
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

function requestStop() {
  isStreaming = false;
  applyPendingVerboseMode();
  stopBtn.classList.remove('visible');
  clearPermissionToasts(); // dismiss any pending permission toasts
  if (window.__currentAbort) {
    window.__currentAbort.abort();
    window.__currentAbort = null;
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
window.saveSession = () => saveSession(history, chat.innerHTML);

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
    }).catch(err => {
      console.error('Uncaught error in agentic loop:', err);
      isStreaming = false;
      applyPendingVerboseMode();
      stopBtn.classList.remove('visible');
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
  prompt.style.height = Math.min(prompt.scrollHeight, 130) + 'px';
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

  const restored = await restoreSession(history, chat);

  // If we have an event log, re-render from it (source of truth)
  if (window.__eventLog?.length > 0) {
    renderChatFromLog(!!window.__settings?.verbose);
  } else if (restored && window.__settings?.verbose) {
    // Old session: DOM already has verbose blocks from saved HTML
  }

  scrollToBottom();
  prompt.focus();
})();

window.electron.on('tools:changed', loadTools);

// Sync workDir changes from main process
window.electron.on('settings:workdir-changed', (dir) => {
  window.__settings.workDir = dir;
  const folderBtn = document.getElementById('folder-btn');
  folderBtn.title = 'Working in "' + dir.split(/[\\/]/).pop() + '"';
});
