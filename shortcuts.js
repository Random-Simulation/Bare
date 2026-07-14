/* ------------------------------------------------------------------ */
/* Keyboard shortcuts + toolbar buttons                                */
/* ------------------------------------------------------------------ */

import { applyBareMode } from './settings.js';
import { applyVerboseMode } from './verbose-mode.js';

const folderBtn = document.getElementById('folder-btn');

/* ------------------------------------------------------------------ */
/* WorkDir toast helpers                                               */
/* ------------------------------------------------------------------ */

let _folderToast = null;
let _folderPromptShown = false;
let _folderPromptWasShown = false;
let _typeMessageToast = null;

/**
 * Show a persistent toast asking whether to restrict Bare to the chosen folder.
 */
export function promptRestrictWorkDir(dir) {
  return new Promise((resolve) => {
    const name = dir.split(/[\\/]/).pop();
    const wrapper = document.createElement('div');
    wrapper.className = 'perm-toast';

    const header = document.createElement('div');
    header.className = 'perm-toast-header';
    header.textContent = 'Restrict Bare to "' + name + '"? (Recommend Yes)';

    const detail = document.createElement('div');
    detail.className = 'perm-toast-detail';
    detail.textContent = 'Bare will only work inside this folder';

    const btnRow = document.createElement('div');
    btnRow.className = 'perm-toast-buttons';

    const btnYes = document.createElement('button');
    btnYes.className = 'perm-btn perm-btn-allow';
    btnYes.textContent = 'Yes';

    const btnNo = document.createElement('button');
    btnNo.className = 'perm-btn perm-btn-block';
    btnNo.textContent = 'No';

    btnRow.appendChild(btnYes);
    btnRow.appendChild(btnNo);
    wrapper.appendChild(header);
    wrapper.appendChild(detail);
    wrapper.appendChild(btnRow);
    document.getElementById('toast-container').appendChild(wrapper);

    function dismiss() { wrapper.remove(); }
    btnYes.addEventListener('click', () => { dismiss(); resolve(true); });
    btnNo.addEventListener('click', () => { dismiss(); resolve(false); });
  });
}

function showWorkDirToast(dir) {
  const name = dir.split(/[\\/]/).pop();
  const verb = window.__settings?.restrictToWorkDir ? 'Working in' : 'Starting in';
  addToast(verb + ' "' + name + '"', '', 3000);
}

function promptFolder() {
  clearFolderPrompt();
  _folderPromptWasShown = true;
  _folderToast = document.createElement('div');
  _folderToast.className = 'toast-line shimmer';
  _folderToast.innerHTML = '&#x2190; Choose a Folder to Work in';
  document.getElementById('toast-container').appendChild(_folderToast);
  folderBtn.classList.add('folder-shimmer');
}

function showTypeMessageToast() {
  clearTypeMessageToast();
  _typeMessageToast = document.createElement('div');
  _typeMessageToast.className = 'toast-line shimmer';
  _typeMessageToast.innerHTML = '&#x2193; Type a Message to Bare';
  document.getElementById('toast-container').appendChild(_typeMessageToast);
}

export function clearTypeMessageToast() {
  if (_typeMessageToast) { _typeMessageToast.remove(); _typeMessageToast = null; }
}

function clearFolderPrompt() {
  if (_folderToast) { _folderToast.remove(); _folderToast = null; }
  folderBtn.classList.remove('folder-shimmer');
}

/** Show folder prompt or workdir confirmation toast. Called from renderer init. */
export function showFolderPromptOrWorkDir() {
  if (_folderPromptShown) return;
  _folderPromptShown = true;
  clearFolderPrompt();
  if (!window.__settings?.workDir) {
    promptFolder();
  } else {
    const dir = window.__initDir || window.__settings.workDir;
    if (dir) showWorkDirToast(dir);
  }
}

/** Reset the folder prompt flag so it can re-show (e.g. after new session). */
export function resetFolderPrompt() {
  _folderPromptShown = false;
}

/* ------------------------------------------------------------------ */
/* Folder picker helper — shared by folder-btn and Ctrl+Shift+O       */
/* ------------------------------------------------------------------ */

async function pickFolderAndApply(onClearTypeMessageToast) {
  clearFolderPrompt();
  const dir = await window.electron.invoke('fs:pick-folder');
  console.log('[shortcuts] folder-btn picked:', dir);

  if (!dir) {
    _folderPromptShown = false;
    if (!window.__settings?.workDir) promptFolder();
    return;
  }

  folderBtn.title = 'Working in "' + dir.split(/[\\/]/).pop() + '"';

  let restrict;
  if (window.__settings.restrictPromptDismissed) {
    restrict = window.__settings.restrictToWorkDir;
  } else {
    restrict = await promptRestrictWorkDir(dir);
    window.__settings.restrictPromptDismissed = true;
  }
  window.__settings.restrictToWorkDir = restrict;
  window.__settings.workDir = dir;

  console.log('[shortcuts] saving settings with workDir:', window.__settings.workDir);
  try {
    await window.electron.invoke('settings:save', window.__settings);
  } catch (e) {
    console.error('[shortcuts] settings save FAILED:', e);
  }

  _folderPromptShown = false;
  showWorkDirToast(dir);

  if (_folderPromptWasShown) {
    _folderPromptWasShown = false;
    setTimeout(() => onClearTypeMessageToast && showTypeMessageToast(), 3300);
  }
}

