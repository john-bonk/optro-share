/**
 * Prototype Feedback Widget
 * Floating sticky-note panel for in-context feedback on any prototype page.
 * Notes persist in localStorage, keyed per page.
 * Includes "Copy all" to paste feedback into Claude.
 */
(function () {
  const PAGE_KEY = 'optro_proto_notes__' + location.pathname.split('/').pop();

  // ── CSS ─────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    #fb-btn {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9000;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      background: #1e1b4b;
      color: #fff;
      border: none;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(30,27,75,0.35);
      font-family: inherit;
      transition: background 0.15s, transform 0.1s;
      user-select: none;
    }
    #fb-btn:hover { background: #3730a3; transform: translateY(-1px); }

    #fb-badge {
      background: #a5b4fc;
      color: #1e1b4b;
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 11px;
      font-weight: 800;
      display: none;
    }
    #fb-badge.visible { display: inline-block; }

    #fb-panel {
      position: fixed;
      bottom: 80px;
      right: 24px;
      z-index: 9001;
      width: 340px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(15,23,42,0.18);
      font-family: inherit;
      display: none;
      flex-direction: column;
      overflow: hidden;
      max-height: 520px;
    }
    #fb-panel.open { display: flex; }

    #fb-header {
      background: #1e1b4b;
      padding: 12px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    #fb-header-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #fb-header-title {
      color: #e0e7ff;
      font-size: 13px;
      font-weight: 700;
    }
    #fb-header-page {
      color: #818cf8;
      font-size: 11px;
    }
    #fb-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .fb-hbtn {
      background: rgba(255,255,255,0.12);
      border: none;
      border-radius: 6px;
      color: #c7d2fe;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.1s;
    }
    .fb-hbtn:hover { background: rgba(255,255,255,0.22); }
    #fb-close-btn {
      background: none;
      border: none;
      color: #818cf8;
      font-size: 16px;
      cursor: pointer;
      line-height: 1;
      padding: 2px 4px;
    }
    #fb-close-btn:hover { color: #fff; }

    #fb-notes-list {
      overflow-y: auto;
      flex: 1;
      padding: 8px 0;
    }
    #fb-notes-list:empty::after {
      content: 'No notes yet. Add one below.';
      display: block;
      text-align: center;
      color: #94a3b8;
      font-size: 12px;
      padding: 20px 14px;
    }

    .fb-note {
      padding: 10px 14px;
      border-bottom: 1px solid #f1f5f9;
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }
    .fb-note:last-child { border-bottom: none; }
    .fb-note-body { flex: 1; min-width: 0; }
    .fb-note-text {
      font-size: 13px;
      color: #1e293b;
      line-height: 1.5;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .fb-note-time {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 3px;
    }
    .fb-note-del {
      background: none;
      border: none;
      color: #cbd5e1;
      font-size: 14px;
      cursor: pointer;
      line-height: 1;
      padding: 0 2px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .fb-note-del:hover { color: #ef4444; }

    #fb-compose {
      border-top: 1px solid #e2e8f0;
      padding: 10px 12px;
      background: #f8fafc;
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    #fb-textarea {
      flex: 1;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 13px;
      font-family: inherit;
      resize: none;
      min-height: 40px;
      max-height: 100px;
      outline: none;
      color: #1e293b;
      background: #fff;
      line-height: 1.4;
    }
    #fb-textarea:focus { border-color: #818cf8; }
    #fb-add-btn {
      background: #3730a3;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 7px 12px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      transition: background 0.15s;
      align-self: flex-end;
    }
    #fb-add-btn:hover { background: #4338ca; }

    /* copied flash */
    #fb-copied-flash {
      position: fixed;
      bottom: 80px;
      right: 24px;
      background: #22c55e;
      color: #fff;
      padding: 8px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      z-index: 9999;
      display: none;
      font-family: inherit;
    }
  `;
  document.head.appendChild(style);

  // ── HTML ─────────────────────────────────────────────────────────────────
  const pageName = location.pathname.split('/').pop() || 'index';

  const btnEl = document.createElement('button');
  btnEl.id = 'fb-btn';
  btnEl.innerHTML = `📝 Notes <span id="fb-badge"></span>`;

  const panelEl = document.createElement('div');
  panelEl.id = 'fb-panel';
  panelEl.innerHTML = `
    <div id="fb-header">
      <div id="fb-header-left">
        <div id="fb-header-title">📝 Prototype Notes</div>
        <div id="fb-header-page">${pageName}</div>
      </div>
      <div id="fb-header-actions">
        <button class="fb-hbtn" id="fb-copy-btn">Copy all</button>
        <button class="fb-hbtn" id="fb-clear-btn">Clear</button>
        <button id="fb-close-btn">✕</button>
      </div>
    </div>
    <div id="fb-notes-list"></div>
    <div id="fb-compose">
      <textarea id="fb-textarea" placeholder="Add a note…" rows="2"></textarea>
      <button id="fb-add-btn">+ Add</button>
    </div>
  `;

  const copiedFlash = document.createElement('div');
  copiedFlash.id = 'fb-copied-flash';
  copiedFlash.textContent = '✓ Copied to clipboard';

  document.body.appendChild(btnEl);
  document.body.appendChild(panelEl);
  document.body.appendChild(copiedFlash);

  // ── State ────────────────────────────────────────────────────────────────
  function loadNotes() {
    try { return JSON.parse(localStorage.getItem(PAGE_KEY)) || []; }
    catch { return []; }
  }

  function saveNotes(notes) {
    localStorage.setItem(PAGE_KEY, JSON.stringify(notes));
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
           ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    const notes = loadNotes();
    const list = document.getElementById('fb-notes-list');
    const badge = document.getElementById('fb-badge');

    list.innerHTML = '';
    notes.forEach(note => {
      const el = document.createElement('div');
      el.className = 'fb-note';
      el.innerHTML = `
        <div class="fb-note-body">
          <div class="fb-note-text">${escHtml(note.text)}</div>
          <div class="fb-note-time">${formatTime(note.ts)}</div>
        </div>
        <button class="fb-note-del" data-id="${note.id}" title="Delete">×</button>
      `;
      list.appendChild(el);
    });

    list.querySelectorAll('.fb-note-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const updated = loadNotes().filter(n => n.id !== btn.dataset.id);
        saveNotes(updated);
        render();
      });
    });

    if (notes.length > 0) {
      badge.textContent = notes.length;
      badge.classList.add('visible');
    } else {
      badge.classList.remove('visible');
    }
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  btnEl.addEventListener('click', () => {
    panelEl.classList.toggle('open');
    if (panelEl.classList.contains('open')) {
      document.getElementById('fb-textarea').focus();
    }
  });

  document.getElementById('fb-close-btn').addEventListener('click', () => {
    panelEl.classList.remove('open');
  });

  document.getElementById('fb-add-btn').addEventListener('click', addNote);

  document.getElementById('fb-textarea').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addNote();
    }
  });

  function addNote() {
    const ta = document.getElementById('fb-textarea');
    const text = ta.value.trim();
    if (!text) return;
    const notes = loadNotes();
    notes.unshift({ id: Date.now().toString(), text, ts: Date.now() });
    saveNotes(notes);
    ta.value = '';
    render();
    document.getElementById('fb-notes-list').scrollTop = 0;
  }

  document.getElementById('fb-clear-btn').addEventListener('click', () => {
    if (confirm('Clear all notes for this page?')) {
      saveNotes([]);
      render();
    }
  });

  document.getElementById('fb-copy-btn').addEventListener('click', () => {
    const notes = loadNotes();
    if (!notes.length) return;
    const text = `Feedback for: ${pageName}\n\n` +
      notes.map((n, i) => `${i + 1}. [${formatTime(n.ts)}]\n${n.text}`).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      copiedFlash.style.display = 'block';
      setTimeout(() => { copiedFlash.style.display = 'none'; }, 2000);
    });
  });

  render();
})();
