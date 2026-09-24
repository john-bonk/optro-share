/*
 * Assistant runtime — manifest-driven chat player.
 *
 * Runs inside the assistant iframe. Reads `window.__ASSISTANT_CONTENT`
 * (populated by `tprm-content-loader`) and takes over the chat's
 * assistant-side rendering:
 *
 *   • Quick-action pill clicks are intercepted at capture phase and
 *     routed to the player, which walks the manifest's `chatScripts[]`
 *     with time-realistic gaps and paints each message via a per-kind
 *     renderer.
 *   • The freetext input's Send is also intercepted: if the user's text
 *     matches a manifest `freetextTrigger`, the corresponding script is
 *     played; otherwise the runtime emits a default assistant reply.
 *   • Persona / mode picks stay bundle-native — the bundle's own UI
 *     handles them fine and their content already comes from the
 *     manifest via a matching set of names.
 *
 * The runtime is designed to support multiple content manifests
 * (Default today, TPRM next, more in the future). New message kinds can
 * be added by registering another `Renderers[kind]`. Scripts author's
 * source of truth is the JSON manifest — no code changes required to
 * ship new content.
 */
(function(){
  'use strict';

  // ─────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(selector, timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll(){
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout: ' + selector));
        setTimeout(poll, 60);
      })();
    });
  }

  function el(tag, opts) {
    opts = opts || {};
    const node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
    if (opts.style) for (const k in opts.style) node.style[k] = opts.style[k];
    if (opts.text != null) node.textContent = opts.text;
    if (opts.html != null) node.innerHTML = opts.html;
    if (opts.children) opts.children.forEach((c) => c && node.appendChild(c));
    return node;
  }

  /**
   * Light-touch markdown: **bold**, _italic_, `code`, [text](url), plus
   * paragraph splitting on blank lines. Matches how the bundle renders
   * its assistant text (each paragraph is a <p> with spacing between).
   */
  function md(text) {
    if (text == null) return '';
    const escape = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const paragraphs = String(text).split(/\n\n+/);
    return paragraphs.map((p, i) => {
      let h = escape(p).replace(/\n/g, '<br>');
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/_(.+?)_/g, '<em>$1</em>');
      h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
      h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      const style = i === 0 ? 'margin: 0px;' : 'margin: 8px 0px 0px;';
      return `<p style="${style}"><span>${h}</span></p>`;
    }).join('');
  }

  // ─────────────────────────────────────────────────────────
  // Icons — inline SVG lookup. Bundle uses <svg><use href="#luna-name"/></svg>
  // referencing an inline symbol sprite. Same trick works from us.
  // ─────────────────────────────────────────────────────────
  function icon(name, size) {
    const s = size || 12;
    return `<svg class="_Icon_kum9n_5" width="${s}px" height="${s}px" role="presentation" data-qid-icon-name="${name}"><use href="#luna-${name}" xlink:href="#luna-${name}"></use></svg>`;
  }

  // ─────────────────────────────────────────────────────────
  // Renderer registry — one function per message `kind`.
  // Each returns a wrapper <div> ready to append into the messageList.
  // Renderers can be async when they need to sequence internal timing
  // (e.g. a wizard that reveals questions).
  // ─────────────────────────────────────────────────────────
  const Renderers = {};

  Renderers.user = (m) => {
    const w = el('div');
    w.innerHTML = `<div class="_userMessageRow_1vvl1_255"><div class="_userMessage_1vvl1_255"></div></div>`;
    w.querySelector('._userMessage_1vvl1_255').textContent = m.text || '';
    return w;
  };

  Renderers['queued-user'] = Renderers.user;

  Renderers.assistant = (m) => {
    const w = el('div');
    const stack = el('div', { class: '_YStack_dia70_1', attrs: { 'data-spacing': 'xs' } });
    const bubble = el('div', { class: '_assistantMessage_1vvl1_297', html: md(m.text || '') });
    stack.appendChild(bubble);
    stack.appendChild(actionBar());
    w.appendChild(stack);
    return w;
  };

  function actionBar() {
    const bar = el('div', {
      class: '_XStack_765xb_1 _actionBar_1vvl1_323',
      attrs: { 'data-xstack-align': 'center', 'data-spacing': 'xs', 'data-width': 'full', 'data-flexwrap': 'nowrap' },
    });
    const mkBtn = (label, iconName) => {
      const wrap = el('span', { class: '_trigger_rsu1j_2' });
      wrap.innerHTML = `<button aria-label="${label}" class="_btn_gkzbb_1 _Button_gkzbb_54" data-variant="transparent" data-size="xs" data-width="auto" type="button"><div class="_content_gkzbb_77"><div class="_label_gkzbb_104">${icon(iconName, 16)}</div></div></button>`;
      return wrap;
    };
    bar.appendChild(mkBtn('Copy', 'copy'));
    bar.appendChild(mkBtn('Good Response', 'hand-thumbs-up'));
    bar.appendChild(mkBtn('Bad Response', 'hand-thumbs-down'));
    return bar;
  }

  // commentary — bundle JSX:
  //   <div class="_commentary_1vvl1_335">
  //     <Spinner size="xs"/>
  //     <Text font="100" color="gray-500">{text}</Text>
  //   </div>
  Renderers.commentary = (m) => {
    const w = el('div');
    const c = el('div', { class: '_commentary_1vvl1_335' });
    // Inline spinner (Luna spinner default look — small rotating dot ring)
    const spinner = el('span', {
      class: '_Spinner_16m86_1',
      attrs: { 'data-size': 'xs', 'aria-hidden': 'true' },
      html: `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" style="animation: spin 1s linear infinite">
        <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
                stroke-dasharray="12 24" opacity="0.6"/>
      </svg>`,
    });
    c.appendChild(spinner);
    const text = el('span', {
      class: '_Text_1p30k_3',
      attrs: { 'data-font': '100', 'data-color': 'gray-500' },
      text: m.text || '',
    });
    c.appendChild(text);
    w.appendChild(c);
    return w;
  };

  // external-sources — exact bundle JSX (net):
  //   <div class="_sourcesCard_1vvl1_611 [_sourcesCardOpen_1vvl1_615]">
  //     <button class="_sourcesHeader_1vvl1_617" aria-expanded={open}>
  //       <Icon icon={open?"chevron-down":"chevron-right"} size="sm"/>
  //       <span class="_sourcesCount_1vvl1_636">{N} source[s]</span>
  //       <span class="_sourcesGlobe_1vvl1_641"><Icon icon="globe2" size="sm"/></span>
  //     </button>
  //     {open && <div class="_sourcesList_1vvl1_646">
  //       {sources.map(s => (
  //         <a class="_sourceRow_1vvl1_652" href={s.url}>
  //           <Icon icon="globe2" size="sm"/>              ← 3-col grid: 18px|1fr|auto
  //           <span class="_sourceLabel_1vvl1_667">{s.label}</span>
  //           <span class="_sourceDomain_1vvl1_674">{s.domain}</span>
  //         </a>
  //       ))}
  //     </div>}
  //   </div>
  Renderers['external-sources'] = (m) => {
    const w = el('div');
    const sources = m.sources || [];
    const n = sources.length;
    w.innerHTML = `<div class="_sourcesCard_1vvl1_611">
  <button type="button" class="_sourcesHeader_1vvl1_617" aria-expanded="false">
    ${icon('chevron-right', 14)}
    <span class="_sourcesCount_1vvl1_636">${n} source${n === 1 ? '' : 's'}</span>
    <span class="_sourcesGlobe_1vvl1_641">${icon('globe2', 14)}</span>
  </button>
</div>`;
    const card = w.querySelector('._sourcesCard_1vvl1_611');
    const header = w.querySelector('._sourcesHeader_1vvl1_617');
    const list = el('div', { class: '_sourcesList_1vvl1_646', style: { display: 'none' } });
    sources.forEach((s) => {
      const row = el('a', {
        class: '_sourceRow_1vvl1_652',
        attrs: { href: s.url || '#', target: '_blank', rel: 'noopener' },
      });
      // 3-column grid — icon | label | domain. Missing the icon jams
      // the label into the 18px icon column, truncating it to "S...".
      row.innerHTML = `${icon('globe2', 14)}<span class="_sourceLabel_1vvl1_667">${escapeHtml(s.label || s.title || '')}</span><span class="_sourceDomain_1vvl1_674">${escapeHtml(s.domain || '')}</span>`;
      row.addEventListener('click', (e) => e.preventDefault());
      list.appendChild(row);
    });
    card.appendChild(list);
    header.addEventListener('click', () => {
      const expanded = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      list.style.display = expanded ? 'none' : 'block';
      card.classList.toggle('_sourcesCardOpen_1vvl1_615', !expanded);
      const chev = header.querySelector('use');
      if (chev) {
        const href = expanded ? '#luna-chevron-right' : '#luna-chevron-down';
        chev.setAttribute('href', href);
        chev.setAttribute('xlink:href', href);
      }
    });
    return w;
  };

  // Luna Button helper — matches the bundle's exact DOM emitted by the
  // <Button> component (className "_btn_gkzbb_1 _Button_gkzbb_54",
  // data-variant, data-size, nested content > label wrappers). Without
  // the inner wrappers, Luna's CSS selectors don't hit and the button
  // renders as unstyled text.
  function lunaButton(label, opts) {
    opts = opts || {};
    const variant = opts.variant || 'white';
    const size = opts.size || 'sm';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = '_btn_gkzbb_1 _Button_gkzbb_54';
    btn.setAttribute('data-variant', variant);
    btn.setAttribute('data-size', size);
    btn.setAttribute('data-width', 'auto');
    btn.setAttribute('data-luna-feature', 'meld');
    const content = document.createElement('div');
    content.className = '_content_gkzbb_77';
    content.setAttribute('data-qid-luna-button-content', '');
    const labelEl = document.createElement('div');
    labelEl.className = '_label_gkzbb_104';
    labelEl.setAttribute('data-qid-luna-button-label', '');
    if (opts.iconName) {
      labelEl.insertAdjacentHTML('afterbegin', icon(opts.iconName, 14) + ' ');
    }
    labelEl.appendChild(document.createTextNode(String(label)));
    content.appendChild(labelEl);
    btn.appendChild(content);
    if (typeof opts.onClick === 'function') {
      btn.addEventListener('click', opts.onClick);
    }
    return btn;
  }

  // suggestion-buttons — exact bundle JSX:
  //   <div class="_suggestionButtons_1vvl1_439">
  //     [<Text font="100" color="gray-600">{intro}</Text>]
  //     <div class="_suggestionList_1vvl1_446">
  //       {options.map(o => <Button variant={o.primary?"blue":"white"} size="sm">
  //         {o.icon && <Icon icon={o.icon}/>}{o.label}
  //       </Button>)}
  //     </div>
  //   </div>
  Renderers['suggestion-buttons'] = (m, ctx) => {
    const w = el('div', { class: '_suggestionButtons_1vvl1_439' });
    if (m.intro) {
      const intro = el('span', {
        class: '_Text_1p30k_3',
        attrs: { 'data-font': '100', 'data-color': 'gray-600' },
        text: m.intro,
      });
      w.appendChild(intro);
    }
    const list = el('div', { class: '_suggestionList_1vvl1_446' });
    (m.buttons || m.options || []).forEach((btnDef) => {
      const b = lunaButton(btnDef.label || btnDef.text || '', {
        variant: btnDef.primary ? 'blue' : 'white',
        size: 'sm',
        iconName: btnDef.icon || null,
        onClick: () => {
          if (!btnDef.scriptId || !ctx?.player) return;
          // Route through the context resolver so in-chat CTAs also
          // pick up the Acme-focused variant when applicable.
          const player = ctx.player;
          const resolved = resolveScriptId(player, btnDef.scriptId);
          if (player.manifest.chatScripts?.[resolved]) {
            player.play(resolved, { append: true });
          }
        },
      });
      list.appendChild(b);
    });
    w.appendChild(list);
    return w;
  };

  // Ensure the small style block for our data-table extensions
  // (expand icon, combined show-more link, download button) exists
  // exactly once per iframe document. The fullscreen modal itself
  // lives in the parent window (see openDataTableModal below), so
  // its styles are NOT emitted here.
  function ensureDataTableExtraStyles() {
    if (document.getElementById('tprm-dt-extra-styles')) return;
    const s = document.createElement('style');
    s.id = 'tprm-dt-extra-styles';
    s.textContent = `
      .tprm-dt-hdr { display: flex; align-items: baseline; gap: 0.5rem; }
      .tprm-dt-hdr > :first-child { flex: 1; min-width: 0; }
      .tprm-dt-expand-btn { flex: none; background: transparent; border: 0;
        padding: 0.25rem; margin: -0.25rem -0.25rem -0.25rem 0.25rem;
        color: #64748b; cursor: pointer; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center; }
      .tprm-dt-expand-btn:hover { background: #f1f5f9; color: #0f172a; }
      .tprm-dt-expand-btn svg { display: block; width: 14px; height: 14px; }
      /* Footer row upgraded to a flex layout — meta+show-more sit
         together on the left, download button anchors the right edge. */
      .tprm-dt-footer-row { display: flex !important; align-items: center;
        gap: 0.5rem; width: 100%; }
      .tprm-dt-footer-meta { display: inline-flex; align-items: center; gap: 0.375rem; flex: 1; min-width: 0; }
      /* Combined "Showing N of M · Show N more" — one clickable line
         (button when truncated, plain span when fully expanded). */
      .tprm-dt-showmore { display: inline-flex; align-items: center; gap: 0.375rem;
        background: transparent; border: 0; padding: 0.1875rem 0.375rem;
        margin: -0.1875rem 0 -0.1875rem -0.375rem;
        font: inherit; font-size: 0.75rem; color: #266c92; cursor: pointer;
        border-radius: 4px; }
      .tprm-dt-showmore:hover { background: #e3f0f2; text-decoration: none; }
      .tprm-dt-showmore .tprm-dt-showmore-count { color: #64748b; }
      .tprm-dt-showmore .tprm-dt-showmore-cta { color: #266c92; font-weight: 500; }
      .tprm-dt-showmore:hover .tprm-dt-showmore-cta { text-decoration: underline; }
      .tprm-dt-showmore .tprm-dt-showmore-sep { color: #cbd5e1; }
      .tprm-dt-showmore svg { width: 12px; height: 12px; color: #266c92; }
      /* Static footer meta (no truncation — no button). */
      .tprm-dt-showcount { display: inline-flex; align-items: center;
        font-size: 0.75rem; color: #64748b; }
      /* Download button — Luna-style ghost icon+label, right-anchored. */
      .tprm-dt-download { flex: none; display: inline-flex; align-items: center;
        gap: 0.375rem; background: transparent; border: 0;
        padding: 0.25rem 0.4375rem; font: inherit; font-size: 0.75rem;
        color: #475569; cursor: pointer; border-radius: 4px;
        margin-left: auto; }
      .tprm-dt-download:hover { background: #f1f5f9; color: #0f172a; }
      .tprm-dt-download svg { width: 12px; height: 12px; }
    `;
    document.head.appendChild(s);
  }

  // Inline SVG glyphs (Luna icon set doesn't reliably reach the iframe
  // for arbitrary names — inline is safest here). box-arrow-up-right,
  // chevron-down, close, and download mirror the Luna symbols.
  const TPRM_DT_ICONS = {
    expand:      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2H2v4"/><path d="M2 2l5 5"/><path d="M10 14h4v-4"/><path d="M14 14l-5-5"/></svg>',
    chevronDown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>',
    close:       '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l10 10"/><path d="M13 3L3 13"/></svg>',
    download:    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v9"/><path d="M4.5 7.5L8 11l3.5-3.5"/><path d="M2 14h12"/></svg>',
  };

  // CSV encode + trigger download. Runs inside the iframe; browsers
  // save the file to the iframe origin's downloads folder — fine for
  // demo purposes. Cells are quoted defensively.
  function downloadDataTableCsv(m) {
    const cols = m.columns || [];
    const rows = m.rows || [];
    const escapeCsv = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [];
    lines.push(cols.map((c) => escapeCsv(c.label || c.key)).join(','));
    rows.forEach((r) => {
      lines.push(cols.map((c) => escapeCsv(r[c.key])).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const slug = String(m.title || 'data-table').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'data-table';
    a.download = slug + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Render the table body for a given visible-row count. Extracted so
  // Show-more can rebuild the tbody in place without touching the
  // header / footer chrome.
  function renderDataTableBody(cols, rows, maxVisible) {
    const tbody = el('tbody');
    rows.slice(0, maxVisible).forEach((r) => {
      const tr = el('tr', { class: '_dataTableRow_1vvl1_858' });
      cols.forEach((c) => {
        let val = r[c.key];
        if (val == null) val = '';
        if (c.type === 'link') {
          const a = el('a', { class: '_dataTableLink_1vvl1_875', text: String(val), attrs: { href: '#', onclick: 'event.preventDefault()' } });
          const td = el('td'); td.appendChild(a); tr.appendChild(td);
        } else {
          const td = el('td', { text: String(val) });
          if (c.type === 'number') td.className = '_dataTableNumberCell_1vvl1_866';
          tr.appendChild(td);
        }
      });
      tbody.appendChild(tr);
    });
    return tbody;
  }

  // Full-table modal — routes to the parent window so the backdrop
  // covers the ENTIRE viewport (not just the 400px sidecar iframe).
  // The parent listens for `optro-open-datatable-modal` and renders
  // the modal at document.body level. Payload contains only what the
  // parent needs to reconstruct the table: title, columns, rows.
  function openDataTableModal(m) {
    const payload = {
      type: 'optro-open-datatable-modal',
      table: {
        title: m.title || 'Table',
        caption: m.caption || '',
        columns: m.columns || [],
        rows: m.rows || [],
      },
    };
    try { window.parent.postMessage(payload, '*'); } catch (_) {}
  }

  Renderers['data-table'] = (m) => {
    ensureDataTableExtraStyles();
    const w = el('div');
    const card = el('div', { class: '_dataTableCard_1vvl1_701' });
    const cols = m.columns || [];
    const rows = m.rows || [];
    // Header — title on the left, expand-icon button on the right.
    // `.tprm-dt-hdr` overlays the compiled `_dataTableHeader_` with a
    // flex row so the icon has a stable right anchor.
    if (m.title || rows.length > 0) {
      const header = el('div', { class: '_dataTableHeader_1vvl1_766 tprm-dt-hdr' });
      header.innerHTML =
        `<span><span class="_Text_1p30k_3" data-font="200" data-weight="strong">${md(m.title || '')}</span>` +
        (m.caption ? `<span class="_dataTableCaption_1vvl1_707">${md(m.caption)}</span>` : '') +
        `</span>` +
        `<button type="button" class="tprm-dt-expand-btn" aria-label="Open full table">${TPRM_DT_ICONS.expand}</button>`;
      card.appendChild(header);
    }
    const scroller = el('div', { class: '_dataTableScroller_1vvl1_773' });
    const table = el('table', { class: '_dataTable_1vvl1_701' });
    // Column header — same as before.
    const thead = el('thead');
    const trH = el('tr');
    cols.forEach((c) => {
      const th = el('th', { text: c.label || c.key });
      if (c.width) th.style.width = c.width;
      trH.appendChild(th);
    });
    thead.appendChild(trH);
    table.appendChild(thead);
    // Body — mutable via Show-more. Track visible count in a closure
    // so incremental expansion doesn't require re-rendering the shell.
    const initialVisible = Math.min(m.maxVisibleRows || rows.length, rows.length);
    let visible = initialVisible;
    let tbody = renderDataTableBody(cols, rows, visible);
    table.appendChild(tbody);
    scroller.appendChild(table);
    card.appendChild(scroller);
    // Footer — flex row with the combined "Showing N of M · Show N
    // more" element on the LEFT, and the CSV Download button on the
    // RIGHT. `SHOW_MORE_STEP` scales with the pool size so a 12-row
    // table jumps 5 at a time; a 100-row table jumps 10.
    const footer = el('div', { class: '_dataTableFooter_1vvl1_890' });
    const footerRow = el('div', { class: '_dataTableFooterRow_1vvl1_896 tprm-dt-footer-row' });
    const totalRows = rows.length;
    const SHOW_MORE_STEP = Math.max(5, Math.min(10, Math.ceil(totalRows / 2)));
    function updateFooter() {
      const truncated = visible < totalRows;
      // Clear and rebuild — a combined left element + fixed right
      // download button. No orange warning styling on truncated state.
      footerRow.innerHTML = '';
      if (truncated) {
        const next = Math.min(SHOW_MORE_STEP, totalRows - visible);
        const btn = el('button', { class: 'tprm-dt-showmore', attrs: { type: 'button', 'aria-label': 'Show ' + next + ' more rows' } });
        btn.innerHTML =
          `<span class="tprm-dt-showmore-count">Showing ${visible.toLocaleString()} of ${totalRows.toLocaleString()} rows</span>` +
          `<span class="tprm-dt-showmore-sep">·</span>` +
          `<span class="tprm-dt-showmore-cta">Show ${next} more</span>` +
          TPRM_DT_ICONS.chevronDown;
        btn.addEventListener('click', () => {
          visible = Math.min(totalRows, visible + SHOW_MORE_STEP);
          const nextBody = renderDataTableBody(cols, rows, visible);
          tbody.replaceWith(nextBody);
          tbody = nextBody;
          updateFooter();
        });
        footerRow.appendChild(btn);
      } else {
        const meta = el('span', { class: 'tprm-dt-showcount', text: `${totalRows.toLocaleString()} row${totalRows === 1 ? '' : 's'}` });
        footerRow.appendChild(meta);
      }
      // Right-anchored download button. Present regardless of
      // truncation state — CSV export is a table-level affordance,
      // not gated by row count.
      const dl = el('button', { class: 'tprm-dt-download', attrs: { type: 'button', 'aria-label': 'Download as CSV' } });
      dl.innerHTML = TPRM_DT_ICONS.download + `<span>Download</span>`;
      dl.addEventListener('click', () => downloadDataTableCsv(m));
      footerRow.appendChild(dl);
    }
    updateFooter();
    footer.appendChild(footerRow);
    card.appendChild(footer);
    // Delegated click at the card level — survives any DOM structure
    // change inside the header that would break a direct
    // querySelector binding on the expand button. Show-more and
    // download keep their own direct listeners (attached fresh each
    // updateFooter() rebuild) so we don't double-fire.
    card.addEventListener('click', (ev) => {
      try {
        const t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest('.tprm-dt-expand-btn')) {
          ev.preventDefault();
          openDataTableModal(m);
        }
      } catch (err) {
        // Never let a UI handler swallow the whole message render.
        try { console && console.warn && console.warn('[data-table] click handler error', err); } catch (_) {}
      }
    });
    w.appendChild(card);
    return w;
  };

  // Chart card — the bundle uses Chart.js. We inline an SVG that mimics
  // the same footer structure ({N} data points + Download button).
  Renderers.chart = (m) => {
    const w = el('div');
    const card = el('div', { class: '_chartCard_1vvl1_702' });
    if (m.title) {
      card.appendChild(el('div', {
        class: '_chartHeader_1vvl1_728',
        html: `<span class="_Text_1p30k_3" data-font="200" data-weight="strong">${md(m.title)}</span>`,
      }));
    }
    const canvas = el('div', { class: '_chartCanvas_1vvl1_734' });
    const data = m.data || [];
    const max = Math.max(1, ...data.map((d) => d.value || 0));
    const w0 = 320;
    const h0 = 140;
    const gap = 12;
    const padX = 12;
    const barW = data.length ? Math.max(8, Math.floor((w0 - padX * 2) / data.length) - gap) : 0;
    let barsSvg = '';
    data.forEach((d, i) => {
      const x = padX + i * (barW + gap);
      const hgt = ((d.value || 0) / max) * (h0 - 40);
      const y = h0 - hgt - 22;
      barsSvg += `<rect x="${x}" y="${y}" width="${barW}" height="${hgt}" fill="#7c3aed" rx="3"></rect>`;
      barsSvg += `<text x="${x + barW/2}" y="${y - 4}" text-anchor="middle" font-size="10" fill="#0f172a" font-weight="600">${d.value ?? ''}</text>`;
      barsSvg += `<text x="${x + barW/2}" y="${h0 - 4}" text-anchor="middle" font-size="10" fill="#64748b">${(d.label || '').slice(0, 12)}</text>`;
    });
    canvas.innerHTML = `<svg width="100%" viewBox="0 0 ${w0} ${h0}" preserveAspectRatio="xMidYMid meet">${barsSvg}</svg>`;
    card.appendChild(canvas);
    const footer = el('div', { class: '_chartFooter_1vvl1_740' });
    const noun = data.length === 1 ? 'data point' : 'data points';
    const meta = el('span', {
      class: '_chartFooterMeta_1vvl1_752',
      text: `${data.length} ${noun}${m.valueLabel ? ' · ' + m.valueLabel : ''}`,
    });
    footer.appendChild(meta);
    footer.appendChild(lunaButton('Download', { variant: 'transparent', size: 'sm' }));
    card.appendChild(footer);
    w.appendChild(card);
    return w;
  };

  // Plan card — matches the canonical SAVED PLAN layout:
  //   Header:  "SAVED PLAN" eyebrow (no status pill in the ready-to-run state)
  //   Steps:   minimal layout (grid: 1fr auto) — title | kebab
  //            supervised steps get an inline badge + "You'll review the
  //            result before I continue." caption in orange
  //   Footer:  Change plan (white) + Run plan → (blue)
  //
  // Description bullets are NOT rendered inside the card — they read as
  // redundant next to the step titles. If a script wants a narrative
  // preface it should emit an `assistant` message BEFORE the plan.
  Renderers.plan = (m) => {
    const w = el('div');
    const card = el('div', { class: '_planCard_1vvl1_1127' });
    // Header — eyebrow only for the design/ready-to-run state.
    const header = el('div', { class: '_planCardHeader_1vvl1_1146' });
    const eyebrow = String(m.eyebrow || 'Saved plan').toUpperCase();
    header.innerHTML = `<span class="_planEyebrow_1vvl1_1159">${escapeHtml(eyebrow)}</span>`;
    card.appendChild(header);
    // Steps — minimal layout (no status column). Kebab menu on the
    // right; supervised badge inline with title + caption below title
    // for supervised steps.
    const steps = el('ol', { class: '_planSteps_1vvl1_1205' });
    (m.steps || []).forEach((s) => {
      const classes = ['_planStep_1vvl1_1205', '_planStepMinimal_1vvl1_1227'];
      if (s.supervised && !s.skipped) classes.push('_planStepSupervised_1vvl1_1354');
      if (s.skipped) classes.push('_planStepSkipped_1vvl1_1377');
      const li = el('li', { class: classes.join(' ') });
      // Supervised marker — small amber person icon RENDERED FIRST inside
      // the title row, so it sits to the left of the title text on the
      // same line. Using plain text for the title (no md() wrapping in a
      // <p>) keeps the icon inline with the text.
      const supervisedMark = s.supervised && !s.skipped
        ? `<span class="_planSupervisedMark_1vvl1_x" aria-label="Supervised — you'll review before this fires" title="Supervised — you'll review before this fires">${icon('person-fill', 12)}</span>`
        : '';
      const titleText = escapeHtml(s.title || '');
      li.innerHTML =
        `<div class="_planStepBody_1vvl1_1253">` +
          `<div class="_planStepTitle_1vvl1_1260">${supervisedMark}<span class="_planStepTitleText_1vvl1_x">${titleText}</span></div>` +
          (s.result ? `<div class="_planStepResult_1vvl1_1274">${md(s.result)}</div>` : '') +
        `</div>` +
        `<span class="_planStepKebab_1vvl1_1321" aria-label="Step actions">${icon('more-horizontal', 14)}</span>`;
      steps.appendChild(li);
    });
    card.appendChild(steps);
    const foot = el('div', { class: '_planCardFooter_1vvl1_1307' });
    foot.appendChild(lunaButton('Change plan', { variant: 'white', size: 'sm', iconName: 'arrow-left-right' }));
    foot.appendChild(lunaButton('Run plan', { variant: 'blue', size: 'sm' }));
    card.appendChild(foot);
    w.appendChild(card);
    return w;
  };

  // confirm-tool — exact bundle JSX:
  //   <div class="_confirmTool_1vvl1_548">
  //     <div class="_confirmToolIcon_1vvl1_559">
  //       <Icon icon="globe" size="md"/>
  //     </div>
  //     <div class="_confirmToolBody_1vvl1_569">
  //       <div class="_confirmToolTitle_1vvl1_576">{description}</div>
  //       <div class="_confirmToolActions_1vvl1_582">
  //         <Button variant="white" size="sm">Cancel</Button>
  //         <Button variant="blue"  size="sm">Proceed</Button>
  //       </div>
  //     </div>
  //   </div>
  // Bundle uses `description` as the title text; my manifest uses
  // either `title`, `body`, or `description` — accept all three.
  Renderers['confirm-tool'] = (m) => {
    const w = el('div');
    const card = el('div', { class: '_confirmTool_1vvl1_548' });
    card.innerHTML = `<div class="_confirmToolIcon_1vvl1_559">${icon(m.icon || 'globe', 20)}</div>
<div class="_confirmToolBody_1vvl1_569">
  <div class="_confirmToolTitle_1vvl1_576">${md(m.description || m.title || 'Confirm action')}</div>
  ${m.body ? `<div>${md(m.body)}</div>` : ''}
  <div class="_confirmToolActions_1vvl1_582"></div>
</div>`;
    const actions = card.querySelector('._confirmToolActions_1vvl1_582');
    // Bundle puts Cancel (white) first, Proceed (blue) second — mirror.
    actions.appendChild(lunaButton(m.rejectLabel || 'Cancel', { variant: 'white', size: 'sm' }));
    actions.appendChild(lunaButton(m.acceptLabel || 'Proceed', { variant: 'blue', size: 'sm' }));
    w.appendChild(card);
    return w;
  };

  // Entity-type → icon map (from bundle's nX() function).
  function entityIcon(type) {
    const k = String(type || '').toLowerCase();
    if (k === 'control') return 'shield-check';
    if (k === 'issue') return 'exclamation-circle';
    if (k === 'risk') return 'exclamation-triangle';
    if (k === 'key risk indicator') return 'speedometer';
    if (k === 'vendor') return 'building';
    if (k === 'assessment') return 'clipboard-check';
    if (k === 'document') return 'file-earmark-text';
    if (k === 'finding') return 'flag';
    if (k === 'person') return 'person';
    if (k === 'contract') return 'file-earmark-check';
    if (k === 'policy') return 'shield-lock';
    return 'document-complete';
  }

  // entity-card — exact bundle JSX (ret):
  //   <div class="_entityCard_1vvl1_346">
  //     <div class="_objectLabel_1vvl1_395">
  //       <Icon icon={nX(entityType)} size="sm"/> {entityType}
  //     </div>
  //     {mode==="reference"
  //       ? <a class="_entityCardUid_1vvl1_356" href="#">{title}</a>
  //       : <Text weight="strong" font="200">{title}</Text>}
  //     <Text font="100" color="gray-500" clamp={3}>{description}</Text>
  //     <div class="_entityCardAction_1vvl1_404">
  //       <Button variant="blue" size="sm">{actionLabel}</Button>
  //     </div>
  //   </div>
  Renderers['entity-card'] = (m) => {
    const w = el('div');
    const card = el('div', { class: '_entityCard_1vvl1_346' });
    // Object label (type row with icon).
    const label = el('div', { class: '_objectLabel_1vvl1_395' });
    label.innerHTML = `${icon(entityIcon(m.entityType), 14)} <span>${escapeHtml(m.entityType || 'Entity')}</span>`;
    card.appendChild(label);
    // Title — link if reference mode, otherwise a strong Text
    const titleText = m.title || m.entityName || '';
    if (m.mode === 'reference') {
      const a = el('a', { class: '_entityCardUid_1vvl1_356', text: titleText, attrs: { href: '#' } });
      a.addEventListener('click', (e) => e.preventDefault());
      card.appendChild(a);
    } else {
      const title = el('span', {
        class: '_Text_1p30k_3',
        attrs: { 'data-font': '200', 'data-weight': 'strong' },
        text: titleText,
      });
      card.appendChild(title);
    }
    // Description
    if (m.description || m.body) {
      const desc = el('span', {
        class: '_Text_1p30k_3',
        attrs: { 'data-font': '100', 'data-color': 'gray-500', 'data-clamp': '3' },
        text: m.description || m.body,
      });
      card.appendChild(desc);
    }
    // Action button
    if (m.action || m.actionLabel) {
      const actionWrap = el('div', { class: '_entityCardAction_1vvl1_404' });
      const label = (m.action && m.action.label) || m.actionLabel || 'Create';
      actionWrap.appendChild(lunaButton(label, { variant: 'blue', size: 'sm' }));
      card.appendChild(actionWrap);
    }
    w.appendChild(card);
    return w;
  };

  // Diff card — exact bundle JSX:
  //   <div class="_diffCard_1vvl1_494">
  //     <div class="_objectLabel_1vvl1_395">
  //       <Icon icon={nX(entityType)} size="sm"/> {entityType} · {entityId}
  //     </div>
  //     <Text weight="strong" font="200">{entityName}</Text>
  //     <div class="_diffFields_1vvl1_504">
  //       {fields.map(f => (
  //         <div class="_diffRow_1vvl1_513">
  //           <div class="_diffLabel_1vvl1_521">{f.label}</div>
  //           <div class="_diffValues_1vvl1_529">
  //             <span class="_diffOld_1vvl1_537">{f.oldValue}</span>
  //             <Icon icon="arrow-right" size="xs"/>
  //             <span class="_diffNew_1vvl1_542">{f.newValue}</span>
  //           </div>
  //         </div>
  //       ))}
  //     </div>
  //   </div>
  Renderers.diff = (m) => {
    const w = el('div');
    const card = el('div', { class: '_diffCard_1vvl1_494' });
    if (m.entityType) {
      const label = el('div', { class: '_objectLabel_1vvl1_395' });
      label.innerHTML = `${icon(entityIcon(m.entityType), 14)} <span>${escapeHtml(m.entityType)}${m.entityId ? ' · ' + escapeHtml(m.entityId) : ''}</span>`;
      card.appendChild(label);
    }
    if (m.entityName) {
      const name = el('span', {
        class: '_Text_1p30k_3',
        attrs: { 'data-font': '200', 'data-weight': 'strong' },
        text: m.entityName,
      });
      card.appendChild(name);
    }
    const fieldsWrap = el('div', { class: '_diffFields_1vvl1_504' });
    (m.fields || []).forEach((f) => {
      const row = el('div', { class: '_diffRow_1vvl1_513' });
      row.innerHTML = `
        <div class="_diffLabel_1vvl1_521">${escapeHtml(f.label || '')}</div>
        <div class="_diffValues_1vvl1_529">
          <span class="_diffOld_1vvl1_537">${escapeHtml(f.oldValue ?? '—')}</span>
          ${icon('arrow-right', 10)}
          <span class="_diffNew_1vvl1_542">${escapeHtml(f.newValue ?? '—')}</span>
        </div>`;
      fieldsWrap.appendChild(row);
    });
    card.appendChild(fieldsWrap);
    w.appendChild(card);
    return w;
  };

  // Wizard — bundle renders a step-by-step interactive form. Prototype
  // implementation: show header (N of M) + question + choice options
  // as Luna buttons. Advancing is a nice-to-have; for prototype we
  // just render the first question.
  Renderers.wizard = (m) => {
    const w = el('div');
    const card = el('div', { class: '_wizard_1vvl1_700' });
    const steps = m.steps || m.questions || [];
    const first = steps[0] || {};
    const header = el('div', { class: '_wizardHeader_1vvl1_1562' });
    header.innerHTML = `<span class="_wizardCount_1vvl1_1568">1 of ${steps.length || 1}</span>`;
    card.appendChild(header);
    const q = el('div', { class: '_wizardQuestion_1vvl1_1574', text: first.question || first.text || m.title || 'Question' });
    card.appendChild(q);
    if ((first.kind || 'choice') === 'choice' && Array.isArray(first.options)) {
      const opts = el('div', { class: '_wizardOptions_1vvl1_1581' });
      first.options.forEach((opt) => {
        const b = el('button', {
          class: '_wizardOption_1vvl1_1581',
          attrs: { type: 'button' },
          text: opt,
        });
        opts.appendChild(b);
      });
      card.appendChild(opts);
    } else if (first.kind === 'text') {
      const ta = el('textarea', {
        class: '_wizardTextarea_1vvl1_1614',
        attrs: { rows: 3, placeholder: first.placeholder || 'Type your answer…' },
      });
      card.appendChild(ta);
    }
    w.appendChild(card);
    return w;
  };

  // write-modal — exact bundle JSX (cet):
  //   <div class="_writeModalRow_1vvl1_1517 [_writeModalRowSent_1vvl1_1540]">
  //     <Icon icon={sent ? "check-circle-fill" : "envelope"} size="sm" />
  //     <span class="_writeModalRowText_1vvl1_1535">
  //       {sent ? "Sent ✓ · 7 reminder emails" : intro}
  //     </span>
  //     {!sent && <Button variant="blue" size="sm">Review & send</Button>}
  //   </div>
  // The full email form is a MODAL that opens on Review & send. For the
  // prototype we skip the modal and go straight to "sent" state.
  Renderers['write-modal'] = (m) => {
    const w = el('div');
    const row = el('div', { class: '_writeModalRow_1vvl1_1517' });
    const iconWrap = el('span', { html: icon('envelope', 16) });
    iconWrap.setAttribute('data-tprm-write-icon', '');
    row.appendChild(iconWrap);
    const textEl = el('span', {
      class: '_writeModalRowText_1vvl1_1535',
      text: m.intro || m.body || 'Draft ready',
    });
    row.appendChild(textEl);
    const sentText = m.sentText || 'Sent ✓ · escalation email out';
    const btn = lunaButton(m.submitLabel || 'Review & send', {
      variant: 'blue',
      size: 'sm',
      onClick: () => {
        // Flip to "sent" state — same visual as bundle after form submit.
        row.classList.add('_writeModalRowSent_1vvl1_1540');
        iconWrap.innerHTML = icon('check-circle-fill', 16);
        textEl.textContent = sentText;
        btn.remove();
      },
    });
    row.appendChild(btn);
    w.appendChild(row);
    return w;
  };

  // suggested-edit — text-diff card for single-field edit suggestions.
  //   Schema:
  //     { kind: 'suggested-edit', field: 'description',
  //       current:   [{ text: '...', removed?: true }, ...],
  //       suggested: [{ text: '...', added?:   true }, ...] }
  //   Renders:
  //     ┌── SUGGESTED EDIT ─────────────────────┐
  //     │  description                           │
  //     │  Current                               │
  //     │  <existing prose · removed=strikethru> │
  //     │  ─────                                 │
  //     │  Suggested                             │
  //     │  <new prose · added=bold>              │
  //     │  ─────                                 │
  //     │                    [Dismiss] [Apply]   │
  //     └────────────────────────────────────────┘
  function ensureSuggestedEditStyles() {
    if (document.getElementById('tprm-suggested-edit-styles')) return;
    const style = document.createElement('style');
    style.id = 'tprm-suggested-edit-styles';
    style.textContent = `
      .tprm-suggested-edit { border: 1px solid #e2e8f0; border-radius: 10px; background: #fff;
        overflow: hidden; font-size: 0.875rem; color: #0f172a; line-height: 1.5; }
      .tprm-se-eyebrow { padding: 0.75rem 1rem; font-size: 0.6875rem; letter-spacing: 0.08em;
        text-transform: uppercase; font-weight: 700; color: #64748b; border-bottom: 1px solid #f1f5f9;
        display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
      .tprm-se-eyebrow-label { flex: 1; }
      /* Vertical 3-dot menu on the eyebrow — toggles Combine / Separate. */
      /* Combined / Separate edits toggle is hidden for now — combined
         is the only rendered view. Wrap + button + menu still live in
         DOM (dispatchers + click wiring intact) so flipping this back
         to display:inline-flex re-enables the affordance. */
      .tprm-se-dot-menu-wrap { position: relative; display: none; }
      .tprm-se-dot-menu-btn { background: transparent; border: 0; padding: 0.25rem;
        margin: -0.25rem -0.25rem -0.25rem 0; cursor: pointer; color: #64748b;
        border-radius: 4px; display: inline-flex; align-items: center; }
      .tprm-se-dot-menu-btn:hover { background: #f1f5f9; color: #0f172a; }
      .tprm-se-dot-menu-btn svg { display: block; }
      .tprm-se-dot-menu { position: absolute; top: calc(100% + 0.25rem); right: 0; z-index: 20;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 6px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); min-width: 10rem; padding: 0.25rem; }
      .tprm-se-dot-menu[hidden] { display: none; }
      .tprm-se-dot-menu-item { display: block; width: 100%; text-align: left;
        background: transparent; border: 0; padding: 0.5rem 0.625rem; font: inherit;
        font-size: 0.8125rem; font-weight: 500; color: #0f172a; letter-spacing: 0;
        text-transform: none; cursor: pointer; border-radius: 4px; }
      .tprm-se-dot-menu-item:hover { background: #f1f5f9; }
      .tprm-se-body { padding: 1rem 1rem 0.5rem; }
      .tprm-se-field { font-weight: 600; font-size: 0.8125rem; color: #0f172a; margin: 0.125rem 0 0.375rem; }
      .tprm-se-section { padding: 0.375rem 0 1rem; }
      .tprm-se-section + .tprm-se-section { border-top: 1px solid #e2e8f0; padding-top: 0.875rem; }
      .tprm-se-label { font-weight: 600; font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.375rem; }
      .tprm-se-current { color: #475569; }
      .tprm-se-suggested { color: #0f172a; }
      /* Strike + add spans style regardless of parent block so the combined
         view (removed inline inside .tprm-se-suggested) renders the same
         strike/add treatment as the separate view. */
      .tprm-suggested-edit .tprm-se-strike { text-decoration: line-through; color: #94a3b8; }
      .tprm-suggested-edit .tprm-se-add { font-weight: 700; color: #0f172a; }
      .tprm-se-foot { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
        padding: 0.625rem 1rem 0.875rem; border-top: 1px solid #f1f5f9; }
      .tprm-se-applied { padding: 0.75rem 1rem; font-size: 0.8125rem; color: #14532d;
        background: #f0fdf4; border-top: 1px solid #dcfce7; }
      .tprm-se-dismissed { padding: 0.75rem 1rem; font-size: 0.8125rem; color: #64748b;
        background: #f8fafc; border-top: 1px solid #f1f5f9; }
      .tprm-sc-list { padding: 0.125rem 0; }
      .tprm-sc-row { padding: 0.375rem 0; line-height: 1.5; color: #0f172a; }
      .tprm-sc-row + .tprm-sc-row { border-top: 1px solid #f1f5f9; }
      .tprm-sc-id { color: #2563eb; font-weight: 500; text-decoration: none; }
      .tprm-sc-id:hover { text-decoration: underline; }
      .tprm-sc-text { color: inherit; font-weight: 400; }
      .tprm-sc-empty { color: #94a3b8; font-style: italic; padding: 0.5rem 0; }
      .tprm-sc-removing .tprm-sc-id { color: #94a3b8; text-decoration: line-through; }
      .tprm-sc-removing .tprm-sc-text { color: #94a3b8; text-decoration: line-through; }
      /* recommended-controls — checkbox list; deselected rows downshade
         so the reviewer can see at a glance what will apply. */
      .tprm-rc-list { display: flex; flex-direction: column; padding: 0.125rem 0 0.25rem; }
      .tprm-rc-row { display: flex; align-items: flex-start; gap: 0.625rem; padding: 0.5rem 0;
        cursor: pointer; line-height: 1.5; color: #0f172a; transition: color 120ms ease, opacity 120ms ease; }
      .tprm-rc-row + .tprm-rc-row { border-top: 1px solid #f1f5f9; }
      .tprm-rc-row .tprm-rc-cb { margin-top: 0.1875rem; flex-shrink: 0; }
      .tprm-rc-body { flex: 1; min-width: 0; }
      .tprm-rc-row.is-omitted { opacity: 0.55; }
      .tprm-rc-row.is-omitted .tprm-sc-id { color: #94a3b8; }
      .tprm-rc-row.is-omitted .tprm-sc-text { color: #94a3b8; }
      /* Field-header row wrapping "Controls" label + right-aligned
         "More" link button for revealing a second batch of recommendations. */
      .tprm-rc-field-hdr { display: flex; align-items: baseline;
        justify-content: space-between; gap: 0.75rem; margin: 0.125rem 0 0.375rem; }
      .tprm-rc-field-hdr .tprm-se-field { margin: 0; }
      .tprm-rc-more { background: none; border: 0; padding: 0; font: inherit;
        font-size: 0.75rem; font-weight: 500; color: #266c92; cursor: pointer;
        letter-spacing: 0; text-transform: none; }
      .tprm-rc-more:hover { text-decoration: underline; }
      .tprm-rc-more[disabled] { color: #94a3b8; cursor: default; text-decoration: none; }
      /* Give the recommended-controls Apply button a bit more horizontal
         breathing room than the default sm Luna button provides. */
      .tprm-rc-apply { padding-left: 1.125rem !important; padding-right: 1.125rem !important; }
    `;
    document.head.appendChild(style);
  }

  // suggested-connection — simpler variant for entity-mapping. Unlike
  // suggested-edit (before/after text diff), this just lists the N target
  // entities and lets the reviewer confirm add-or-remove.
  //   Schema:
  //     { kind: 'suggested-connection', mode: 'add' | 'remove',
  //       field: 'Controls', items: [{ id, text }, …] }
  //   Legacy `adding` / `removing` arrays are still accepted so older
  //   scripts don't need to migrate.
  Renderers['suggested-connection'] = (m) => {
    ensureSuggestedEditStyles();
    const isRemove = m.mode === 'remove' || (Array.isArray(m.removing) && m.removing.length > 0);
    const items = Array.isArray(m.items)   ? m.items
                : isRemove && Array.isArray(m.removing) ? m.removing
                : Array.isArray(m.adding)  ? m.adding
                : [];
    const rowCls = isRemove ? 'tprm-sc-row tprm-sc-removing' : 'tprm-sc-row';
    const rowHtml = (row) => {
      const id = escapeHtml(row.id || '');
      const txt = escapeHtml(row.text || '');
      return `<div class="${rowCls}"><a class="tprm-sc-id" href="#" onclick="return false">#${id}</a> <span class="tprm-sc-text">${txt}</span></div>`;
    };
    const emptyMsg = isRemove ? 'No controls selected to remove.' : 'No controls selected.';
    const listBlock = items.length
      ? items.map(rowHtml).join('')
      : `<div class="tprm-sc-empty">${emptyMsg}</div>`;
    const eyebrow = isRemove ? 'Remove Connection' : 'Add Connection';
    const defaultApplied = isRemove
      ? (items.length === 1 ? 'Removed · Control unmapped from the vendor profile.'
                            : `Removed · ${items.length} controls unmapped from the vendor profile.`)
      : (items.length === 1 ? 'Applied · Control mapped to the vendor profile.'
                            : `Applied · ${items.length} controls mapped to the vendor profile.`);
    const w = el('div');
    const card = el('div', { class: 'tprm-suggested-edit' });
    card.innerHTML = `
      <div class="tprm-se-eyebrow">${eyebrow}</div>
      <div class="tprm-se-body">
        <div class="tprm-se-field">${escapeHtml(m.field || 'Controls')}</div>
        <div class="tprm-sc-list">${listBlock}</div>
      </div>
      <div class="tprm-se-foot"></div>
    `;
    const foot = card.querySelector('.tprm-se-foot');
    const dismissBtn = lunaButton(m.dismissLabel || 'Dismiss', {
      variant: 'white', size: 'sm',
      onClick: () => {
        foot.remove();
        const note = el('div', { class: 'tprm-se-dismissed', text: 'Suggestion dismissed.' });
        card.appendChild(note);
      },
    });
    const applyBtn = lunaButton(m.applyLabel || (isRemove ? 'Remove' : 'Apply'), {
      variant: 'blue', size: 'sm',
      onClick: () => {
        try {
          if (window.parent && window.parent !== window) {
            const payload = isRemove
              ? {
                  type: 'optro-apply-suggested-disconnection',
                  field: (m.field || 'controls').toLowerCase(),
                  remove: items.map((r) => ({ id: r.id, text: r.text })),
                }
              : {
                  type: 'optro-apply-suggested-connection',
                  field: (m.field || 'controls').toLowerCase(),
                  add: items.map((r) => ({ id: r.id, text: r.text })),
                };
            window.parent.postMessage(payload, '*');
          }
        } catch (e) { /* cross-origin — no-op */ }
        foot.remove();
        const note = el('div', {
          class: 'tprm-se-applied',
          text: m.appliedText || defaultApplied,
        });
        card.appendChild(note);
      },
    });
    foot.appendChild(dismissBtn);
    foot.appendChild(applyBtn);
    w.appendChild(card);
    return w;
  };

  // recommended-controls — checkbox list of N proposed controls, all
  // pre-selected. Reviewer can deselect any (subtle downshade); Apply
  // maps only the checked subset to the vendor profile.
  //   Schema:
  //     { kind: 'recommended-controls', field: 'Controls',
  //       vendorName: 'Acme Cloud Co.',
  //       items: [{ id, text }, …], appliedText?: '…{N}…' }
  Renderers['recommended-controls'] = (m) => {
    ensureSuggestedEditStyles();
    const items = Array.isArray(m.items) ? m.items : [];
    const moreItems = Array.isArray(m.moreItems) ? m.moreItems : [];
    const selection = new Set(items.map((r) => r.id));
    const w = el('div');
    const card = el('div', { class: 'tprm-suggested-edit' });
    card.innerHTML = `
      <div class="tprm-se-eyebrow">Suggested Controls</div>
      <div class="tprm-se-body">
        <div class="tprm-rc-field-hdr">
          <div class="tprm-se-field">${escapeHtml(m.field || 'Controls')}</div>
          ${moreItems.length ? '<button type="button" class="tprm-rc-more">More</button>' : ''}
        </div>
        <div class="tprm-rc-list"></div>
      </div>
      <div class="tprm-se-foot"></div>
    `;
    const listEl = card.querySelector('.tprm-rc-list');
    const foot = card.querySelector('.tprm-se-foot');
    const moreBtn = card.querySelector('.tprm-rc-more');
    const setApplyLabel = () => {
      const n = selection.size;
      applyBtn.textContent = n === 0 ? 'Apply' : (n === 1 ? 'Apply 1' : `Apply ${n}`);
      applyBtn.disabled = n === 0;
      applyBtn.style.opacity = n === 0 ? '0.5' : '';
      applyBtn.style.cursor = n === 0 ? 'not-allowed' : '';
    };
    const appendRow = (row) => {
      const rowEl = el('label', { class: 'tprm-rc-row' });
      rowEl.setAttribute('data-id', row.id);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'luna-checkbox tprm-rc-cb';
      cb.checked = true;
      const body = el('span', { class: 'tprm-rc-body' });
      body.innerHTML = `<a class="tprm-sc-id" href="#" onclick="return false">#${escapeHtml(row.id || '')}</a> <span class="tprm-sc-text">${escapeHtml(row.text || '')}</span>`;
      cb.addEventListener('change', () => {
        if (cb.checked) selection.add(row.id);
        else selection.delete(row.id);
        rowEl.classList.toggle('is-omitted', !cb.checked);
        setApplyLabel();
      });
      rowEl.appendChild(cb);
      rowEl.appendChild(body);
      listEl.appendChild(rowEl);
    };
    items.forEach(appendRow);
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        if (moreBtn.disabled) return;
        moreItems.forEach((row) => {
          if (!selection.has(row.id)) selection.add(row.id);
          appendRow(row);
        });
        moreBtn.disabled = true;
        setApplyLabel();
      });
    }
    const dismissBtn = lunaButton(m.dismissLabel || 'Dismiss', {
      variant: 'white', size: 'sm',
      onClick: () => {
        foot.remove();
        card.appendChild(el('div', { class: 'tprm-se-dismissed', text: 'Suggestion dismissed.' }));
      },
    });
    const applyBtn = lunaButton('Apply', {
      variant: 'blue', size: 'sm',
      onClick: () => {
        const pool = items.concat(moreItems);
        const selected = pool.filter((r) => selection.has(r.id));
        if (!selected.length) return;
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: 'optro-apply-suggested-connection',
              field: (m.field || 'controls').toLowerCase(),
              add: selected.map((r) => ({ id: r.id, text: r.text })),
            }, '*');
          }
        } catch (e) { /* cross-origin — no-op */ }
        // Post-apply list cleanup — the card collapses to just the
        // controls that were mapped. Rows the reviewer deselected are
        // removed entirely; checkboxes on the kept rows disappear so
        // the list reads as a settled record instead of an editable form.
        const rowEls = Array.from(listEl.querySelectorAll('.tprm-rc-row'));
        rowEls.forEach((rowEl) => {
          const id = rowEl.getAttribute('data-id');
          if (!id) return;
          if (!selection.has(id)) {
            rowEl.remove();
          } else {
            const cb = rowEl.querySelector('.tprm-rc-cb');
            if (cb) cb.remove();
          }
        });
        // "More" affordance is no longer meaningful once applied.
        if (moreBtn && moreBtn.parentNode) moreBtn.remove();
        foot.remove();
        const template = m.appliedText || `Applied · {N} control${selected.length === 1 ? '' : 's'} mapped to the vendor profile.`;
        card.appendChild(el('div', {
          class: 'tprm-se-applied',
          text: template.replace('{N}', String(selected.length)),
        }));
      },
    });
    applyBtn.classList.add('tprm-rc-apply');
    setApplyLabel();
    foot.appendChild(dismissBtn);
    foot.appendChild(applyBtn);
    w.appendChild(card);
    return w;
  };

  // suggested-field-update — simpler variant of suggested-edit for
  // single-select profile fields (Data classification, Vendor scope,
  // Business impact, AI usage, Business owner, etc.). Shows a
  // Current → New value diff and posts an apply message to the parent.
  //   Schema:
  //     { kind: 'suggested-field-update', field: '<state key>',
  //       fieldLabel: 'Data classification',
  //       currentValue: 'Internal', newValue: 'Confidential',
  //       appliedText?: '…' }
  Renderers['suggested-field-update'] = (m) => {
    ensureSuggestedEditStyles();
    const curStr = String(m.currentValue == null ? '—' : m.currentValue);
    const newStr = String(m.newValue == null ? '—' : m.newValue);
    // Separate view — Current / New sections stacked (the pre-toggle
    // treatment). Kept as the secondary view users can switch back to.
    const buildSeparateBody = () => `
      <div class="tprm-se-field">${escapeHtml(m.fieldLabel || m.field || 'field')}</div>
      <div class="tprm-se-section">
        <div class="tprm-se-label">Current</div>
        <div class="tprm-se-current">${escapeHtml(curStr)}</div>
      </div>
      <div class="tprm-se-section">
        <div class="tprm-se-label">New</div>
        <div class="tprm-se-suggested"><span class="tprm-se-add">${escapeHtml(newStr)}</span></div>
      </div>
    `;
    // Combined view — single block: strikethrough current + bold new,
    // matching the suggested-edit combined pattern. Direct edits are
    // the reviewer's own action (not a Suggested rewrite), so we drop
    // the "Suggested" sub-label — the card's eyebrow already tells the
    // full story.
    const buildCombinedBody = () => `
      <div class="tprm-se-field">${escapeHtml(m.fieldLabel || m.field || 'field')}</div>
      <div class="tprm-se-section">
        <div class="tprm-se-suggested"><span class="tprm-se-strike">${escapeHtml(curStr)}</span> <span class="tprm-se-add">${escapeHtml(newStr)}</span></div>
      </div>
    `;
    const w = el('div');
    const card = el('div', { class: 'tprm-suggested-edit' });
    card.innerHTML = `
      <div class="tprm-se-eyebrow">
        <span class="tprm-se-eyebrow-label">Field Edit</span>
        <span class="tprm-se-dot-menu-wrap">
          <button type="button" class="tprm-se-dot-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="More options">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>
          </button>
          <div class="tprm-se-dot-menu" role="menu" hidden>
            <button type="button" class="tprm-se-dot-menu-item" data-tprm-se-toggle-mode role="menuitem">Separate edits</button>
          </div>
        </span>
      </div>
      <div class="tprm-se-body"></div>
      <div class="tprm-se-foot"></div>
    `;
    const body = card.querySelector('.tprm-se-body');
    // Combined-first default — matches the suggested-edit toggle
    // convention. Toggle flips the same in-place body swap; no card
    // remount so applying/dismissing stays smooth.
    let combined = true;
    const applyBody = () => { body.innerHTML = combined ? buildCombinedBody() : buildSeparateBody(); };
    applyBody();
    const menuBtn = card.querySelector('.tprm-se-dot-menu-btn');
    const menuEl = card.querySelector('.tprm-se-dot-menu');
    const menuItem = card.querySelector('[data-tprm-se-toggle-mode]');
    const closeMenu = () => { menuEl.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
    const openMenu = () => { menuEl.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); };
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (menuEl.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener('click', (ev) => {
      if (menuEl.hidden) return;
      if (!card.contains(ev.target)) closeMenu();
    });
    menuItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      combined = !combined;
      menuItem.textContent = combined ? 'Separate edits' : 'Combine edits';
      applyBody();
      closeMenu();
    });
    const foot = card.querySelector('.tprm-se-foot');
    const dismissBtn = lunaButton(m.dismissLabel || 'Dismiss', {
      variant: 'white', size: 'sm',
      onClick: () => {
        foot.remove();
        card.appendChild(el('div', { class: 'tprm-se-dismissed', text: 'Suggestion dismissed.' }));
      },
    });
    const applyBtn = lunaButton(m.applyLabel || 'Apply', {
      variant: 'blue', size: 'sm',
      onClick: () => {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: 'optro-apply-suggested-field-update',
              field: m.field,
              value: m.newValue,
            }, '*');
          }
        } catch (e) { /* cross-origin — no-op */ }
        foot.remove();
        const applied = m.appliedText || `Applied · ${m.fieldLabel || m.field} set to ${m.newValue}.`;
        card.appendChild(el('div', { class: 'tprm-se-applied', text: applied }));
      },
    });
    foot.appendChild(dismissBtn);
    foot.appendChild(applyBtn);
    w.appendChild(card);
    return w;
  };

  // create-report-card — confirm/dismiss card for generating a new
  // report from the assistant. Reuses the suggested-edit visual
  // language (eyebrow + body + foot) so it reads as part of the
  // same tool family. On confirm, posts `optro-create-report-from-
  // assistant` to the parent; parent appends to generatedReports
  // and (if not already on the Reports tab for Acme) navigates
  // there.
  //   Schema:
  //     { kind: 'create-report-card',
  //       templateId: 'third-party-risk-report' | ...,
  //       templateLabel: 'Executive Summary Report',
  //       lens: 'executive-summary' | 'risk-summary',
  //       lensLabel: 'Executive summary lens' | 'Risk summary lens',
  //       description: 'One-line summary of what will be created' }
  Renderers['create-report-card'] = (m) => {
    ensureSuggestedEditStyles();
    const w = el('div');
    const card = el('div', { class: 'tprm-suggested-edit' });
    card.innerHTML = `
      <div class="tprm-se-eyebrow">
        <span class="tprm-se-eyebrow-label">Create Report</span>
      </div>
      <div class="tprm-se-body">
        <div class="tprm-se-field">${escapeHtml(m.templateLabel || 'New report')}</div>
        <div class="tprm-se-section">
          <div class="tprm-se-label">Lens</div>
          <div class="tprm-se-suggested"><span class="tprm-se-add">${escapeHtml(m.lensLabel || m.lens || 'Executive summary')}</span></div>
        </div>
        ${m.description ? `<div class="tprm-se-section">
          <div class="tprm-se-label">Summary</div>
          <div style="font-size:0.8125rem;color:#334155;line-height:1.5">${escapeHtml(m.description)}</div>
        </div>` : ''}
      </div>
      <div class="tprm-se-foot"></div>
    `;
    const foot = card.querySelector('.tprm-se-foot');
    const dismissBtn = lunaButton(m.dismissLabel || 'Dismiss', {
      variant: 'white', size: 'sm',
      onClick: () => {
        foot.remove();
        card.appendChild(el('div', { class: 'tprm-se-dismissed', text: 'Report creation cancelled.' }));
      },
    });
    const applyBtn = lunaButton(m.applyLabel || 'Create report', {
      variant: 'blue', size: 'sm',
      onClick: () => {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: 'optro-create-report-from-assistant',
              templateId: m.templateId || 'third-party-risk-report',
              templateLabel: m.templateLabel || 'New Report',
              lens: m.lens || null,
            }, '*');
          }
        } catch (e) {}
        foot.remove();
        card.appendChild(el('div', {
          class: 'tprm-se-applied',
          text: `Applied · ${m.templateLabel || 'Report'} created and opened in the Reports tab.`,
        }));
      },
    });
    foot.appendChild(dismissBtn);
    foot.appendChild(applyBtn);
    w.appendChild(card);
    return w;
  };

  // edit-report-section-card — confirm/dismiss card for previewing an
  // edit to a specific section of the vendor risk report. On confirm,
  // posts `optro-preview-report-edit` to the parent; parent opens
  // the fullscreen report viewer with the edit staged, and a
  // confirm/discard bar overlays the viewer so the reviewer sees
  // the change in the document context before committing.
  //   Schema:
  //     { kind: 'edit-report-section-card',
  //       section: 'executive-summary' | 'recommendations' | 'findings' | ...,
  //       sectionLabel: 'Executive Summary',
  //       currentPreview: 'One-line current-content preview',
  //       newContent: 'Full replacement paragraph text' }
  Renderers['edit-report-section-card'] = (m) => {
    ensureSuggestedEditStyles();
    const w = el('div');
    const card = el('div', { class: 'tprm-suggested-edit' });
    card.innerHTML = `
      <div class="tprm-se-eyebrow">
        <span class="tprm-se-eyebrow-label">Report Edit</span>
      </div>
      <div class="tprm-se-body">
        <div class="tprm-se-field">${escapeHtml(m.sectionLabel || 'Report section')}</div>
        <div class="tprm-se-section">
          <div class="tprm-se-suggested">
            ${m.currentPreview ? `<span class="tprm-se-strike">${escapeHtml(m.currentPreview)}</span> ` : ''}<span class="tprm-se-add">${escapeHtml(m.newContent || '')}</span>
          </div>
        </div>
      </div>
      <div class="tprm-se-foot"></div>
    `;
    const foot = card.querySelector('.tprm-se-foot');
    const dismissBtn = lunaButton(m.dismissLabel || 'Dismiss', {
      variant: 'white', size: 'sm',
      onClick: () => {
        foot.remove();
        card.appendChild(el('div', { class: 'tprm-se-dismissed', text: 'Edit dismissed.' }));
      },
    });
    const applyBtn = lunaButton(m.applyLabel || 'Preview in report', {
      variant: 'blue', size: 'sm',
      onClick: () => {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: 'optro-preview-report-edit',
              section: m.section || 'executive-summary',
              sectionLabel: m.sectionLabel || 'Section',
              newContent: m.newContent || '',
            }, '*');
          }
        } catch (e) {}
        foot.remove();
        card.appendChild(el('div', {
          class: 'tprm-se-applied',
          text: 'Opened preview in the fullscreen report — confirm or discard from the bar there.',
        }));
      },
    });
    foot.appendChild(dismissBtn);
    foot.appendChild(applyBtn);
    w.appendChild(card);
    return w;
  };

  // Field-update parser — catches "Update [FIELD] to [INPUT]" phrasings
  // in the freetext send flow and emits a suggested-field-update card.
  // Registry lists each supported field, its state key on the parent,
  // and the allowed single-select values (used for fuzzy value match).
  const FIELD_UPDATE_REGISTRY = [
    { key: 'dataClassification', label: 'Data classification', aliases: ['data classification', 'classification'], values: ['Public', 'Internal', 'Confidential', 'Restricted'], current: 'Internal' },
    { key: 'vendorScope',        label: 'Vendor scope',        aliases: ['vendor scope', 'geo scope', 'geographic scope', 'scope'], values: ['US only', 'US + EU', 'Global'], current: 'US + EU' },
    { key: 'businessImpact',     label: 'Business impact',     aliases: ['business impact', 'impact'], values: ['Low', 'Medium', 'High', 'Critical'], current: 'Medium' },
    { key: 'aiUsage',            label: 'AI usage',            aliases: ['ai usage', 'ai use', 'ai posture'], values: ['None', 'Ingests our data', 'Model provider', 'Full AI pipeline'], current: 'None' },
    { key: 'businessOwner',      label: 'Business owner',      aliases: ['business owner', 'internal owner', 'owner'], values: null /* free text */, current: 'Jorge Rivera' },
    // Direct description overwrite — same current/new card as the
    // single-select fields, NOT the diff-based suggested-edit. Users
    // asking to "update description to <prose>" get this literal
    // overwrite; users asking to "suggest a description update"
    // still route to the diff-based `suggest-description-update` script.
    { key: 'description',        label: 'Description',         aliases: ['description', 'vendor description', "acme's description"], values: null, current: "Acme Cloud Co. is a managed data analytics and observability platform that ingests application and infrastructure telemetry across the company's production environments." },
  ];

  function parseFieldUpdate(text) {
    if (!text) return null;
    // Accept "update", "set", or "change". Also tolerate "the" and
    // possessive forms ("acme's business impact"). Split on " to ".
    const m = /^\s*(?:can you\s+)?(?:please\s+)?(?:update|edit|set|change)\s+(?:the\s+|acme's\s+|the\s+acme\s+|acme\s+)?(.+?)\s+to\s+(.+?)\s*[.?!]?\s*$/i.exec(text);
    if (!m) return null;
    const rawField = m[1].trim().toLowerCase();
    const rawValue = m[2].trim();
    // Match field by longest alias substring so "vendor scope" beats "scope".
    let best = null;
    let bestLen = 0;
    FIELD_UPDATE_REGISTRY.forEach((f) => {
      f.aliases.forEach((a) => {
        if (rawField.includes(a) && a.length > bestLen) { best = f; bestLen = a.length; }
      });
    });
    if (!best) return null;
    let matchedValue = rawValue;
    if (best.values) {
      // Case-insensitive exact match first, then prefix-startsWith.
      const v = best.values.find((x) => x.toLowerCase() === rawValue.toLowerCase())
             || best.values.find((x) => x.toLowerCase().startsWith(rawValue.toLowerCase()))
             || best.values.find((x) => rawValue.toLowerCase().startsWith(x.toLowerCase()));
      if (!v) return null;
      matchedValue = v;
    }
    return { field: best, value: matchedValue };
  }

  Renderers['suggested-edit'] = (m) => {
    ensureSuggestedEditStyles();
    const currentSegs = Array.isArray(m.current) ? m.current : [];
    const suggestedSegs = Array.isArray(m.suggested) ? m.suggested : [];
    // Separate view — Current + Suggested side by side.
    const buildSeparateBody = () => {
      const currentHtml = currentSegs.map((s) => {
        const t = escapeHtml(s.text || '');
        return s.removed ? `<span class="tprm-se-strike">${t}</span>` : t;
      }).join('');
      const suggestedHtml = suggestedSegs.map((s) => {
        const t = escapeHtml(s.text || '');
        return s.added ? `<span class="tprm-se-add">${t}</span>` : t;
      }).join('');
      return `
        <div class="tprm-se-field">${escapeHtml(m.field || 'field')}</div>
        <div class="tprm-se-section">
          <div class="tprm-se-label">Current</div>
          <div class="tprm-se-current">${currentHtml}</div>
        </div>
        <div class="tprm-se-section">
          <div class="tprm-se-label">Suggested</div>
          <div class="tprm-se-suggested">${suggestedHtml}</div>
        </div>
      `;
    };
    // Combined view — one interleaved block. Walk `suggested` as the
    // primary flow and, at each `added` span, splice the next unconsumed
    // `removed` span from `current` in front of it (strikethrough), then
    // emit the added span (bold). Any trailing `removed` spans flush at
    // the end so nothing is dropped.
    const buildCombinedBody = () => {
      const removedQueue = currentSegs.filter((s) => s.removed);
      let ri = 0;
      const parts = [];
      suggestedSegs.forEach((s) => {
        const t = escapeHtml(s.text || '');
        if (s.added) {
          if (ri < removedQueue.length) {
            parts.push(`<span class="tprm-se-strike">${escapeHtml(removedQueue[ri].text || '')}</span>`);
            ri++;
          }
          parts.push(`<span class="tprm-se-add">${t}</span>`);
        } else {
          parts.push(t);
        }
      });
      while (ri < removedQueue.length) {
        parts.push(`<span class="tprm-se-strike">${escapeHtml(removedQueue[ri].text || '')}</span>`);
        ri++;
      }
      return `
        <div class="tprm-se-field">${escapeHtml(m.field || 'field')}</div>
        <div class="tprm-se-section">
          <div class="tprm-se-suggested">${parts.join('')}</div>
        </div>
      `;
    };
    const w = el('div');
    const card = el('div', { class: 'tprm-suggested-edit' });
    card.innerHTML = `
      <div class="tprm-se-eyebrow">
        <span class="tprm-se-eyebrow-label">Suggested Edit</span>
        <span class="tprm-se-dot-menu-wrap">
          <button type="button" class="tprm-se-dot-menu-btn" aria-haspopup="menu" aria-expanded="false" aria-label="More options">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>
          </button>
          <div class="tprm-se-dot-menu" role="menu" hidden>
            <button type="button" class="tprm-se-dot-menu-item" data-tprm-se-toggle-mode role="menuitem">Separate edits</button>
          </div>
        </span>
      </div>
      <div class="tprm-se-body"></div>
      <div class="tprm-se-foot"></div>
    `;
    // Body content — hot-swap between separate and combined without
    // remounting the card so the toggle reads as a seamless change.
    const body = card.querySelector('.tprm-se-body');
    let combined = true;
    const applyBody = () => {
      body.innerHTML = combined ? buildCombinedBody() : buildSeparateBody();
    };
    applyBody();
    // Dot-menu wiring — toggle open/closed on button click, close on
    // outside click, and swap the menu-item label after each mode flip.
    const menuBtn = card.querySelector('.tprm-se-dot-menu-btn');
    const menuEl = card.querySelector('.tprm-se-dot-menu');
    const menuItem = card.querySelector('[data-tprm-se-toggle-mode]');
    const closeMenu = () => { menuEl.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
    const openMenu = () => { menuEl.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); };
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (menuEl.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener('click', (ev) => {
      if (menuEl.hidden) return;
      if (!card.contains(ev.target)) closeMenu();
    });
    menuItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      combined = !combined;
      menuItem.textContent = combined ? 'Separate edits' : 'Combine edits';
      applyBody();
      closeMenu();
    });
    const foot = card.querySelector('.tprm-se-foot');
    const dismissBtn = lunaButton(m.dismissLabel || 'Dismiss', {
      variant: 'white', size: 'sm',
      onClick: () => {
        foot.remove();
        const note = el('div', { class: 'tprm-se-dismissed', text: 'Suggestion dismissed.' });
        card.appendChild(note);
      },
    });
    const applyBtn = lunaButton(m.applyLabel || 'Apply', {
      variant: 'blue', size: 'sm',
      onClick: () => {
        // Compose the plain-text version of the Suggested block (segments
        // concatenated in order) and post it to the parent so the Profile
        // page can write it back into state — the field label is the same
        // key the parent's postMessage bridge switches on.
        const plainSuggested = suggestedSegs.map((s) => s.text || '').join('');
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              type: 'optro-apply-suggested-edit',
              field: (m.field || '').toLowerCase(),
              value: plainSuggested,
            }, '*');
          }
        } catch (e) { /* cross-origin — no-op */ }
        foot.remove();
        const note = el('div', {
          class: 'tprm-se-applied',
          text: m.appliedText || 'Applied · Description updated on the vendor profile.',
        });
        card.appendChild(note);
      },
    });
    foot.appendChild(dismissBtn);
    foot.appendChild(applyBtn);
    w.appendChild(card);
    return w;
  };

  // Rewrites the suggest-control-connection / -disconnection scripts so
  // the emitted block reflects EVERY Control the reviewer has chipped as
  // additional context. `mode` picks add-vs-remove copy + payload shape.
  function withChippedControl(player, script, mode) {
    const chips = (player && player.chips) || [];
    const controlChips = chips.slice(1).filter((c) => c && (c.type === 'Control'
      || /^COR\.[A-Z]{2}\.[A-Z]{2}\.C\d+$/i.test(String(c.id || c.name || ''))));
    if (!controlChips.length) return script;
    const refBlock = (player.manifest.referenceEntities || []).find((r) => r.type === 'Control');
    const refItems = (refBlock && refBlock.items) || [];
    const items = controlChips.map((cc) => {
      const rec = refItems.find((it) => it.id === cc.id);
      return {
        id: cc.id || cc.name,
        text: (rec && rec.meta) || cc.name || cc.title || '',
      };
    });
    const n = items.length;
    const isPlural = n > 1;
    const isRemove = mode === 'remove';
    return script.map((b) => {
      if (!b || !b.kind) return b;
      if (b.kind === 'user') {
        return Object.assign({}, b, {
          text: isRemove
            ? (isPlural ? 'Remove these controls' : 'Remove this control')
            : (isPlural ? 'Map/connect this vendor and controls'
                        : 'Map/connect this vendor and control'),
        });
      }
      if (b.kind === 'assistant') {
        let text;
        if (isRemove) {
          text = isPlural
            ? `Here are the ${n} controls I'll unmap. Applying will remove them from the Controls row on the Acme Cloud Co. profile.`
            : `Here's the control I'll unmap. Applying will remove it from the Controls row on the Acme Cloud Co. profile.`;
        } else {
          text = isPlural
            ? `Here are the ${n} connections I'm proposing. Applying will map these controls to the vendor and add them to the Controls row on the Acme Cloud Co. profile.`
            : `Here's the connection I'm proposing. Applying will map the control to the vendor and add it to the Controls row on the Acme Cloud Co. profile.`;
        }
        return Object.assign({}, b, { text });
      }
      if (b.kind === 'suggested-connection') {
        const patch = { items };
        if (isRemove) {
          patch.mode = 'remove';
          patch.appliedText = isPlural
            ? `Removed · ${n} controls unmapped from the vendor profile.`
            : 'Removed · Control unmapped from the vendor profile.';
        } else {
          patch.mode = 'add';
          patch.appliedText = isPlural
            ? `Applied · ${n} controls mapped to the vendor profile.`
            : 'Applied · Control mapped to the vendor profile.';
        }
        return Object.assign({}, b, patch);
      }
      return b;
    });
  }

  // ─────────────────────────────────────────────────────────
  // Player — walks a script from the manifest with realistic timing.
  // ─────────────────────────────────────────────────────────
  class Player {
    constructor(manifest, chatPanel) {
      this.manifest = manifest;
      this.chatPanel = chatPanel;
      this.timers = [];
      this.messageList = null;
      this.container = null;
    }

    ensureMessageList() {
      // Locate the messages area. On first entry we may find the bundle's
      // empty-state UI (sparkle + hero + suggestion pills). We hide it
      // rather than nuke it so the pills stay in the DOM — the Reset
      // conversation flow can then un-hide them without needing to
      // re-create the empty-state from scratch.
      this.container = this.chatPanel.querySelector('._messages_1vvl1_194');
      if (!this.container) return null;
      // Track the empty-state wrapper (only exists when bundle has no messages).
      if (!this._emptyStateEl) {
        // The empty state's outer wrapper isn't uniquely classed; identify
        // it as any direct child of _messages_ that ISN'T our list.
        const children = Array.from(this.container.children).filter(
          (c) => !c.hasAttribute('data-tprm-owned')
        );
        // Save the first non-owned child as the empty-state root.
        if (children.length) this._emptyStateEl = children[0];
      }
      if (this._emptyStateEl && this._emptyStateEl.style.display !== 'none') {
        this._emptyStateEl.style.display = 'none';
      }
      // (Re-)get our owned list.
      let list = this.container.querySelector('[data-tprm-owned="true"]');
      if (!list) {
        list = el('div', {
          class: '_YStack_dia70_1 _messageList_1vvl1_201',
          attrs: { 'data-spacing': 'lg', 'data-tprm-owned': 'true' },
        });
        this.container.appendChild(list);
      }
      this.messageList = list;
      return list;
    }

    /**
     * Tear down our injected chat and restore the bundle's original empty
     * state. Called when the user clicks Reset conversation in the chat
     * header, or when the runtime otherwise wants a clean slate.
     */
    resetToEmptyState() {
      this.stop();
      const owned = this.container?.querySelector('[data-tprm-owned="true"]');
      if (owned) owned.remove();
      if (this._emptyStateEl) {
        this._emptyStateEl.style.display = '';
      }
      this.messageList = null;
    }

    /**
     * Instantly render a curated conversation thread into the chat —
     * used by the fullscreen-tab history sidebar to open a "past
     * conversation" without the scripted-play typing delays.
     */
    loadThreadInstant(steps) {
      if (!Array.isArray(steps) || !steps.length) return;
      this.stop();
      const list = this.ensureMessageList();
      if (!list) return;
      list.setAttribute('data-tprm-script-id', 'history-thread');
      list.setAttribute('data-tprm-script-length', String(steps.length));
      list.innerHTML = '';
      // Hide the bundle's empty-state pills once a thread is loaded.
      if (this._emptyStateEl) this._emptyStateEl.style.display = 'none';
      steps.forEach((msg) => this.emit(msg));
    }

    stop() {
      this.timers.forEach((t) => clearTimeout(t));
      this.timers = [];
    }

    defaultDelay(msg) {
      if (typeof msg.gapMs === 'number') return msg.gapMs;
      if (msg.kind === 'user' || msg.kind === 'queued-user') return 220;
      if (msg.kind === 'commentary') return 480;
      if (msg.kind === 'assistant') {
        const chars = (msg.text || '').length;
        return Math.min(1800, 500 + chars * 5);
      }
      return 700;
    }

    /** Walk a script by id. If `append` is true, keep existing messages. */
    play(scriptId, options) {
      options = options || {};
      const script = this.manifest.chatScripts && this.manifest.chatScripts[scriptId];
      if (!Array.isArray(script)) return;
      this.stop();
      const list = this.ensureMessageList();
      if (!list) return;
      list.setAttribute('data-tprm-script-id', scriptId);
      list.setAttribute('data-tprm-script-length', String(script.length));
      if (!options.append) list.innerHTML = '';
      let elapsed = 0;
      script.forEach((msg, i) => {
        const delay = i === 0 ? 60 : this.defaultDelay(script[i - 1]);
        elapsed += delay;
        const t = setTimeout(() => this.emit(msg), elapsed);
        this.timers.push(t);
      });
    }

    emit(msg) {
      const list = this.messageList;
      if (!list) return;
      const renderer = Renderers[msg.kind];
      let node;
      if (!renderer) {
        node = el('div');
        node.innerHTML = `<div class="_commentary_1vvl1_335"><em>[unrenderered kind: ${msg.kind}]</em></div>`;
      } else {
        node = renderer(msg, { player: this });
      }
      if (node) {
        // Stamp so the bundle-append guard knows this is ours and leaves it alone.
        if (node.setAttribute) node.setAttribute('data-tprm-owned', '1');
        list.appendChild(node);
      }
      this.scrollToBottom();
    }

    scrollToBottom() {
      const scroller = this.container?.parentElement?.querySelector('[data-scroll]') || this.container;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
  }

  // ─────────────────────────────────────────────────────────
  // Interception — capture-phase click on suggestion pills.
  // Prevents the bundle's onClick from firing (which would play the
  // bundle's hardcoded script) and routes to the manifest-driven player.
  // ─────────────────────────────────────────────────────────
  /**
   * Swap the empty-state pill labels + icons to match the active manifest.
   * The bundle renders four suggestion pills in a stable order; we
   * replace their text/icon with `manifest.quickActions[i]`. Idempotent
   * via a `data-tprm-label` attribute check.
   */
  /**
   * Which quick-action pills should be visible right now? When there's
   * an active context entity AND the manifest defines a matching
   * `contextQuickActions[entityId]` set, use that. Otherwise fall back
   * to the general `manifest.quickActions`.
   */
  function activeQuickActions(player) {
    const cxt = player.contextEntity;
    if (cxt && player.manifest.contextQuickActions?.[cxt.id]) {
      return player.manifest.contextQuickActions[cxt.id];
    }
    return player.manifest.quickActions || [];
  }

  /**
   * Resolve a script ID against the runtime's 3-dimensional context:
   * script × entity × lifecycle phase. Lookup order (most-specific
   * first):
   *   1. `{baseId}__{entityId}__{phase}` — full match
   *   2. `{baseId}__{entityId}`          — entity-scoped, phase-agnostic
   *   3. `{baseId}__{phase}`              — phase-scoped, entity-agnostic
   *   4. `{baseId}`                       — base
   * Called by every code path that plays a script — pill clicks,
   * freetext triggers, prompt-library plans, in-chat suggestion clicks —
   * so context routing stays consistent.
   */
  function resolveScriptId(player, baseId) {
    if (!baseId) return baseId;
    const chatScripts = player.manifest.chatScripts || {};
    const cxt = player.contextEntity;
    const phase = player.contextPhase;
    if (cxt && phase) {
      const k = `${baseId}__${cxt.id}__${phase}`;
      if (chatScripts[k]) return k;
    }
    if (cxt) {
      const k = `${baseId}__${cxt.id}`;
      if (chatScripts[k]) return k;
    }
    if (phase) {
      const k = `${baseId}__${phase}`;
      if (chatScripts[k]) return k;
    }
    return baseId;
  }

  function swapEmptyStatePills(player) {
    const list = player.chatPanel;
    if (!list) return false;
    const container = list.querySelector('._suggestions_1vvl1_226');
    if (!container) return false;
    const pills = container.querySelectorAll('._suggestion_1vvl1_226');
    if (!pills.length) return false;
    const actions = activeQuickActions(player);
    // Self-healing: re-swap if the pills don't match the currently-active
    // set. This also handles context flips (default ↔ Acme) since the
    // active set changes when contextEntity toggles.
    const alreadySwapped = container.getAttribute('data-tprm-swapped') === '1';
    let firstPillHasOurLabel = false;
    if (pills[0] && actions[0]) {
      firstPillHasOurLabel = pills[0].getAttribute('data-tprm-label') === actions[0].text;
    }
    if (alreadySwapped && firstPillHasOurLabel) return false;
    container.setAttribute('data-tprm-swapped', '1');
    pills.forEach((pill, i) => {
      const qa = actions[i];
      if (!qa) return;
      pill.setAttribute('data-tprm-label', qa.text);
      pill.innerHTML =
        `<svg class="_Icon_kum9n_5" width="14px" height="14px" role="presentation"><use href="#luna-${qa.icon}" xlink:href="#luna-${qa.icon}"></use></svg> ` +
        String(qa.text).replace(/</g, '&lt;');
    });
    return true;
  }

  /*
   * ═══════════════════════════════════════════════════════════════════
   *   TPRM manifest content swaps
   * ───────────────────────────────────────────────────────────────────
   * The bundle is a compiled React app — it owns the DOM inside the
   * chat panel and will re-render items on every state change. If we
   * naively poll and replace innerHTML, React overwrites our swap on
   * the next tick, producing a GRC/TPRM flicker.
   *
   * Approach:
   *   1. Inject a `<style>` gate that hides the bundle's native
   *      persona list / picker results / suggestion pills until we've
   *      marked their container with `data-tprm-swapped="1"`. This
   *      turns the flicker into a brief invisibility instead.
   *   2. Run a MutationObserver on the chat-panel subtree. On any
   *      mutation, check if any of our target containers has appeared
   *      (or been re-rendered) *without* the swap attribute, and if
   *      so, run the appropriate swap. Setting the attribute latches
   *      the container as done and prevents self-echo.
   *   3. Each swap function rewrites the container's children with
   *      HTML that mirrors the bundle's exact JSX (same class names,
   *      same nesting, same role/aria attributes) — so the item cards
   *      render identically to the native ones, just with TPRM data.
   * ═══════════════════════════════════════════════════════════════════
   */

  function injectPreHideStyle() {
    if (document.getElementById('tprm-runtime-gate-style')) return;
    const s = document.createElement('style');
    s.id = 'tprm-runtime-gate-style';
    s.textContent = `
      /* Pre-hide gates — invisible until swap latches an attribute. */
      ._personaMenu_1vvl1_97:not([data-tprm-swapped]) > *,
      ._picker_1vvl1_1869:not([data-tprm-swapped]) ._pickerResults_1vvl1_1902 > *,
      ._suggestions_1vvl1_226:not([data-tprm-swapped]) > * {
        visibility: hidden !important;
      }

      /* Sidecar / floating pill normalization — panel-mode empty state
         stacks the four suggestion pills vertically. Default bundle
         renders each pill at its own content width (ragged edges); a
         grid with a single max-content column sizes the column to the
         widest child and stretches every child to that width. */
      html:not([data-tprm-layout="fullscreen"]) ._suggestions_1vvl1_226[data-tprm-swapped] {
        display: grid !important;
        grid-template-columns: max-content;
        gap: 0.375rem;
        justify-content: center;
      }
      html:not([data-tprm-layout="fullscreen"]) ._suggestions_1vvl1_226[data-tprm-swapped] > ._suggestion_1vvl1_226 {
        width: 100% !important;
        justify-content: flex-start !important;
      }

      /* Fullscreen-tab landing gallery — replaces the small pill cluster
         with a tiled prompt gallery. Injected inside the bundle's
         empty-state wrapper so the show/hide already tied to the
         messages-empty state keeps working. */
      html[data-tprm-layout="fullscreen"] .tprm-fs-hide-native { display: none !important; }
      .tprm-fs-gallery {
        display: none;
        width: 100%;
        max-width: 880px;
        margin: 0 auto;
        padding: 3rem 1.5rem 2.5rem;
        box-sizing: border-box;
      }
      html[data-tprm-layout="fullscreen"] .tprm-fs-gallery { display: block; }
      .tprm-fs-gallery-hero {
        text-align: center;
        margin-bottom: 2rem;
      }
      .tprm-fs-gallery-hero-mark {
        display: inline-flex; align-items: center; justify-content: center;
        width: 44px; height: 44px; border-radius: 50%;
        background: #0f172a;
        color: #fff; margin-bottom: 0.75rem;
      }
      .tprm-fs-gallery-hero-mark svg {
        width: 22px; height: 22px;
      }
      .tprm-fs-gallery-hero-title {
        font-size: 1.5rem; font-weight: 600; color: #0f172a; letter-spacing: -0.01em;
        margin: 0 0 0.375rem;
      }
      .tprm-fs-gallery-hero-sub {
        font-size: 0.875rem; color: #78716c;
      }
      .tprm-fs-gallery-section {
        margin-top: 1.5rem;
      }
      .tprm-fs-gallery-section-label {
        font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em;
        text-transform: uppercase; color: #78716c;
        padding: 0 0.125rem 0.625rem;
      }
      .tprm-fs-gallery-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.625rem;
      }
      @media (max-width: 780px) {
        .tprm-fs-gallery-grid { grid-template-columns: 1fr; }
      }
      .tprm-fs-tile {
        display: flex; align-items: center; gap: 0.75rem;
        padding: 0.875rem 1rem; text-align: left;
        background: #ffffff; border: 1px solid #e7e5e4; border-radius: 10px;
        cursor: pointer; font: inherit; color: #0f172a;
        transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
        min-width: 0;
      }
      .tprm-fs-tile:hover {
        border-color: #d6d3d1;
        background: #fafaf9;
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.05);
      }
      .tprm-fs-tile-icon {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
        color: #fff;
      }
      .tprm-fs-tile .tprm-fs-tile-icon { background: #1f577a; }
      .tprm-fs-tile-body { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; }
      .tprm-fs-tile-title {
        font-size: 0.875rem; font-weight: 500; color: #0f172a;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .tprm-fs-tile-cat {
        font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em;
        text-transform: uppercase; color: #a8a29e;
      }

      /* Plan-card padding fix — the bundle's _planDescription and
         everything between the header and the steps list has no
         padding, so intro/outro text renders flush against the card's
         left/right borders in the narrow sidecar. Match the header's
         horizontal padding. */
      ._planCard_1vvl1_1127 > ._planIntroText_1vvl1_1072,
      ._planCard_1vvl1_1127 > ._planDescription_1vvl1_1081 {
        padding: 0.5rem 0.875rem;
      }

      /* Plan step rows — match the bundle's canonical "Saved plan"
         layout: horizontal rows separated by hairline dividers, no
         individual borders, no background. Supervised steps get an
         orange caption row below their title. */
      ._planSteps_1vvl1_1205 {
        padding: 0 !important;
      }
      ._planStep_1vvl1_1205 {
        padding: 0.75rem 1rem !important;
      }
      /* Visual break between the scrolling message list and the fixed
         input area: 1px light-gray top rule on the input area with a
         subtle upward shadow, so scrolled content clearly ends before
         the context pill + composer starts. */
      ._inputArea_1vvl1_1721 {
        border-top: 1px solid #e2e8f0;
        box-shadow: 0 -6px 12px -8px rgba(15, 23, 42, 0.08);
        background: #fff;
      }

      /* Persona trigger hover — bundle default is gray-100 background,
         which is white-on-white against our navy chat header. Match the
         header tone with a translucent white overlay + slightly stronger
         active-state background so hover reads clearly on the dark bg. */
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101:hover {
        background: rgba(255, 255, 255, 0.10) !important;
      }
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101:active,
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101[aria-expanded="true"] {
        background: rgba(255, 255, 255, 0.16) !important;
      }
      /* Persona switcher is currently hidden — the chevron + click affordance
         are suppressed so the header reads as a plain product name. Kept in
         the DOM (and menu code intact) so re-enabling it later is one CSS
         flip away. */
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101 {
        pointer-events: none;
      }
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101 svg,
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101 [class*="Icon"],
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101 [class*="chevron"] {
        display: none !important;
      }
      ._header_1vvl1_59 ._personaTrigger_1vvl1_101:hover {
        background: transparent !important;
      }
      /* Header icon buttons (× close, ⋯ more) use the same treatment
         so the whole header has a consistent hover feel. */
      ._header_1vvl1_59 button:hover {
        background: rgba(255, 255, 255, 0.10) !important;
      }

      /* Context chip — single line: icon | name | pin | ×. */
      ._contextChipIcon_1vvl1_x {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #64748b;
        flex-shrink: 0;
      }
      ._contextChipIcon_1vvl1_x svg {
        display: block;
      }
      /* Kill the old two-row layout — anything in the bottom row is
         legacy from earlier builds and no longer emitted. */
      ._contextChipBottom_1vvl1_1055 {
        display: none !important;
      }

      /* Inline supervised marker — small amber person icon BEFORE the
         title text, on the same line. Uses flex-row on the title
         container so icon + text baseline-align cleanly regardless of
         icon SVG intrinsic height. */
      ._planStepTitle_1vvl1_1260 {
        display: flex;
        align-items: center;
        gap: 0.375rem;
      }
      ._planSupervisedMark_1vvl1_x {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #b45309;
        flex-shrink: 0;
      }
      ._planSupervisedMark_1vvl1_x svg {
        display: block;
      }
      ._planStepTitleText_1vvl1_x {
        flex: 1 1 auto;
        min-width: 0;
      }
      /* Zero out the bundle's legacy badge/caption styles so any stale
         DOM (e.g., before this refactor) doesn't leak visible pills. */
      ._planSupervisedBadge_1vvl1_1329,
      ._planSupervisedCaption_1vvl1_1345 {
        display: none !important;
      }
      ._planStepKebab_1vvl1_1321 {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #64748b;
        opacity: 0.7;
      }

      /* Chart canvas — the bundle sets a fixed 280px height for its
         Chart.js library rendering. Our inline-SVG bars use natural
         aspect ratio, leaving the rest as empty whitespace. Collapse
         to fit-content with a small floor so charts with just a few
         data points don't over-stretch the card. */
      ._chartCanvas_1vvl1_734 {
        height: auto !important;
        min-height: 90px;
        max-height: 200px;
        padding: 0.5rem 0.75rem;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      ._chartCanvas_1vvl1_734 > svg {
        width: 100%;
        max-height: 180px;
        display: block;
      }
    `;
    document.head.appendChild(s);
  }

  function attachContentSwaps(player) {
    injectPreHideStyle();
    runAllSwaps(player);
    // MutationObserver on the chat panel — everything we care about
    // (personas, pickers, pills) renders inside it. Debounce via rAF so
    // mutation floods coalesce into one swap-check per frame.
    let scheduled = false;
    const scheduleSwaps = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        runAllSwaps(player);
      });
    };
    const observer = new MutationObserver(scheduleSwaps);
    observer.observe(player.chatPanel, { childList: true, subtree: true });
  }

  // Each individual swap is a guarded no-op unless there's actual work
  // to do, so calling them all on every mutation stays cheap. `try`
  // fences prevent one broken swap from disabling the others.
  function runAllSwaps(player) {
    try { swapEmptyStatePills(player); } catch(e) {}
    try { swapFullscreenGallery(player); } catch(e) {}
    try { swapPersonaMenu(player); } catch(e) {}
    try { swapPromptLibrary(player); } catch(e) {}
    try { swapEntityPicker(player); } catch(e) {}
    try { swapPersonaTriggerLabel(player); } catch(e) {}
  }

  // Tiled prompt gallery — replaces the four-pill empty-state cluster
  // when the assistant is running in the fullscreen-tab layout. Sits
  // inside the bundle's `_emptyStateEl` container so it inherits the
  // same show/hide lifecycle: visible when the message list is empty,
  // hidden as soon as a script or thread renders content. Idempotent.
  const FS_GALLERY_TILES = [
    { cat: 'tprm', text: "Reclassify Acme's tier",                                    scriptId: 'reclassify-vendor',        icon: 'shield-check' },
    { cat: 'tprm', text: "Summarize contract deltas since last renewal",              scriptId: 'contract-deltas',          icon: 'file-earmark-text' },
    { cat: 'tprm', text: "Recommend controls to link to Acme",                        scriptId: 'recommend-controls',       icon: 'diagram-3' },
    { cat: 'tprm', text: "Rewrite the vendor description",                            scriptId: 'suggest-description-update', icon: 'pencil-square' },
    { cat: 'grc',  text: "Draft a control for this module",                           scriptId: null,                       icon: 'shield-lock' },
    { cat: 'grc',  text: "Summarize recent audit findings",                           scriptId: null,                       icon: 'clipboard-check' },
    { cat: 'grc',  text: "Help me write a risk description",                          scriptId: null,                       icon: 'exclamation-triangle' },
    { cat: 'grc',  text: "Triage open issues by severity",                            scriptId: null,                       icon: 'list-check' },
  ];
  const FS_TILE_ICONS = {
    'shield-check':        '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5 2.5 3.5V8c0 3 2.4 5.6 5.5 6.5 3.1-.9 5.5-3.5 5.5-6.5V3.5z"/><path d="M5.5 8.2l1.6 1.6L10.5 6"/></svg>',
    'file-earmark-text':   '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5z"/><path d="M9 1.5V5.5H13"/><path d="M5.5 8.5h5M5.5 11h5"/></svg>',
    'diagram-3':           '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="1.5" width="4" height="3" rx="0.5"/><rect x="1.5" y="10.5" width="4" height="3" rx="0.5"/><rect x="10.5" y="10.5" width="4" height="3" rx="0.5"/><path d="M8 4.5v3M3.5 10.5v-2h9v2"/></svg>',
    'pencil-square':       '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h6"/><path d="M11 2l3 3-6.5 6.5H4.5V8z"/></svg>',
    'shield-lock':         '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5 2.5 3.5V8c0 3 2.4 5.6 5.5 6.5 3.1-.9 5.5-3.5 5.5-6.5V3.5z"/><rect x="6" y="7.5" width="4" height="3.5" rx="0.5"/><path d="M6.5 7.5V6a1.5 1.5 0 0 1 3 0v1.5"/></svg>',
    'clipboard-check':     '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2.5" width="10" height="12" rx="1"/><path d="M6 2.5h4v2H6z"/><path d="M5.5 9l1.6 1.6L10.5 7"/></svg>',
    'exclamation-triangle':'<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2 1.5 13.5h13z"/><path d="M8 6v3.5"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor"/></svg>',
    'list-check':          '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 4h7M6.5 8h7M6.5 12h7"/><path d="M2 3.5l1.5 1.5L5 3.5M2 7.5L3.5 9 5 7.5M2 11.5L3.5 13 5 11.5"/></svg>',
  };

  function swapFullscreenGallery(player) {
    if (document.documentElement.getAttribute('data-tprm-layout') !== 'fullscreen') return false;
    // Locate the empty-state wrapper directly — `player._emptyStateEl`
    // only gets populated inside `ensureMessageList()`, which fires on
    // the first play()/emit() call. On initial mount (the very case this
    // gallery targets), that reference is still null. The bundle's
    // empty state is the first non-owned child of `_messages_1vvl1_194`.
    const container = player.chatPanel && player.chatPanel.querySelector('._messages_1vvl1_194');
    if (!container) return false;
    const emptyEl = Array.from(container.children).filter((c) => !c.hasAttribute('data-tprm-owned'))[0];
    if (!emptyEl) return false;
    if (emptyEl.getAttribute('data-tprm-fs-gallery') === '1') return true;
    // Ensure the empty state isn't hidden — ensureMessageList() drops
    // display:none on it even before any message renders. Force it back
    // to visible so the gallery paints on first mount.
    if (emptyEl.style.display === 'none') emptyEl.style.display = '';
    // Keep the shared reference in sync so reset flows continue to work.
    player._emptyStateEl = emptyEl;
    // Hide bundle-native empty-state children in place; append our gallery.
    Array.from(emptyEl.children).forEach((c) => c.classList.add('tprm-fs-hide-native'));
    const gallery = document.createElement('div');
    gallery.className = 'tprm-fs-gallery';
    const tprm = FS_GALLERY_TILES.filter((t) => t.cat === 'tprm');
    const grc  = FS_GALLERY_TILES.filter((t) => t.cat === 'grc');
    const tileHtml = (t) => `
      <button type="button" class="tprm-fs-tile" data-cat="${t.cat}" data-tprm-fs-tile="1" data-script-id="${t.scriptId || ''}" data-text="${escapeHtml(t.text)}">
        <span class="tprm-fs-tile-icon">${FS_TILE_ICONS[t.icon] || FS_TILE_ICONS['pencil-square']}</span>
        <span class="tprm-fs-tile-body">
          <span class="tprm-fs-tile-title">${escapeHtml(t.text)}</span>
          <span class="tprm-fs-tile-cat">${t.cat === 'tprm' ? 'TPRM' : 'GRC'}</span>
        </span>
      </button>`;
    gallery.innerHTML = `
      <div class="tprm-fs-gallery-hero">
        <div class="tprm-fs-gallery-hero-mark">${icon('ab-assistant', 22)}</div>
        <div class="tprm-fs-gallery-hero-title">How can I help?</div>
        <div class="tprm-fs-gallery-hero-sub">Pick a starting point or type your own prompt.</div>
      </div>
      <div class="tprm-fs-gallery-section">
        <div class="tprm-fs-gallery-section-label">Third-party risk</div>
        <div class="tprm-fs-gallery-grid">${tprm.map(tileHtml).join('')}</div>
      </div>
      <div class="tprm-fs-gallery-section">
        <div class="tprm-fs-gallery-section-label">Across the Optro platform</div>
        <div class="tprm-fs-gallery-grid">${grc.map(tileHtml).join('')}</div>
      </div>`;
    emptyEl.appendChild(gallery);
    // Tile click → same routing pills use: play a scripted response
    // when one exists, otherwise fall through to the fallback reply.
    gallery.addEventListener('click', (ev) => {
      const tile = ev.target && ev.target.closest && ev.target.closest('[data-tprm-fs-tile]');
      if (!tile) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const rawId = tile.getAttribute('data-script-id') || '';
      const text = tile.getAttribute('data-text') || '';
      if (rawId) {
        const resolved = resolveScriptId(player, rawId);
        if (player.manifest.chatScripts?.[resolved]) {
          player.play(resolved);
          return;
        }
      }
      playFallback(player, text || 'Explore what the assistant can do');
    });
    emptyEl.setAttribute('data-tprm-fs-gallery', '1');
    return true;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Header controls — enlarged × close + new ⋯ dot menu with:
  //    • Reset conversation                       (⟳)
  //    ─────
  //    • Detach panel  /  Dock panel [side]       (⇱ / ⇔)
  //    ─────
  //    • Assistant settings                       (⚙)
  //  When floating, the header itself is grab-draggable; drag events
  //  postMessage the parent, which moves the container.
  // ─────────────────────────────────────────────────────────────────
  let _panelMode = 'sidecar-right';
  window.addEventListener('message', (e) => {
    const msg = e && e.data;
    if (!msg) return;
    if (msg.type === 'optro-panel-mode-broadcast') {
      _panelMode = msg.mode || _panelMode;
      // Re-render menu labels + toggle grab cursor on any mounted header.
      document.querySelectorAll('[data-tprm-hdr-installed]').forEach((hdr) => {
        updateHeaderModeUi(hdr);
      });
      return;
    }
    if (msg.type === 'optro-load-history-thread') {
      const player = window.__ASSISTANT_PLAYER;
      if (player && Array.isArray(msg.thread)) {
        try { player.loadThreadInstant(msg.thread); } catch (err) {}
      }
      return;
    }
    if (msg.type === 'optro-load-prompt-into-input') {
      const player = window.__ASSISTANT_PLAYER;
      if (player && typeof msg.text === 'string') {
        try {
          setChatInputValue(player, msg.text);
          const input = player.chatPanel && player.chatPanel.querySelector('textarea, [contenteditable="true"]');
          if (input) input.focus();
        } catch (err) {}
      }
      return;
    }
  });

  function ensureHeaderControlStyles() {
    if (document.getElementById('tprm-hdr-controls-styles')) return;
    const s = document.createElement('style');
    s.id = 'tprm-hdr-controls-styles';
    s.textContent = `
      /* Fullscreen-tab layout drops the in-panel navy header — the
         parent's tab chip already identifies the chat and provides the
         close affordance. Belt-and-braces: hide the messages-header
         separator too if the bundle paints one just below the header. */
      html[data-tprm-layout="fullscreen"] ._header_1vvl1_59 { display: none !important; }
      /* Dot-menu button — matches the sibling close button's ghost/hover
         treatment against the navy header. */
      .tprm-hdr-menu-wrap { position: relative; display: inline-flex; align-items: center; }
      .tprm-hdr-dot-btn { background: transparent; border: 0; cursor: pointer;
        color: rgba(255,255,255,0.85); padding: 0.375rem; border-radius: 6px;
        display: inline-flex; align-items: center; justify-content: center; }
      .tprm-hdr-dot-btn:hover { background: rgba(255, 255, 255, 0.10); color: #fff; }
      .tprm-hdr-dot-btn svg { display: block; }
      /* Luna-style dropdown menu — anchored below the button, right-edge
         aligned with the button. Divider lines split the three groups. */
      .tprm-hdr-menu { position: absolute; top: calc(100% + 0.5rem); right: 0; z-index: 40;
        min-width: 13.5rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
        box-shadow: 0 12px 32px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.08);
        padding: 0.375rem; }
      .tprm-hdr-menu[hidden] { display: none; }
      /* !important on the item's text properties defeats the compiled
         bundle's header-scoped button rules (color: white / font-size: 0
         / etc.), which would otherwise inherit into our dropdown items
         and hide the labels. Menu popover renders inside the header
         (via absolute positioning) so bundle ancestor selectors still
         apply to our items. */
      .tprm-hdr-menu-item { display: flex !important; align-items: center; gap: 0.625rem;
        width: 100%; text-align: left; background: transparent; border: 0;
        padding: 0.5rem 0.625rem; font: inherit; font-size: 0.8125rem !important; line-height: 1.4 !important;
        color: #0f172a !important; letter-spacing: 0 !important; text-transform: none !important;
        cursor: pointer; border-radius: 6px; }
      .tprm-hdr-menu-item:hover { background: #f1f5f9 !important; }
      .tprm-hdr-menu-item svg { width: 15px !important; height: 15px !important;
        color: #64748b !important; flex-shrink: 0; }
      .tprm-hdr-menu-item:hover svg { color: #0f172a !important; }
      .tprm-hdr-menu-label { color: #0f172a !important; font-weight: 500 !important;
        white-space: nowrap; }
      .tprm-hdr-menu-divider { height: 1px; background: #e2e8f0; margin: 0.375rem 0.25rem; }
      /* Grab cursor on the floating panel header so users know it drags. */
      ._header_1vvl1_59[data-tprm-draggable="1"] { cursor: grab; user-select: none; }
      ._header_1vvl1_59[data-tprm-dragging="1"] { cursor: grabbing !important; }
      /* Persona trigger / buttons keep their own cursor semantics. */
      ._header_1vvl1_59 [data-tprm-draggable-passthrough],
      ._header_1vvl1_59 button,
      ._header_1vvl1_59 [role="button"] { cursor: pointer; }
    `;
    document.head.appendChild(s);
  }

  // SVG icon markup for the dock-control menu items. Extracted so
  // updateHeaderModeUi() can swap the icon when the item's semantic
  // meaning changes (Dock Left ↔ Dock Right ↔ Undock).
  const DOCK_ICONS = {
    'dock-left':  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M6 2.5v11"/></svg>',
    'dock-right': '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M10 2.5v11"/></svg>',
    'undock':     '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2h4v4"/><path d="M14 2l-6 6"/><path d="M13 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/></svg>',
  };

  // Swap an item's icon in place. The icon element is the first child
  // <svg> of the button, sitting to the left of `.tprm-hdr-menu-label`.
  function setMenuItemIcon(btn, iconKey) {
    if (!btn) return;
    const svg = btn.querySelector('svg');
    if (!svg) return;
    const wrap = document.createElement('span');
    wrap.innerHTML = DOCK_ICONS[iconKey] || '';
    const next = wrap.firstElementChild;
    if (next) svg.replaceWith(next);
  }

  // Refresh mode-dependent bits on the injected header:
  //   Slot A ("detach" key) — dock-left / dock-right toggle
  //     floating       → Dock Left  (target sidecar-left)
  //     sidecar-right  → Dock Left  (target sidecar-left)
  //     sidecar-left   → Dock Right (target sidecar-right)
  //   Slot B ("dock-side" key) — dock-right / undock toggle
  //     floating       → Dock Right (target sidecar-right)
  //     sidecar-right  → Undock     (target floating)
  //     sidecar-left   → Undock     (target floating)
  // Also toggles the draggable attribute for cursor + drag activation.
  function updateHeaderModeUi(hdr) {
    const isFloating = _panelMode === 'floating';
    const isLeft = _panelMode === 'sidecar-left';
    hdr.setAttribute('data-tprm-draggable', isFloating ? '1' : '0');
    const menu = hdr.querySelector('.tprm-hdr-menu');
    if (!menu) return;
    // Retain historical keys ("detach", "dock-side") so the click
    // dispatcher continues to route via the shared `data-target-mode`
    // path. Labels and icons flip based on the active dock state.
    const slotA = menu.querySelector('[data-tprm-menu-key="detach"]');
    const slotB = menu.querySelector('[data-tprm-menu-key="dock-side"]');
    if (slotA) {
      const label = slotA.querySelector('.tprm-hdr-menu-label');
      if (isLeft) {
        label.textContent = 'Dock Right';
        slotA.setAttribute('data-target-mode', 'sidecar-right');
        setMenuItemIcon(slotA, 'dock-right');
      } else {
        label.textContent = 'Dock Left';
        slotA.setAttribute('data-target-mode', 'sidecar-left');
        setMenuItemIcon(slotA, 'dock-left');
      }
    }
    if (slotB) {
      const label = slotB.querySelector('.tprm-hdr-menu-label');
      if (isFloating) {
        label.textContent = 'Dock Right';
        slotB.setAttribute('data-target-mode', 'sidecar-right');
        setMenuItemIcon(slotB, 'dock-right');
      } else {
        label.textContent = 'Undock';
        slotB.setAttribute('data-target-mode', 'floating');
        setMenuItemIcon(slotB, 'undock');
      }
    }
  }

  // Idempotent — checks `data-tprm-hdr-installed` on the header before
  // wiring anything so repeated calls are no-ops. Polls briefly if the
  // header hasn't been painted yet by the bundle when first invoked.
  function installHeaderControls(player) {
    ensureHeaderControlStyles();
    const tryMount = () => {
      const hdr = player.chatPanel.querySelector('._header_1vvl1_59');
      if (!hdr) return false;
      if (hdr.getAttribute('data-tprm-hdr-installed') === '1') return true;
      // Locate the close × button — the one whose icon uses #luna-x,
      // or whose aria-label reads "Close" (bundle sets both in practice).
      let closeBtn = hdr.querySelector('button[aria-label="Close"]');
      if (!closeBtn) {
        closeBtn = Array.from(hdr.querySelectorAll('button')).find((b) => {
          const use = b.querySelector('use');
          const href = use && (use.getAttribute('href') || use.getAttribute('xlink:href') || '');
          return href && href.includes('luna-x');
        });
      }
      if (!closeBtn) return false;
      installHeaderControlsInner(player, hdr, closeBtn);
      return true;
    };
    if (tryMount()) return;
    const iv = window.setInterval(() => {
      if (tryMount()) window.clearInterval(iv);
    }, 100);
    window.setTimeout(() => window.clearInterval(iv), 10000);
  }

  function installHeaderControlsInner(player, hdr, closeBtn) {
    closeBtn.setAttribute('data-tprm-close-x', '1');
    hdr.setAttribute('data-tprm-hdr-installed', '1');
    // Build the ⋯ menu button + dropdown, inserted immediately before ×.
    const wrap = document.createElement('span');
    wrap.className = 'tprm-hdr-menu-wrap';
    wrap.innerHTML = `
      <button type="button" class="tprm-hdr-dot-btn" aria-haspopup="menu" aria-expanded="false" aria-label="Panel options">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>
      </button>
      <div class="tprm-hdr-menu" role="menu" hidden>
        <button type="button" role="menuitem" class="tprm-hdr-menu-item" data-tprm-menu-key="reset">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5a5.5 5.5 0 1 1-.9 4.5"/><path d="M2.5 2v3h3"/></svg>
          <span class="tprm-hdr-menu-label">Reset conversation</span>
        </button>
        <div class="tprm-hdr-menu-divider"></div>
        <!-- Slot A: dock-left ⇄ dock-right toggle. Historical key "detach"
             preserved so the click dispatcher's shared data-target-mode
             path keeps routing without a rename. -->
        <button type="button" role="menuitem" class="tprm-hdr-menu-item" data-tprm-menu-key="detach" data-target-mode="sidecar-left">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M6 2.5v11"/></svg>
          <span class="tprm-hdr-menu-label">Dock Left</span>
        </button>
        <!-- Slot B: dock-right (when floating) or Undock (when docked).
             Default panel mode is sidecar-right, so seed as Undock. -->
        <button type="button" role="menuitem" class="tprm-hdr-menu-item" data-tprm-menu-key="dock-side" data-target-mode="floating">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2h4v4"/><path d="M14 2l-6 6"/><path d="M13 9v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/></svg>
          <span class="tprm-hdr-menu-label">Undock</span>
        </button>
        <div class="tprm-hdr-menu-divider" data-tprm-menu-mvp-hide="new-tab"></div>
        <button type="button" role="menuitem" class="tprm-hdr-menu-item" data-tprm-menu-key="new-tab" data-tprm-menu-mvp-hide="new-tab">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h9a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M6 3.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 12 3.5V6"/><path d="M11 10v-1.5"/><path d="M11 12.5V11"/><path d="M9.75 11.25h2.5"/></svg>
          <span class="tprm-hdr-menu-label">New Assistant tab</span>
        </button>
        <div class="tprm-hdr-menu-divider"></div>
        <button type="button" role="menuitem" class="tprm-hdr-menu-item" data-tprm-menu-key="settings">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M13 8a5 5 0 0 0-.1-1l1.4-1.1-1.4-2.4-1.7.6a5 5 0 0 0-1.7-1l-.3-1.8h-2.8l-.3 1.8a5 5 0 0 0-1.7 1l-1.7-.6-1.4 2.4L2.6 7A5 5 0 0 0 2.6 9L1.2 10.1l1.4 2.4 1.7-.6a5 5 0 0 0 1.7 1l.3 1.8h2.8l.3-1.8a5 5 0 0 0 1.7-1l1.7.6 1.4-2.4L12.9 9q.1-.5.1-1z"/></svg>
          <span class="tprm-hdr-menu-label">Assistant settings</span>
        </button>
      </div>
    `;
    closeBtn.parentNode.insertBefore(wrap, closeBtn);
    // MVP mode hides the "New Assistant tab" affordance (and its adjacent
    // divider) — the fullscreen-tab experience isn't part of the MVP scope.
    // Same-origin parent access; falls open on any cross-origin failure.
    try {
      if (window.parent && window.parent.document
          && window.parent.document.body.classList.contains('mvp-mode')) {
        wrap.querySelectorAll('[data-tprm-menu-mvp-hide="new-tab"]').forEach(el => el.remove());
      }
    } catch (_) { /* cross-origin — leave menu untouched */ }
    // Menu toggle wiring.
    const menuBtn = wrap.querySelector('.tprm-hdr-dot-btn');
    const menuEl = wrap.querySelector('.tprm-hdr-menu');
    const closeMenu = () => { menuEl.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); };
    const openMenu = () => { menuEl.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); };
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (menuEl.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener('click', (ev) => {
      if (menuEl.hidden) return;
      if (!wrap.contains(ev.target)) closeMenu();
    });
    // Menu item dispatch.
    menuEl.addEventListener('click', (ev) => {
      const item = ev.target && ev.target.closest && ev.target.closest('[data-tprm-menu-key]');
      if (!item) return;
      ev.stopPropagation();
      const key = item.getAttribute('data-tprm-menu-key');
      closeMenu();
      if (key === 'reset') {
        try { player.resetToEmptyState(); } catch (e) {}
        return;
      }
      if (key === 'new-tab') {
        // Ask the parent to open a fresh assistant instance as a
        // fullscreen top-tab (Claude-desktop feel). The current sidecar
        // panel stays mounted and keeps its conversation state.
        try { window.parent.postMessage({ type: 'optro-open-assistant-tab' }, '*'); } catch (e) {}
        return;
      }
      if (key === 'settings') {
        // No-op placeholder — future settings panel.
        return;
      }
      const target = item.getAttribute('data-target-mode');
      if (target && window.parent && window.parent !== window) {
        try { window.parent.postMessage({ type: 'optro-panel-mode', mode: target }, '*'); } catch (e) {}
      }
    });
    // Drag on the header — only when floating. Uses pointer capture so
    // events keep flowing to the header even when the mouse leaves the
    // iframe area; parent receives deltas and moves the container.
    //
    // CRITICAL: use screenX/screenY, not clientX/clientY. clientX is
    // measured relative to the iframe's viewport — but when the parent
    // moves the iframe container in response to a drag event, the
    // iframe viewport moves too, so the next pointermove reports a
    // clientX that has been shifted by the same amount we just moved.
    // The result is a feedback loop that partially cancels each move
    // and produces the jittery/stalling drag. screenX is absolute to
    // the physical display and stable through container movement.
    let dragStart = null;
    hdr.addEventListener('pointerdown', (ev) => {
      if (_panelMode !== 'floating') return;
      // Only drag when starting on an inert area of the header — clicks
      // on buttons / interactive controls (persona trigger, menu, ×)
      // must pass through untouched.
      if (ev.target && ev.target.closest && ev.target.closest('button, [role="button"], [role="menu"], input, a')) return;
      dragStart = { x: ev.screenX, y: ev.screenY, pointerId: ev.pointerId };
      hdr.setAttribute('data-tprm-dragging', '1');
      try { hdr.setPointerCapture(ev.pointerId); } catch (e) {}
      try { window.parent.postMessage({ type: 'optro-panel-drag-start' }, '*'); } catch (e) {}
    });
    hdr.addEventListener('pointermove', (ev) => {
      if (!dragStart || ev.pointerId !== dragStart.pointerId) return;
      const dx = ev.screenX - dragStart.x;
      const dy = ev.screenY - dragStart.y;
      try { window.parent.postMessage({ type: 'optro-panel-drag-move', dx, dy }, '*'); } catch (e) {}
    });
    const endDrag = (ev) => {
      if (!dragStart || (ev && ev.pointerId !== dragStart.pointerId)) return;
      try { hdr.releasePointerCapture(dragStart.pointerId); } catch (e) {}
      dragStart = null;
      hdr.setAttribute('data-tprm-dragging', '0');
      try { window.parent.postMessage({ type: 'optro-panel-drag-end' }, '*'); } catch (e) {}
    };
    hdr.addEventListener('pointerup', endDrag);
    hdr.addEventListener('pointercancel', endDrag);
    updateHeaderModeUi(hdr);
  }

  // ─────────────────────────────────────────────────────────
  // Persona menu — exact bundle JSX:
  //   <div role="menu" class="_personaMenu_1vvl1_97">
  //     <button role="menuitem"
  //             class="_personaMenuItem_1vvl1_135 [_personaMenuItemActive_1vvl1_155]"
  //             type="button">
  //       <span class="_personaMenuIcon_1vvl1_159"
  //             style="background-color: {color}">{initials}</span>
  //       <span class="_personaMenuBody_1vvl1_173">
  //         <span class="_personaMenuName_1vvl1_181">{name}</span>
  //         <span class="_personaMenuDesc_1vvl1_187">{description}</span>
  //       </span>
  //       [<check icon>]  // active only
  //     </button>
  //     …
  //   </div>
  // ─────────────────────────────────────────────────────────
  function swapPersonaMenu(player) {
    const menu = document.querySelector('._personaMenu_1vvl1_97[role="menu"]');
    if (!menu) return false;
    const personas = player.manifest.personas || [];
    if (!personas.length) return false;
    // Self-healing: re-swap if React re-rendered and dropped our items.
    const alreadySwapped = menu.getAttribute('data-tprm-swapped') === '1';
    const hasOurItems = !!menu.querySelector('button[data-tprm-persona-id]');
    if (alreadySwapped && hasOurItems) return false;
    menu.setAttribute('data-tprm-swapped', '1');
    const activeId = player.activePersonaId || player.manifest.defaultPersonaId || personas[0]?.id;
    menu.innerHTML = personas.map((p) => {
      const active = p.id === activeId;
      return `<button type="button" role="menuitem" class="_personaMenuItem_1vvl1_135${active ? ' _personaMenuItemActive_1vvl1_155' : ''}" data-tprm-persona-id="${escapeHtml(p.id)}">
        <span class="_personaMenuIcon_1vvl1_159" style="background-color:${escapeHtml(p.color || '#0f172a')}">${escapeHtml(p.initials || '')}</span>
        <span class="_personaMenuBody_1vvl1_173">
          <span class="_personaMenuName_1vvl1_181">${escapeHtml(p.name)}</span>
          <span class="_personaMenuDesc_1vvl1_187">${escapeHtml(p.description || '')}</span>
        </span>
        ${active ? `<svg class="_Icon_kum9n_5" width="14" height="14" role="presentation"><use href="#luna-check"></use></svg>` : ''}
      </button>`;
    }).join('');
    // Wire click routing on each persona item.
    menu.querySelectorAll('button[data-tprm-persona-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const id = btn.getAttribute('data-tprm-persona-id');
        player.activePersonaId = id;
        // Redraw the active state without recreating the DOM.
        menu.querySelectorAll('button[data-tprm-persona-id]').forEach((b) => {
          const isActive = b.getAttribute('data-tprm-persona-id') === id;
          b.classList.toggle('_personaMenuItemActive_1vvl1_155', isActive);
        });
        swapPersonaTriggerLabel(player);
        closePopover();
      });
    });
    return true;
  }

  function swapPersonaTriggerLabel(player) {
    const trigger = player.chatPanel.querySelector('._personaTrigger_1vvl1_101');
    if (!trigger) return false;
    const activeId = player.activePersonaId || player.manifest.defaultPersonaId;
    const p = (player.manifest.personas || []).find((x) => x.id === activeId);
    if (!p) return false;
    if (trigger.getAttribute('data-tprm-persona') === p.id) return false;
    trigger.setAttribute('data-tprm-persona', p.id);
    // The trigger has: [name text] + <chevron icon>. Rewrite only the
    // first text node so the icon stays intact.
    for (const node of Array.from(trigger.childNodes)) {
      if (node.nodeType === 1 && node.tagName === 'SPAN' && !/Icon/.test(node.className || '')) {
        node.textContent = p.name;
        return true;
      }
      if (node.nodeType === 3) { // text node
        node.textContent = p.name;
        return true;
      }
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────
  // Picker identification. The bundle mounts two visually-similar
  // "pickers" in the input area: the "Prompts & Plans" library (⚡ btn)
  // and the "@ entity reference" picker. We tell them apart by the
  // aria-label the bundle sets on the picker root:
  //   Prompts:  aria-label="Search prompts and plans"
  //   Entities: aria-label="Search context entities"
  // ─────────────────────────────────────────────────────────
  function pickerRole(picker) {
    const label = (picker.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('prompt') || label.includes('plan')) return 'prompts';
    if (label.includes('entit')) return 'entities';
    return null;
  }

  // ─────────────────────────────────────────────────────────
  // Prompt library — exact bundle JSX (from source inspection):
  //   <div role="combobox" aria-label="Search prompts and plans"
  //        class="_picker_1vvl1_1869">
  //     <input class="_pickerSearch_1vvl1_1885" …/>
  //     <div role="listbox" class="_pickerResults_1vvl1_1902">
  //       <div class="_pickerGroupLabel_1vvl1_1961">Saved Prompts</div>
  //       <button role="option" aria-selected="…"
  //               class="_pickerItem_1vvl1_1910 _slashPickerItem_1vvl1_453 [active]">
  //         <svg …lightning-charge/>
  //         <div class="_slashPickerBody_1vvl1_459">
  //           <div class="_slashPickerTitle_1vvl1_467">{title}</div>
  //           <div class="_slashPickerDesc_1vvl1_473">{description}</div>
  //         </div>
  //         <span class="_slashPickerCategory_1vvl1_480">{category}</span>
  //       </button>
  //       …
  //       <div class="_pickerGroupLabel_1vvl1_1961">Saved Plans</div>
  //       <button …list-check icon…>{title}{description}<span>Plan</span></button>
  //     </div>
  //   </div>
  // ─────────────────────────────────────────────────────────
  function swapPromptLibrary(player) {
    const picker = document.querySelector('._picker_1vvl1_1869');
    if (!picker) return false;
    if (pickerRole(picker) !== 'prompts') return false;
    const results = picker.querySelector('._pickerResults_1vvl1_1902');
    if (!results) return false;
    // Self-healing: if latched but React has since wiped our items,
    // unlatch and re-swap.
    const alreadySwapped = picker.getAttribute('data-tprm-swapped') === '1';
    const hasOurItems = !!results.querySelector('button[data-tprm-picker-item]');
    if (alreadySwapped && hasOurItems) return false;
    picker.setAttribute('data-tprm-swapped', '1');
    const prompts = player.manifest.prompts || [];
    const plans = player.manifest.savedPlans || [];
    let html = '';
    if (prompts.length) {
      html += `<div class="_pickerGroupLabel_1vvl1_1961">Saved Prompts</div>`;
      html += prompts.map((p) => `<button type="button" role="option" aria-selected="false" class="_pickerItem_1vvl1_1910 _slashPickerItem_1vvl1_453" data-tprm-picker-item="prompt" data-tprm-item-id="${escapeHtml(p.id)}">
        <svg class="_Icon_kum9n_5" width="14" height="14" role="presentation"><use href="#luna-lightning-charge"></use></svg>
        <div class="_slashPickerBody_1vvl1_459">
          <div class="_slashPickerTitle_1vvl1_467">${escapeHtml(p.title)}</div>
          <div class="_slashPickerDesc_1vvl1_473">${escapeHtml(p.description || '')}</div>
        </div>
        <span class="_slashPickerCategory_1vvl1_480">${escapeHtml(p.category || 'Prompt')}</span>
      </button>`).join('');
    }
    if (plans.length) {
      html += `<div class="_pickerGroupLabel_1vvl1_1961">Saved Plans</div>`;
      html += plans.map((p) => `<button type="button" role="option" aria-selected="false" class="_pickerItem_1vvl1_1910 _slashPickerItem_1vvl1_453" data-tprm-picker-item="plan" data-tprm-item-id="${escapeHtml(p.id)}">
        <svg class="_Icon_kum9n_5" width="14" height="14" role="presentation"><use href="#luna-list-check"></use></svg>
        <div class="_slashPickerBody_1vvl1_459">
          <div class="_slashPickerTitle_1vvl1_467">${escapeHtml(p.title)}</div>
          <div class="_slashPickerDesc_1vvl1_473">${escapeHtml(p.description || '')}</div>
        </div>
        <span class="_slashPickerCategory_1vvl1_480">Plan</span>
      </button>`).join('');
    }
    if (!html) html = `<div class="_pickerEmpty_1vvl1_1952">No matches</div>`;
    results.innerHTML = html;
    // Hover selection like the bundle: track active row per mouseenter.
    let activeIdx = -1;
    const items = results.querySelectorAll('button[data-tprm-picker-item]');
    items.forEach((btn, i) => {
      btn.addEventListener('mouseenter', () => {
        if (activeIdx >= 0 && items[activeIdx]) {
          items[activeIdx].classList.remove('_pickerItemActive_1vvl1_1927');
          items[activeIdx].setAttribute('aria-selected', 'false');
        }
        activeIdx = i;
        btn.classList.add('_pickerItemActive_1vvl1_1927');
        btn.setAttribute('aria-selected', 'true');
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const kind = btn.getAttribute('data-tprm-picker-item');
        const id = btn.getAttribute('data-tprm-item-id');
        if (kind === 'prompt') {
          const p = (player.manifest.prompts || []).find((x) => x.id === id);
          if (p) {
            let text = p.template || p.title || '';
            // Substitute context-aware placeholders. When Acme is the
            // active reference, `{{vendor}}` becomes "Acme Cloud Co."
            // so the user doesn't have to hand-edit before sending.
            text = substituteTemplatePlaceholders(text, player);
            setChatInputValue(player, text);
          }
        } else if (kind === 'plan') {
          closePopover();
          const plan = (player.manifest.savedPlans || []).find((x) => x.id === id);
          if (plan) {
            const resolved = resolveScriptId(player, plan.id);
            if (player.manifest.chatScripts?.[resolved]) {
              player.play(resolved);
            }
          }
          return; // already closed
        }
        closePopover();
      });
    });
    return true;
  }

  // ─────────────────────────────────────────────────────────
  // Entity reference picker — exact bundle JSX:
  //   <div role="combobox" aria-label="Search context entities"
  //        class="_picker_1vvl1_1869">
  //     <input class="_pickerSearch_1vvl1_1885" …/>
  //     <div role="listbox" class="_pickerResults_1vvl1_1902">
  //       <button role="option" aria-selected="…"
  //               class="_pickerItem_1vvl1_1910 [active]">
  //         <svg …{entity.icon}/>
  //         <span class="_pickerItemId_1vvl1_1936">{id}</span>
  //         <span class="_pickerItemTitle_1vvl1_1943">{title}</span>
  //       </button>
  //       …
  //     </div>
  //   </div>
  //
  // Bundle emits a FLAT list (no group headers) so we do the same;
  // TPRM manifest groups by entity type, but we flatten and prefix
  // the ID with the type letter (V/A/D/F/P/C/K) to preserve context.
  // ─────────────────────────────────────────────────────────
  function swapEntityPicker(player) {
    const picker = document.querySelector('._picker_1vvl1_1869');
    if (!picker) return false;
    if (pickerRole(picker) !== 'entities') return false;
    const results = picker.querySelector('._pickerResults_1vvl1_1902');
    if (!results) return false;
    // Self-healing: same as prompt library — re-swap if React clobbered.
    const alreadySwapped = picker.getAttribute('data-tprm-swapped') === '1';
    const hasOurItems = !!results.querySelector('button[data-tprm-entity-id]');
    if (alreadySwapped && hasOurItems) return false;
    picker.setAttribute('data-tprm-swapped', '1');
    // Flatten grouped entities into one list; bundle expects flat.
    const groups = player.manifest.referenceEntities || [];
    const flat = [];
    groups.forEach((g) => (g.items || []).forEach((it) => {
      flat.push({ type: g.type, icon: g.icon || 'circle', ...it });
    }));
    if (!flat.length) {
      results.innerHTML = `<div class="_pickerEmpty_1vvl1_1952">No matches</div>`;
      return true;
    }
    results.innerHTML = flat.map((it) => `<button type="button" role="option" aria-selected="false" class="_pickerItem_1vvl1_1910" data-tprm-entity-type="${escapeHtml(it.type)}" data-tprm-entity-id="${escapeHtml(it.id)}" data-tprm-entity-title="${escapeHtml(it.title || '')}" data-tprm-entity-icon="${escapeHtml(it.icon || 'circle')}">
      <svg class="_Icon_kum9n_5" width="14" height="14" role="presentation"><use href="#luna-${escapeHtml(it.icon || 'circle')}"></use></svg>
      <span class="_pickerItemId_1vvl1_1936">${escapeHtml(it.id)}</span>
      <span class="_pickerItemTitle_1vvl1_1943">${escapeHtml(it.title)}</span>
    </button>`).join('');
    let activeIdx = -1;
    const items = results.querySelectorAll('button[data-tprm-entity-id]');
    items.forEach((btn, i) => {
      btn.addEventListener('mouseenter', () => {
        if (activeIdx >= 0 && items[activeIdx]) {
          items[activeIdx].classList.remove('_pickerItemActive_1vvl1_1927');
          items[activeIdx].setAttribute('aria-selected', 'false');
        }
        activeIdx = i;
        btn.classList.add('_pickerItemActive_1vvl1_1927');
        btn.setAttribute('aria-selected', 'true');
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Add a chip in the attachments row — same visual pattern as
        // the auto-populated primary context chip. Dedupe handled by
        // addContextChip.
        addContextChip(player, {
          type: btn.getAttribute('data-tprm-entity-type'),
          id: btn.getAttribute('data-tprm-entity-id'),
          name: btn.getAttribute('data-tprm-entity-title') || btn.getAttribute('data-tprm-entity-id'),
          icon: btn.getAttribute('data-tprm-entity-icon') || 'circle',
        });
        closePopover();
      });
    });
    return true;
  }

  // Bundle's pickers listen for `mousedown` (not click) outside the
  // popover to dismiss themselves. Dispatch a synthetic mousedown on
  // the body so we don't have to reach into React state.
  function closePopover() {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  }

  /**
   * Set the chat input's value in a way React's controlled input can
   * see. The bundle's textarea is a controlled component — writing
   * `.value = ...` directly gets clobbered on React's next render
   * because React overwrites the DOM to match its internal state.
   *
   * The workaround is React's private value-tracker: call the native
   * setter (which React monkey-patches to detect changes) and dispatch
   * a bubbling `input` event. React's synthetic event handler catches
   * it and updates state, so the value sticks.
   */
  function setChatInputValue(player, value) {
    const input = player.chatPanel.querySelector('textarea, [contenteditable="true"]');
    if (!input) return;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
    } else {
      input.textContent = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function appendChatInputValue(player, text) {
    const input = player.chatPanel.querySelector('textarea, [contenteditable="true"]');
    if (!input) return;
    const current = input.tagName === 'TEXTAREA' || input.tagName === 'INPUT'
      ? (input.value || '')
      : (input.textContent || '');
    setChatInputValue(player, current + text);
  }

  /**
   * Substitute every `{{key}}` placeholder in a prompt template using
   * the manifest's per-entity substitution table. When the Acme
   * context is active, `{{vendor}}` → "Acme Cloud Co.", `{{document}}`
   * → the currently-outstanding doc, `{{date}}` → the sensible next
   * target date, etc. Unknown keys are left as-is so the designer sees
   * what still needs manual fill-in.
   *
   * Substitution map:
   *   `manifest.contextTemplates[entityId]` — object mapping placeholder
   *   key (lowercase) to concrete substitution string. Falls back to the
   *   entity's own `name` for the `vendor` key even if not explicitly
   *   listed (so the base case is always covered).
   */
  function substituteTemplatePlaceholders(text, player) {
    const cxt = player.contextEntity;
    if (!cxt) return text;
    const perEntity = (player.manifest.contextTemplates || {})[cxt.id] || {};
    const substitutions = Object.assign(
      { vendor: cxt.name || cxt.short || cxt.id },
      perEntity
    );
    return String(text).replace(/\{\{([^}]+)\}\}/g, (whole, key) => {
      const k = String(key).trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(substitutions, k)
        ? substitutions[k]
        : whole;
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function attachInterception(player) {
    // Capture-phase click delegator. This is the LAST line of defense
    // between the user and the bundle's compiled GRC content: every
    // click and Enter press is caught here, and we ALWAYS
    // stopImmediatePropagation so the bundle's own handlers never fire.
    // No matter what the user does, the panel can only display
    // TPRM-manifest content.
    document.addEventListener('click', (e) => {
      const pill = e.target.closest('._suggestion_1vvl1_226');
      if (pill && player.chatPanel.contains(pill)) {
        const pills = Array.from(player.chatPanel.querySelectorAll('._suggestion_1vvl1_226'));
        const idx = pills.indexOf(pill);
        // IMPORTANT: use the same pill set the swap uses (context-aware),
        // so pill index → quick action stays aligned.
        const qa = activeQuickActions(player)[idx];
        e.stopImmediatePropagation();
        e.preventDefault();
        if (qa && qa.scriptId) {
          const resolved = resolveScriptId(player, qa.scriptId);
          if (player.manifest.chatScripts?.[resolved]) {
            player.play(resolved);
          } else {
            playFallback(player, qa.text || 'Explore what the assistant can do');
          }
        } else {
          playFallback(player, qa ? qa.text : 'Explore what the assistant can do');
        }
        return;
      }
      // Entity-picker item click — capture at document level so even
      // if my per-button swap handler doesn't survive React re-render,
      // we STILL block the bundle's onClick (which would insert
      // `@Vendor:V-2094` text into the input) and route to add a chip.
      // Identify by: picker root exists, has "entit" in aria-label,
      // and the click landed on a picker item button. Entity info is
      // derived from data-tprm-* attrs when my swap set them, else
      // read directly from the bundle's own `_pickerItemId` /
      // `_pickerItemTitle` children.
      const pickerRoot = e.target.closest('._picker_1vvl1_1869');
      if (pickerRoot && /entit/i.test(pickerRoot.getAttribute('aria-label') || '')) {
        const pickerBtn = e.target.closest('button[role="option"], button._pickerItem_1vvl1_1910');
        if (pickerBtn) {
          e.stopImmediatePropagation();
          e.preventDefault();
          // Attribute source first (mine), children fallback (bundle's).
          const id = pickerBtn.getAttribute('data-tprm-entity-id')
            || (pickerBtn.querySelector('._pickerItemId_1vvl1_1936')?.textContent || '').trim();
          const title = pickerBtn.getAttribute('data-tprm-entity-title')
            || (pickerBtn.querySelector('._pickerItemTitle_1vvl1_1943')?.textContent || '').trim();
          const iconEl = pickerBtn.querySelector('use[href^="#luna-"]');
          const iconName = pickerBtn.getAttribute('data-tprm-entity-icon')
            || (iconEl ? iconEl.getAttribute('href').replace('#luna-', '') : 'circle');
          if (id) {
            addContextChip(player, {
              type: pickerBtn.getAttribute('data-tprm-entity-type') || 'Vendor',
              id,
              name: title || id,
              icon: iconName || 'circle',
            });
            closePopover();
          }
          return;
        }
      }
      // Reset conversation menu item — restore the empty state after the
      // bundle finishes its own reset animation.
      const menuBtn = e.target.closest('[role="menu"] button, button[role="menuitem"]');
      if (menuBtn) {
        const label = (menuBtn.textContent || '').trim().toLowerCase();
        if (label.includes('reset conversation')) {
          window.setTimeout(() => player.resetToEmptyState(), 80);
        }
      }
      // Send button — ALWAYS block the bundle's send and route through
      // our player. The bundle renders it as a plain Luna <Button> with
      // no aria-label or type="submit"; identify it by:
      //   (a) being inside the input toolbar (_toolbar_1vvl1_1813), AND
      //   (b) containing the `send-fill` icon (unique to Send in this panel), OR
      //   (c) having text content that starts with "Send".
      const anyBtn = e.target.closest('button');
      if (anyBtn && player.chatPanel.contains(anyBtn)) {
        const inToolbar = !!anyBtn.closest('._toolbar_1vvl1_1813');
        const hasSendIcon = !!anyBtn.querySelector('[data-qid-icon-name="send-fill"], use[href="#luna-send-fill"], use[href="#luna-send"], use[xlink\\:href="#luna-send-fill"]');
        const textStartsWithSend = /^send\b/i.test((anyBtn.textContent || '').trim());
        if (inToolbar && (hasSendIcon || textStartsWithSend)) {
          e.stopImmediatePropagation();
          e.preventDefault();
          routeFreetextSend(player);
          return;
        }
      }
    }, true);
    // Enter-key send — same guarantee.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const input = e.target.closest('textarea, [contenteditable="true"]');
      if (!input || !player.chatPanel.contains(input)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      routeFreetextSend(player);
    }, true);
  }

  /**
   * Emit a manifest-driven response to whatever the user typed. This
   * function is guaranteed to handle EVERY send — no code path returns
   * without emitting something. That's what enforces the TPRM-only
   * invariant: the bundle's send handler is intercepted and never runs.
   */
  /**
   * Read the Plan-mode toggle. The bundle renders it as a checkbox
   * inside `._planCheckbox_1vvl1_1825` in the input toolbar. If the
   * feature isn't enabled in the current bundle build the checkbox
   * won't exist, in which case Plan mode is simply "off".
   */
  function isPlanModeActive(player) {
    const cb = player.chatPanel.querySelector('._planCheckbox_1vvl1_1825 input[type="checkbox"]');
    return !!(cb && cb.checked);
  }

  function routeFreetextSend(player) {
    const input = player.chatPanel.querySelector('textarea, [contenteditable="true"]');
    if (!input) return;
    const raw = ('value' in input ? input.value : input.textContent || '').trim();
    if (!raw) return;
    const list = player.ensureMessageList();
    if (!list) return;
    // Clear input immediately so the user sees acknowledgement.
    setChatInputValue(player, '');

    // Emit the user's turn first (all branches need it).
    const userMsg = { kind: 'user', text: raw };
    const rendered = Renderers.user(userMsg);
    if (rendered) {
      rendered.setAttribute('data-tprm-owned', '1');
      list.appendChild(rendered);
    }

    // Plan mode branches to a plan-only workflow before any freetext
    // triggers are considered. Matches bundle behavior: Plan mode
    // always returns a structured plan.
    if (isPlanModeActive(player)) {
      routePlanModeSend(player, raw);
      return;
    }

    // Field-update short-circuit — "Update <field> to <value>" phrasings
    // emit a suggested-field-update card without needing a per-field
    // manifest script. Runs before trigger matching so specific field
    // updates don't accidentally hit a broader trigger.
    const fu = parseFieldUpdate(raw);
    if (fu) {
      // Current value comes from the parent's state — request it via
      // postMessage or default to '—'. To keep this iframe-side simple,
      // we ask the parent to report the value alongside the apply flow.
      // For the assistant's card we display an "as configured" hint and
      // rely on the parent to update its own field.
      const commentary = { kind: 'commentary', text: `Reading Acme's ${fu.field.label.toLowerCase()} on the profile…` };
      const assistantIntro = { kind: 'assistant', text: `Here's the change I'll apply — dismiss to skip, apply to update the profile.` };
      const card = {
        kind: 'suggested-field-update',
        field: fu.field.key,
        fieldLabel: fu.field.label,
        currentValue: fu.field.current,
        newValue: fu.value,
      };
      // Optimistically bump the cached "current" so a follow-up update
      // in the same session reads against the new value.
      fu.field.current = fu.value;
      // Emit with modest cadence — mirrors how scripted plays feel.
      let elapsed = 200;
      [commentary, assistantIntro, card].forEach((step, i) => {
        elapsed += player.defaultDelay(i === 0 ? userMsg : [commentary, assistantIntro, card][i - 1]);
        const t = window.setTimeout(() => player.emit(step), elapsed);
        player.timers.push(t);
      });
      return;
    }

    const lower = raw.toLowerCase();
    const trigger = (player.manifest.freetextTriggers || []).find(
      (t) => (t.match || []).some((s) => lower.includes(String(s).toLowerCase()))
    );

    if (trigger && player.manifest.chatScripts?.[trigger.scriptId]) {
      // Route through the universal context resolver so pill clicks,
      // freetext triggers, and in-chat suggestion clicks all share the
      // same context-focus behavior.
      const scriptId = resolveScriptId(player, trigger.scriptId);
      let script = player.manifest.chatScripts[scriptId];
      // Special-case: control-connection / control-disconnection dynamically
      // pull the chipped Control(s) (chips[1..]) so the demo reflects the
      // entities the reviewer actually attached in the @-picker. Falls back
      // to the JSON default when no Control is currently chipped.
      if (scriptId === 'suggest-control-connection') {
        script = withChippedControl(player, script, 'add');
      } else if (scriptId === 'suggest-control-disconnection') {
        script = withChippedControl(player, script, 'remove');
      }
      const tail = script.slice(script[0]?.kind === 'user' ? 1 : 0);
      let elapsed = 300;
      tail.forEach((msg, i) => {
        elapsed += player.defaultDelay(i === 0 ? userMsg : tail[i - 1]);
        const t = window.setTimeout(() => player.emit(msg), elapsed);
        player.timers.push(t);
      });
      list.setAttribute('data-tprm-script-id', scriptId);
    } else {
      // No trigger match — but we STILL respond, entirely from the
      // manifest. Never fall through to the bundle.
      playFallback(player, raw, { emitUser: false });
    }
  }

  /**
   * Route a send that came in with Plan mode active. Matches the
   * bundle's rhythm — user turn (already emitted) → 600ms
   * "Drafting a plan…" commentary → 1500ms plan card — but picks
   * the plan from the manifest based on:
   *   1. planModeTriggers[].match (substring against typed text)
   *   2. contextDefaultPlan[entityId] (Acme → full reassessment)
   *   3. defaultPlanScriptId (portfolio fallback)
   * The picked scriptId is then context-resolved so Acme-specific
   * variants (e.g., `xxx__V-2094`) win when present.
   */
  function routePlanModeSend(player, typed) {
    const lower = String(typed || '').toLowerCase();
    const trigger = (player.manifest.planModeTriggers || []).find(
      (t) => (t.match || []).some((s) => lower.includes(String(s).toLowerCase()))
    );
    let baseId = trigger?.scriptId;
    if (!baseId) {
      const cxt = player.contextEntity;
      baseId = (cxt && player.manifest.contextDefaultPlan?.[cxt.id])
        || player.manifest.defaultPlanScriptId
        || null;
    }
    if (!baseId) {
      // No plan configured at all — fall back to synthesized fallback
      // so we still respond with something TPRM-scoped.
      playFallback(player, typed, { emitUser: false });
      return;
    }
    const scriptId = resolveScriptId(player, baseId);
    const script = player.manifest.chatScripts?.[scriptId];
    if (!script) {
      playFallback(player, typed, { emitUser: false });
      return;
    }
    // Play with the bundle's Plan-mode rhythm: 600ms commentary,
    // 1500ms plan reveal. The script's own commentary + plan messages
    // land inside that window; we just seed the first commentary.
    const tail = script.slice(script[0]?.kind === 'user' ? 1 : 0);
    let elapsed = 300;
    tail.forEach((msg, i) => {
      elapsed += player.defaultDelay(i === 0 ? { kind: 'user', text: typed } : tail[i - 1]);
      const t = window.setTimeout(() => player.emit(msg), elapsed);
      player.timers.push(t);
    });
    const list = player.ensureMessageList();
    if (list) list.setAttribute('data-tprm-script-id', scriptId);
  }

  /**
   * Emit a TPRM-only fallback response when the user's input doesn't
   * match any manifest trigger. Prefers `manifest.fallbackScriptId`
   * (a scripted, rich response) → falls back to a synthesized assistant
   * message + suggestion-buttons with the four quick actions.
   */
  function playFallback(player, typed, opts) {
    opts = opts || {};
    const list = player.ensureMessageList();
    if (!list) return;
    if (opts.emitUser !== false) {
      const uNode = Renderers.user({ kind: 'user', text: typed });
      if (uNode) {
        uNode.setAttribute('data-tprm-owned', '1');
        list.appendChild(uNode);
      }
    }
    // Rich fallback: a named script in the manifest.
    const fbId = player.manifest.fallbackScriptId;
    if (fbId && player.manifest.chatScripts?.[fbId]) {
      const script = player.manifest.chatScripts[fbId];
      const tail = script.slice(script[0]?.kind === 'user' ? 1 : 0);
      let elapsed = 300;
      tail.forEach((msg, i) => {
        elapsed += player.defaultDelay(i === 0 ? { kind: 'user', text: typed } : tail[i - 1]);
        const t = window.setTimeout(() => player.emit(msg), elapsed);
        player.timers.push(t);
      });
      return;
    }
    // Synthesized fallback: prefer a context-scoped message when we have
    // an active entity (mentions "Acme" by name), else fall back to the
    // manifest's generic response.
    let defaultText = player.manifest.defaultFreetextResponse
      || `I focus on third-party risk — vendor tiering, contract deltas, reassessment cadence, and adverse-news response. Try one of these to see how I work:`;
    const cxt = player.contextEntity;
    if (cxt && player.manifest.contextFallbacks?.[cxt.id]?.text) {
      defaultText = player.manifest.contextFallbacks[cxt.id].text;
    }
    window.setTimeout(() => player.emit({ kind: 'assistant', text: defaultText }), 500);
    // Suggestion pills use whichever quick-action set is currently
    // active (Acme-scoped when context = Acme, general otherwise).
    const qas = activeQuickActions(player);
    if (qas.length) {
      window.setTimeout(() => player.emit({
        kind: 'suggestion-buttons',
        options: qas.map((qa) => ({
          label: qa.text,
          icon: qa.icon,
          scriptId: qa.scriptId,
        })),
      }), 900);
    }
  }

  // ─────────────────────────────────────────────────────────
  // Boot — wait for manifest + chat panel to be ready, then wire up.
  // ─────────────────────────────────────────────────────────
  async function boot() {
    // Reentry guard — the DOMContentLoaded path and the parent-injection
    // path both call boot(). Either can win the race; whichever spins up
    // a Player first stakes the claim, and any concurrent boot() sees the
    // Player already exists and exits before double-mounting.
    if (window.__ASSISTANT_PLAYER) return;
    if (!window.__ASSISTANT_CONTENT_LOADING) return;
    const manifest = await window.__ASSISTANT_CONTENT_LOADING;
    if (!manifest) return;
    // Re-check after the await — a concurrent boot() may have completed
    // during the microtask gap.
    if (window.__ASSISTANT_PLAYER) return;
    let chatPanel = null;
    try {
      chatPanel = await waitFor('._panel_1vvl1_2', 15000);
    } catch (e) {
      return;
    }
    // Final check — waitFor also releases the event loop.
    if (window.__ASSISTANT_PLAYER) return;
    const player = new Player(manifest, chatPanel);
    // Reference-chip list. chips[0] is the "primary" that drives
    // routing (resolveScriptId), pill selection, and template
    // substitution. Additional chips are supplementary annotations
    // added via the @ picker. `contextEntity` mirrors chips[0].
    player.chips = [];
    if (window.__ASSISTANT_CONTEXT_ENTITY) {
      player.chips.push(window.__ASSISTANT_CONTEXT_ENTITY);
    }
    syncPrimaryContext(player);
    // Lifecycle phase — the third dimension of script routing (after
    // scriptId + entityId). Comes from parent's `state.workflowPhase`
    // via URL param on mount + postMessage bridge on updates.
    if (window.__ASSISTANT_CONTEXT_PHASE) {
      player.contextPhase = window.__ASSISTANT_CONTEXT_PHASE;
    }
    attachInterception(player);
    attachContentSwaps(player);
    installBundleAppendGuard(player);
    injectHeaderControls(player);
    if (player.chips.length) renderAllContextChips(player);
    // Listen for parent-sent context updates. Fired every time the panel
    // is opened AND on any transition that could change the entity or
    // lifecycle phase — keeps player state in lockstep with the parent.
    window.addEventListener('message', (e) => {
      const msg = e && e.data;
      if (!msg || msg.type !== 'optro-assistant-context') return;
      // If parent sends a fresh entity, replace the primary (but keep
      // any user-picked additional chips beyond it).
      if (msg.entity !== undefined) {
        const additional = (player.chips || []).slice(1);
        player.chips = msg.entity ? [msg.entity, ...additional] : additional;
        syncPrimaryContext(player);
        renderAllContextChips(player);
        const container = player.chatPanel.querySelector('._suggestions_1vvl1_226');
        if (container) container.removeAttribute('data-tprm-swapped');
        try { swapEmptyStatePills(player); } catch(e) {}
      }
      if (msg.phase !== undefined) player.contextPhase = msg.phase || null;
    });
    window.__ASSISTANT_PLAYER = player;
  }

  /**
   * The reference-chip model is a flat array — `player.chips` — where
   * `chips[0]` is the "primary" (routes `resolveScriptId`, drives
   * `contextQuickActions`, unlocks `contextTemplates`) and subsequent
   * chips are supplementary annotations that let the user signal
   * multi-entity focus without swapping context. Adding a chip via the
   * @ picker is additive: the primary stays, the new chip appends.
   * Removing the primary chip promotes chips[1] to primary.
   *
   * `player.contextEntity` mirrors `chips[0]` so every existing router
   * (resolveScriptId, activeQuickActions, template substitution, chip
   * append-guard) sees the same context object.
   */
  function syncPrimaryContext(player) {
    player.contextEntity = player.chips[0] || null;
  }

  function addContextChip(player, entity) {
    if (!entity || !entity.id) return;
    player.chips = player.chips || [];
    // Dedupe — if this entity is already pinned, no-op.
    if (player.chips.some((c) => c.id === entity.id)) return;
    player.chips.push(entity);
    syncPrimaryContext(player);
    renderAllContextChips(player);
    // Pills swap when the primary flips — re-run.
    const container = player.chatPanel.querySelector('._suggestions_1vvl1_226');
    if (container) container.removeAttribute('data-tprm-swapped');
    try { swapEmptyStatePills(player); } catch(e) {}
  }

  function removeContextChip(player, entityId) {
    player.chips = (player.chips || []).filter((c) => c.id !== entityId);
    syncPrimaryContext(player);
    renderAllContextChips(player);
    const container = player.chatPanel.querySelector('._suggestions_1vvl1_226');
    if (container) container.removeAttribute('data-tprm-swapped');
    try { swapEmptyStatePills(player); } catch(e) {}
  }

  /**
   * Render (or re-render) every chip currently on the player. Idempotent:
   * clears any stale chip DOM first, then paints from `player.chips` in
   * order. Uses the bundle's contextChip class so the visual matches a
   * user-picked chip 1:1. Polls the attachments container to appear if
   * it hasn't mounted yet (React sometimes mounts it lazily).
   */
  /**
   * Inject two direct-action icon buttons in the chat header —
   * left of the × close button, replacing the deleted More Actions
   * menu (Reset + Toggle-mode were the only options we cared about,
   * and the menu-popover was causing an unfixable boot-time flash).
   *
   *   [ ⟳ ]  →  reset conversation (calls player.resetToEmptyState)
   *   [ ⇄ ]  →  toggle sidecar ↔ floating (postMessages parent)
   *
   * Buttons use the same Luna .luna-icon+data-icon markup as the
   * chat's native ⋯ icon and inherit the header's white color, so
   * they visually match the existing × button.
   */
  // Legacy alias — the original two-inline-button header (reset + dock
  // toggle) was superseded by the dot-menu implementation in
  // `installHeaderControls`. Boot still calls this name; forward.
  function injectHeaderControls(player) {
    installHeaderControls(player);
  }

  function renderAllContextChips(player) {
    const tryPaint = () => {
      const attachments = player.chatPanel.querySelector('._attachments_1vvl1_1845');
      if (!attachments) return false;
      // Clear existing chips (ours only — leave any bundle chips alone).
      attachments.querySelectorAll('[data-tprm-context-chip]').forEach((el) => el.remove());
      (player.chips || []).forEach((ent) => {
        const shortLabel = ent.short
          || (typeof ent.name === 'string' ? ent.name.split(/[\s.]+/)[0] : null)
          || ent.id;
        const chip = document.createElement('div');
        chip.className = '_contextChip_1vvl1_980';
        chip.setAttribute('data-tprm-context-chip', '1');
        chip.setAttribute('data-tprm-entity-id', ent.id);
        chip.innerHTML = `
          <div class="_contextChipTop_1vvl1_1014">
            <span class="_contextChipIcon_1vvl1_x" aria-hidden="true">${icon(ent.icon || 'building', 12)}</span>
            <span class="_contextChipId_1vvl1_999" title="${escapeHtml(ent.name || ent.id)}">${escapeHtml(shortLabel)}</span>
            <button type="button" class="_contextChipBtn_1vvl1_1032" aria-label="Pin" title="Pin" data-tprm-chip-action="pin">${icon('pin-fill', 10)}</button>
            <button type="button" class="_contextChipBtn_1vvl1_1032" aria-label="Remove" title="Remove" data-tprm-chip-action="remove">${icon('close', 10)}</button>
          </div>`;
        attachments.appendChild(chip);
        chip.querySelector('[data-tprm-chip-action="remove"]').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          removeContextChip(player, ent.id);
        });
        chip.querySelector('[data-tprm-chip-action="pin"]').addEventListener('click', (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
          e.currentTarget.classList.toggle('_contextChipBtnActive_1vvl1_1051');
        });
      });
      return true;
    };
    if (tryPaint()) return;
    // Attachments area may not have mounted yet; poll briefly.
    const iv = window.setInterval(() => {
      if (tryPaint()) window.clearInterval(iv);
    }, 100);
    window.setTimeout(() => window.clearInterval(iv), 5000);
  }

  /**
   * Defense in depth. If ANY unforeseen code path in the bundle
   * manages to append a message to our owned chat list that we didn't
   * emit, this guard immediately removes it. Result: once the user
   * starts a TPRM conversation, the message list is 100% incapable of
   * surfacing GRC content.
   *
   * The guard is installed LAZILY — we don't touch the empty state on
   * boot (that would blank the panel until the user does something).
   * Instead we watch the `_messages_` container for our owned list
   * being created, and start observing it only after it appears.
   *
   * Every message rendered by our Player is stamped with
   * `data-tprm-owned="1"` when it lands. Anything WITHOUT that stamp
   * inside the owned list is bundle content and gets excised.
   */
  function installBundleAppendGuard(player) {
    const messagesEl = player.chatPanel.querySelector('._messages_1vvl1_194');
    if (!messagesEl) return;
    let listObserver = null;
    const startListObserver = (list) => {
      if (listObserver) return;
      listObserver = new MutationObserver((mutations) => {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.hasAttribute && node.hasAttribute('data-tprm-owned')) continue;
            try { node.remove(); } catch (e) {}
          }
        }
      });
      listObserver.observe(list, { childList: true, subtree: false });
    };
    // If the list already exists (rare — only after a reset flow), guard it now.
    const existing = messagesEl.querySelector('[data-tprm-owned="true"]');
    if (existing) startListObserver(existing);
    // Watch for our list appearing later (first user action creates it).
    const containerObserver = new MutationObserver(() => {
      const l = messagesEl.querySelector('[data-tprm-owned="true"]');
      if (l && !listObserver) startListObserver(l);
    });
    containerObserver.observe(messagesEl, { childList: true, subtree: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Parent-injected manifest fallback. When the iframe is loaded from
  // file:// (or any origin where the sibling `./assistant-content-*.json`
  // fetch is blocked), boot() finds the loading promise resolved to null
  // and exits, leaving the compiled bundle's own default UI in place.
  // The parent detects the null-content state and posts the manifest data
  // over here — we replace the loading promise and re-run boot so Player
  // spins up with the TPRM (or default) content, exactly as if the fetch
  // had succeeded on its own.
  window.addEventListener('message', (e) => {
    const msg = e && e.data;
    if (!msg || msg.type !== 'assistant-inject-manifest') return;
    if (!msg.manifest || typeof msg.manifest !== 'object') return;
    // Guard against double-init when the parent posts multiple times
    // (e.g. context updates trigger a re-fire). If a Player already
    // exists, ignore — the manifest is already loaded.
    if (window.__ASSISTANT_PLAYER) return;
    window.__ASSISTANT_CONTENT = msg.manifest;
    window.__ASSISTANT_CONTENT_LOADING = Promise.resolve(msg.manifest);
    boot();
  });
})();