/* ------------------------------------------------------------------ */
/* Safety toast + toggle                                               */
/* ------------------------------------------------------------------ */

function showSafetyToast(text) {
  addToast(text, '', 3000);
}

function toggleSafetySetting(key, label) {
  if (!window.__settings) return;
  window.__settings[key] = !window.__settings[key];
  window.electron.invoke('settings:save', window.__settings).catch(() => {});
  const el = document.getElementById('restrict-' + key + '-toggle')
    || document.getElementById(key + '-toggle');
  if (el) el.checked = window.__settings[key];
  showSafetyToast(`${label}: ${window.__settings[key] ? 'ON' : 'OFF'}`);
}

/* ------------------------------------------------------------------ */
/* Toolbar button wiring                                               */
/* ------------------------------------------------------------------ */

/**
 * Initialise toolbar buttons and keyboard shortcuts.
 * @param {object} deps — { chat, history, queuedMessages, prompt, requestStop, clearSession, scrollToBottom, clearAttachmentToasts }
 */
export function initShortcuts(deps) {
  const { chat, history, queuedMessages, prompt, requestStop, clearSession, scrollToBottom, clearAttachmentToasts } = deps;

  // -- Folder button --
  folderBtn.addEventListener('click', async () => {
    await pickFolderAndApply(() => {
      // Only show the "type a message" toast if the user hasn't
      // already sent a message (which would make the toast pointless
      // and it would never get dismissed).
      const hasSent = history.length > 0
        || chat.querySelector('.chat-item.msg.user')
        || window.__isStreaming;
      if (!hasSent) showTypeMessageToast();
    });
  });

  // -- New session button --
  document.getElementById('new-session-btn').addEventListener('click', () => {
    requestStop();
    chat.innerHTML = '';
    history.length = 0;
    queuedMessages.length = 0;
    clearAttachmentToasts();
    clearTypeMessageToast();
    window.__eventLog = [];
    window.__seq = 0;
    window.__order = 0;
    window.resetContextBar();
    clearSession();
    resetFolderPrompt();
    prompt.focus();
  });

  // -- Keyboard shortcuts --
  document.addEventListener('keydown', async (e) => {
    // Escape — stop streaming
    if (e.key === 'Escape' && window.__isStreaming) {
      e.preventDefault();
      requestStop();
    }

    // Ctrl+Shift+N — new session
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      requestStop();
      chat.innerHTML = '';
      history.length = 0;
      queuedMessages.length = 0;
      clearAttachmentToasts();
      clearTypeMessageToast();
      window.__eventLog = [];
      window.__seq = 0;
      window.__order = 0;
      window.resetContextBar();
      clearSession();
      resetFolderPrompt();
      prompt.focus();
    }

    // Ctrl+Shift+O — pick folder
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      await pickFolderAndApply(() => false); // no type-message toast on shortcut
    }

    // Ctrl+Shift+R — read-only toggle
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      toggleSafetySetting('readOnly', 'Read-only');
    }

    // Ctrl+Shift+W — restrict workdir toggle
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'W') {
      e.preventDefault();
      toggleSafetySetting('restrictToWorkDir', 'Restrict workdir');
    }

    // Ctrl+Shift+V — verbose mode toggle
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'V') {
      e.preventDefault();
      if (!window.__settings) return;
      window.__settings.verbose = !window.__settings.verbose;
      const queued = applyVerboseMode();
      const el = document.getElementById('verbose-toggle');
      if (el) el.checked = window.__settings.verbose;
      window.electron.invoke('settings:save', window.__settings).catch(() => {});
      if (!queued) {
        showSafetyToast(`Verbose mode: ${window.__settings.verbose ? 'ON' : 'OFF'}`);
      }
    }

    // Ctrl+Shift+B — BARE mode toggle
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      if (!window.__settings) return;
      window.__settings.bareMode = !window.__settings.bareMode;
      applyBareMode(window.__settings.bareMode);
      const el = document.getElementById('bare-mode-toggle');
      if (el) el.checked = window.__settings.bareMode;
      window.electron.invoke('settings:save', window.__settings).catch(() => {});
      if (window.__settings.bareMode) {
        addToast('BARE mode: ON', 'invisible', 3000);
      } else {
        showSafetyToast('BARE mode: OFF');
      }
    }
  });
}
