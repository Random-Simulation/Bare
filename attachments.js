/* ------------------------------------------------------------------ */
/* Drag & Drop — file attachments                                     */
/* ------------------------------------------------------------------ */

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);
const TEXT_EXTS  = new Set(['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.cs', '.rb', '.php', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.html', '.css', '.scss', '.less', '.json', '.yaml', '.yml', '.toml', '.xml', '.md', '.txt', '.log', '.cfg', '.conf', '.ini', '.env', '.sql', '.graphql', '.proto', '.dockerfile', '.makefile', '.gitignore', '.gitattributes', '.editorconfig', '.vimrc', '.zshrc', '.bashrc']);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Shared state: pending file attachments. Accessed by renderer.js during submit. */
export const pendingAttachments = [];

/* ------------------------------------------------------------------ */
/* File reading                                                        */
/* ------------------------------------------------------------------ */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip data: prefix
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Read a dropped File and add to pendingAttachments */
async function handleDroppedFile(file, onUpdate) {
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (file.size > MAX_FILE_SIZE) {
    addToast(`Skipped ${file.name} — too large (max 10 MB)`, 'warning', 4000);
    return;
  }

  try {
    if (IMAGE_EXTS.has(ext)) {
      const base64 = await fileToBase64(file);
      const mime = file.type || 'image/png';
      pendingAttachments.push({ type: 'image', name: file.name, mime, base64 });
    } else if (TEXT_EXTS.has(ext)) {
      const content = await file.text();
      pendingAttachments.push({ type: 'text', name: file.name, content });
    } else {
      addToast(`Skipped ${file.name} — unsupported type`, 'warning', 3000);
      return;
    }
  } catch (err) {
    addToast(`Failed to read ${file.name}`, 'error', 4000);
    console.error('[drag-drop] read error:', err);
    return;
  }
  renderAttachmentToasts();
  onUpdate();
}

/* ------------------------------------------------------------------ */
/* Attachment toasts                                                   */
/* ------------------------------------------------------------------ */

/** Render attachment toasts — replaces all existing attachment toasts */
function renderAttachmentToasts(onUpdate) {
  document.querySelectorAll('.toast-attachment').forEach(el => el.remove());

  for (let i = 0; i < pendingAttachments.length; i++) {
    const att = pendingAttachments[i];
    const line = document.createElement('div');
    line.className = 'toast-line toast-attachment';

    const label = document.createElement('span');
    label.textContent = `Attached: ${att.name}`;

    const btn = document.createElement('button');
    btn.className = 'toast-dismiss';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      pendingAttachments.splice(i, 1);
      renderAttachmentToasts(onUpdate);
      onUpdate();
    });

    line.append(label, btn);
    document.getElementById('toast-container').appendChild(line);
  }
}

/** Clear all attachment toasts */
export function clearAttachmentToasts() {
  document.querySelectorAll('.toast-attachment').forEach(el => el.remove());
}

/** Collect attachments from pendingAttachments.
 * Returns { images, textForAgent, textForDisplay } */
export function collectAttachments() {
  const images = [];
  const agentParts = [];
  const displayParts = [];

  for (const att of pendingAttachments) {
    if (att.type === 'image') {
      images.push({ mimeType: att.mime, base64: att.base64 });
      displayParts.push(`--- Attached: ${att.name} ---`);
    } else if (att.type === 'text') {
      agentParts.push(`--- Attached: ${att.name} ---\n${att.content}`);
      displayParts.push(`--- Attached: ${att.name} ---`);
    }
  }

  return {
    images,
    textForAgent: agentParts.length > 0 ? agentParts.join('\n\n') + '\n\n' : '',
    textForDisplay: displayParts.length > 0 ? displayParts.join('\n\n') + '\n\n' : '',
  };
}

/* ------------------------------------------------------------------ */
/* Drag-and-drop wiring                                                */
/* ------------------------------------------------------------------ */

function preventDragDefault(e) {
  e.preventDefault();
  e.stopPropagation();
}

function handleDrop(e, onUpdate) {
  e.preventDefault();
  e.stopPropagation();

  let files = [];
  if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length === 0 && e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    files = [...e.dataTransfer.files];
  }

  if (files.length === 0) return;

  (async () => {
    for (const file of files) {
      try {
        await handleDroppedFile(file, onUpdate);
      } catch (err) {
        console.error('[drag-drop] error:', err);
      }
    }
  })();
}

/**
 * Initialise drag-and-drop listeners.
 * @param {Function} onUpdate — callback after attachment state changes (e.g. update button visibility)
 */
export function initAttachments(onUpdate) {
  const chat = document.getElementById('chat');
  const inputArea = document.getElementById('input-area');

  document.addEventListener('dragover', preventDragDefault, true);
  document.addEventListener('dragenter', preventDragDefault, true);
  document.addEventListener('drop', (e) => handleDrop(e, onUpdate), true);
  chat.addEventListener('dragover', preventDragDefault);
  chat.addEventListener('drop', (e) => handleDrop(e, onUpdate));
  inputArea.addEventListener('dragover', preventDragDefault);
  inputArea.addEventListener('drop', (e) => handleDrop(e, onUpdate));
}
