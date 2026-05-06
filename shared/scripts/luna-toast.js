/**
 * Luna Toast (Growl) — shared helper for AuditBoard prototypes
 *
 * Matches the production Luna React <Growl> component:
 *   libraries/luna-react/package/src/components/growl/
 *
 * In Ember production this is fired via:
 *   this.notifications.show(successNotification('Title', 'Message'));
 *
 * In prototypes, use:
 *   LunaToast.success('Title', 'Message');
 *   LunaToast.error('Title', 'Message');
 *   LunaToast.warning('Title', 'Message');
 *   LunaToast.info('Title', 'Message');
 *   LunaToast.show({ type, title, message, sticky, duration });
 *
 * Defaults:
 *   - Position: top-right
 *   - Auto-dismiss after 7s (sticky: true to disable)
 *   - Variants: success | error | warning | info | broadcast
 *
 * The viewport is created lazily on first call; no setup is required
 * beyond including this script + layout.css.
 */
(function() {
    'use strict';

    var VARIANT_ICONS = {
        success:   'circle-check-fill',
        error:     'circle-important-fill',
        warning:   'warning-fill',
        info:      'circle-info-fill',
        broadcast: 'circle-info-fill'
    };

    var DEFAULT_DURATION_MS = 7000;

    function ensureViewport() {
        var vp = document.querySelector('.luna-growl-viewport');
        if (vp) return vp;
        vp = document.createElement('div');
        vp.className = 'luna-growl-viewport';
        vp.setAttribute('data-component', 'Growl::Viewport');
        vp.setAttribute('aria-live', 'polite');
        vp.setAttribute('aria-atomic', 'true');
        document.body.appendChild(vp);
        return vp;
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function dismiss(el) {
        if (!el || el.dataset.exiting === 'true') return;
        el.dataset.exiting = 'true';
        el.classList.remove('visible');
        el.classList.add('exiting');
        setTimeout(function() {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 320);
    }

    function show(options) {
        options = options || {};
        var type = options.type || 'info';
        if (!VARIANT_ICONS[type]) type = 'info';

        var title = options.title || '';
        var message = options.message || '';
        var sticky = !!options.sticky;
        var duration = typeof options.duration === 'number' ? options.duration : DEFAULT_DURATION_MS;
        var iconName = options.icon || VARIANT_ICONS[type];

        var viewport = ensureViewport();

        var wrap = document.createElement('div');
        wrap.className = 'luna-growl';
        wrap.setAttribute('data-component', 'Growl::Item');
        wrap.setAttribute('data-type', type);
        wrap.setAttribute('role', type === 'error' || type === 'warning' ? 'alert' : 'status');
        wrap.innerHTML =
            '<div class="luna-growl-content">' +
              '<div class="luna-growl-item" data-type="' + type + '">' +
                '<span class="luna-growl-icon" data-type="' + type + '" data-component="Icon">' +
                  '<span class="luna-icon" data-icon="' + iconName + '" data-size="md"></span>' +
                '</span>' +
                '<div class="luna-growl-body">' +
                  (title ? '<h3 class="luna-growl-header luna-heading" data-component="Heading" data-font="200">' + escapeHtml(title) + '</h3>' : '') +
                  (message ? '<p class="luna-growl-message luna-text" data-component="Text" data-font="200">' + escapeHtml(message) + '</p>' : '') +
                '</div>' +
                '<button type="button" class="luna-btn-icon transparent luna-growl-close" data-size="sm" aria-label="Dismiss" data-component="Icon Button">' +
                  '<span class="luna-icon" data-icon="close" data-size="sm"></span>' +
                '</button>' +
              '</div>' +
            '</div>';

        viewport.appendChild(wrap);

        if (typeof window.renderLunaIcons === 'function') {
            window.renderLunaIcons(wrap);
        }

        // Force reflow so the enter transition runs
        void wrap.offsetWidth;
        wrap.classList.add('visible');

        wrap.querySelector('.luna-growl-close').addEventListener('click', function() {
            dismiss(wrap);
        });

        if (!sticky && duration > 0) {
            setTimeout(function() { dismiss(wrap); }, duration);
        }

        return wrap;
    }

    window.LunaToast = {
        show: show,
        success: function(title, message, opts) { return show(Object.assign({ type: 'success', title: title, message: message }, opts || {})); },
        error:   function(title, message, opts) { return show(Object.assign({ type: 'error',   title: title, message: message }, opts || {})); },
        warning: function(title, message, opts) { return show(Object.assign({ type: 'warning', title: title, message: message }, opts || {})); },
        info:    function(title, message, opts) { return show(Object.assign({ type: 'info',    title: title, message: message }, opts || {})); },
        dismiss: dismiss
    };
})();
