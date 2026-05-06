/**
 * Component Overlay System
 *
 * Shows color-coded labels on prototype elements to distinguish Luna design
 * system components from custom CSS builds.
 *
 * Color logic:
 *   BLUE  — element has data-component AND at least one luna-* CSS class
 *           (genuinely implemented with Luna, translates 1:1 to an <Icon>,
 *            <Button>, <Badge>, etc.)
 *   RED   — element has data-component but NO luna-* CSS class
 *           (tagged for translation but custom-built — needs a luna-* class
 *            before it can cleanly translate to Ember)
 *   RED   — element has NO data-component but its class name matches a
 *           component keyword (auto-detected custom build, untagged)
 *   GRAY  — element has data-scaffold="<CompositeName>" (opt-in)
 *           (composite scaffolding that disappears into a higher-order Ember
 *            component like <SchemaTable>. Not Luna, not a gap — structural
 *            HTML that exists only so the prototype visually approximates
 *            the component's output. Auto-detection is suppressed inside
 *            any [data-scaffold] subtree.)
 *
 * Toggle: avatar dropdown "Show Components" or press "\" on the keyboard.
 *
 * Interaction:
 *   - Hover a label pill to highlight it and its parent element
 *   - Click a label pill for details (component name, classes, Luna docs link)
 *   - Legend panel (top-right) shows counts and category toggles
 */

(function() {
    'use strict';

    var componentOverlayActive = false;
    var legendPanel = null;
    var inspectPopup = null;
    var inspectActiveLabel = null;

    // Class-name keywords for auto-detection of untagged custom components
    var COMPONENT_KEYWORDS = /(?:^|[-_])(?:badge|btn|button|card|chip|pill|tag|score|status|indicator|severity|alert|toast|notification|modal|dialog|popup|popover|tooltip|dropdown|menu|tabs|tablist|avatar|spinner|loader|progress|toggle|switch|accordion|banner|notice|pagination|stepper|carousel|slider|input|select|textarea|field|search|filter|table|panel|drawer|divider|separator|empty|breadcrumb|nav|form|checkbox|radio)(?:[-_]|$)/i;

    // Elements inside these selectors are part of the overlay/shell — never auto-detect
    var AUTO_DETECT_IGNORE = '.avatar-dropdown, .avatar-dropdown-menu, .left-nav, .top-header, .sidebar, .component-label, .version-switcher, .co-legend, .co-inspect, .luna-growl-viewport';

    // Luna docs path (relative from a prototype page)
    var LUNA_DOCS_PATH = '../../docs/luna-documentation.html';

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function hasLunaClass(el) {
        for (var i = 0; i < el.classList.length; i++) {
            if (el.classList[i].indexOf('luna-') === 0) return true;
        }
        return false;
    }

    function getLunaClasses(el) {
        var classes = [];
        for (var i = 0; i < el.classList.length; i++) {
            if (el.classList[i].indexOf('luna-') === 0) classes.push(el.classList[i]);
        }
        return classes;
    }

    function ensurePositioned(el) {
        if (window.getComputedStyle(el).position === 'static') {
            el.style.position = 'relative';
        }
    }

    // ─── Label Creation ──────────────────────────────────────────────────────

    // type: 'luna' | 'custom' | 'scaffold'
    function addLabel(el, text, type) {
        if (el.querySelector(':scope > .component-label')) return;
        var label = document.createElement('div');
        var cls = 'component-label';
        if (type === 'custom') cls += ' component-label-custom';
        else if (type === 'scaffold') cls += ' component-label-scaffold';
        label.className = cls;
        label.textContent = text;
        label.setAttribute('data-label-type', type);
        el.setAttribute('data-component-type', type);
        ensurePositioned(el);
        el.appendChild(label);
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    function initComponentOverlay() {
        var avatar = document.querySelector('.header-avatar');
        if (avatar && !avatar.classList.contains('component-overlay-initialized')) {
            setupAvatarDropdown(avatar);
            avatar.classList.add('component-overlay-initialized');
        }

        updateComponentLabels();

        // Keyboard shortcut: "\" toggles overlay (skip when typing)
        document.addEventListener('keydown', function(e) {
            if (e.key !== '\\') return;
            var tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
            e.preventDefault();
            toggleComponentOverlay();
        });

        // Close inspect popup on click outside
        document.addEventListener('click', function(e) {
            if (inspectPopup && !inspectPopup.contains(e.target) && !e.target.classList.contains('component-label')) {
                closeInspectPopup();
            }
        });

        // Close inspect popup on Escape
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && inspectPopup) closeInspectPopup();
        });
    }

    // ─── Avatar Dropdown ──────────────────────────────────────────────────────

    function setupAvatarDropdown(avatar) {
        avatar.style.cursor = 'pointer';
        avatar.setAttribute('role', 'button');
        avatar.setAttribute('tabindex', '0');
        avatar.setAttribute('aria-label', 'User menu');

        var dropdown = document.createElement('div');
        dropdown.className = 'avatar-dropdown-menu';
        dropdown.innerHTML = [
            '<div class="avatar-dropdown-item" data-action="toggle-components">',
            '  <div class="avatar-dropdown-item-icon">',
            '    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">',
            '      <rect x="2" y="2" width="12" height="12" rx="2"/>',
            '      <path d="M6 2v12M10 2v12M2 6h12M2 10h12"/>',
            '    </svg>',
            '  </div>',
            '  <span>Show Components</span>',
            '</div>'
        ].join('\n');

        var wrapper = document.createElement('div');
        wrapper.className = 'avatar-dropdown';
        avatar.parentNode.insertBefore(wrapper, avatar);
        wrapper.appendChild(avatar);
        wrapper.appendChild(dropdown);

        avatar.addEventListener('click', function(e) {
            e.stopPropagation();
            dropdown.classList.toggle('active');
        });

        document.addEventListener('click', function(e) {
            if (!wrapper.contains(e.target)) dropdown.classList.remove('active');
        });

        dropdown.addEventListener('click', function(e) {
            var item = e.target.closest('.avatar-dropdown-item');
            if (item && item.dataset.action === 'toggle-components') {
                toggleComponentOverlay();
                dropdown.classList.remove('active');
            }
        });

        avatar.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); avatar.click(); }
        });
    }

    // ─── Toggle ───────────────────────────────────────────────────────────────

    function toggleComponentOverlay() {
        componentOverlayActive = !componentOverlayActive;
        document.body.classList.toggle('component-overlay-active', componentOverlayActive);

        var menuItem = document.querySelector('[data-action="toggle-components"]');
        if (menuItem) menuItem.classList.toggle('active', componentOverlayActive);

        if (componentOverlayActive) {
            updateComponentLabels();
            setupLabelInteractions();
            showLegend();
        } else {
            clearAutoDetected();
            closeInspectPopup();
            hideLegend();
        }
    }

    // ─── Label Interactions (hover + click) ───────────────────────────────────

    function setupLabelInteractions() {
        document.querySelectorAll('.component-label').forEach(function(label) {
            if (label.dataset.interactive) return;
            label.dataset.interactive = 'true';

            label.addEventListener('mouseenter', function() {
                label.classList.add('component-label-hover');
                label.parentElement.classList.add('component-el-highlight');
            });

            label.addEventListener('mouseleave', function() {
                label.classList.remove('component-label-hover');
                label.parentElement.classList.remove('component-el-highlight');
            });

            label.addEventListener('click', function(e) {
                e.stopPropagation();
                if (inspectActiveLabel === label) {
                    closeInspectPopup();
                } else {
                    openInspectPopup(label);
                }
            });
        });
    }

    // ─── Inspect Popup ────────────────────────────────────────────────────────

    // Map data-component names to Luna docs keys (lowercase, hyphenated)
    function toLunaDocsKey(componentName) {
        // Convert PascalCase/camelCase to lowercase hyphenated: e.g. "DataCard" -> "data-card"
        var key = componentName
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
            .toLowerCase();
        return key;
    }

    function openInspectPopup(label) {
        closeInspectPopup();

        var el = label.parentElement;
        var labelType = label.getAttribute('data-label-type'); // 'luna' | 'custom' | 'scaffold'
        var isLuna = labelType === 'luna';
        var isScaffold = labelType === 'scaffold';
        var componentName = isScaffold
            ? el.getAttribute('data-scaffold')
            : (el.getAttribute('data-component') || el.getAttribute('data-component-auto') || '?');
        var lunaClasses = getLunaClasses(el);
        var allClasses = Array.from(el.classList).filter(function(c) {
            return c !== 'component-el-highlight' && c.indexOf('component-') !== 0;
        });
        var tagName = el.tagName.toLowerCase();

        var popup = document.createElement('div');
        popup.className = 'co-inspect';

        var badgeClass = isLuna ? 'co-inspect-luna'
                        : isScaffold ? 'co-inspect-scaffold'
                        : 'co-inspect-custom';
        var badgeText = isLuna ? 'Luna'
                       : isScaffold ? 'Scaffold'
                       : 'Custom';

        var html = '<div class="co-inspect-header">';
        html += '<span class="co-inspect-badge ' + badgeClass + '">' + badgeText + '</span>';
        html += '<span class="co-inspect-name">' + componentName + '</span>';
        html += '</div>';

        html += '<div class="co-inspect-row"><span class="co-inspect-key">Element</span><code>&lt;' + tagName + '&gt;</code></div>';

        if (lunaClasses.length > 0) {
            html += '<div class="co-inspect-row"><span class="co-inspect-key">Luna classes</span><code>' + lunaClasses.join(' ') + '</code></div>';
        }

        if (allClasses.length > 0) {
            var displayClasses = allClasses.slice(0, 4).join(' ');
            if (allClasses.length > 4) displayClasses += ' +' + (allClasses.length - 4);
            html += '<div class="co-inspect-row"><span class="co-inspect-key">Classes</span><code>' + displayClasses + '</code></div>';
        }

        if (el.hasAttribute('data-component-auto')) {
            html += '<div class="co-inspect-row"><span class="co-inspect-key">Detection</span><span>Auto-detected (no data-component)</span></div>';
        }

        if (isLuna) {
            var docsKey = toLunaDocsKey(componentName);
            html += '<a class="co-inspect-link" href="' + LUNA_DOCS_PATH + '#comp-' + docsKey + '" target="_blank">View ' + componentName + ' in Luna Docs &rarr;</a>';
        } else if (isScaffold) {
            html += '<div class="co-inspect-hint">Composite scaffolding. This element and its children disappear into <code>&lt;' + componentName + '&gt;</code> when translated to Ember — no <code>luna-*</code> class expected.</div>';
        } else {
            html += '<div class="co-inspect-hint">This element should use a <code>luna-*</code> CSS class</div>';
        }

        popup.innerHTML = html;
        document.body.appendChild(popup);

        // Position near the label
        var labelRect = label.getBoundingClientRect();
        var popupWidth = 300;
        var left = labelRect.left;
        var top = labelRect.bottom + 6;

        // Keep on screen
        if (left + popupWidth > window.innerWidth - 16) {
            left = window.innerWidth - popupWidth - 16;
        }
        if (left < 16) left = 16;
        if (top + 200 > window.innerHeight) {
            top = labelRect.top - 6;
            popup.style.transform = 'translateY(-100%)';
        }

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';

        inspectPopup = popup;
        inspectActiveLabel = label;
    }

    function closeInspectPopup() {
        if (inspectPopup) {
            inspectPopup.remove();
            inspectPopup = null;
        }
        inspectActiveLabel = null;
    }

    // ─── Legend Panel ─────────────────────────────────────────────────────────

    function showLegend() {
        if (legendPanel) legendPanel.remove();

        var lunaCount = document.querySelectorAll('[data-component-type="luna"]').length;
        var customCount = document.querySelectorAll('[data-component-type="custom"]').length;
        var scaffoldCount = document.querySelectorAll('[data-component-type="scaffold"]').length;

        var panel = document.createElement('div');
        panel.className = 'co-legend';
        panel.innerHTML = [
            '<div class="co-legend-title">Component Overlay</div>',
            '<label class="co-legend-row" data-filter="luna">',
            '  <input type="checkbox" checked>',
            '  <span class="co-legend-dot co-legend-dot-luna"></span>',
            '  <span class="co-legend-label">Luna Components</span>',
            '  <span class="co-legend-count">' + lunaCount + '</span>',
            '</label>',
            '<label class="co-legend-row" data-filter="custom">',
            '  <input type="checkbox" checked>',
            '  <span class="co-legend-dot co-legend-dot-custom"></span>',
            '  <span class="co-legend-label">Custom / Gaps</span>',
            '  <span class="co-legend-count">' + customCount + '</span>',
            '</label>',
            '<label class="co-legend-row" data-filter="scaffold">',
            '  <input type="checkbox" checked>',
            '  <span class="co-legend-dot co-legend-dot-scaffold"></span>',
            '  <span class="co-legend-label">Composite Scaffolding</span>',
            '  <span class="co-legend-count">' + scaffoldCount + '</span>',
            '</label>',
            '<div class="co-legend-shortcut">Press <kbd>\\</kbd> to toggle</div>'
        ].join('\n');

        // Toggle category visibility
        panel.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
            cb.addEventListener('change', function() {
                var filter = cb.closest('[data-filter]').getAttribute('data-filter');
                document.body.classList.toggle('co-hide-' + filter, !cb.checked);
            });
        });

        document.body.appendChild(panel);
        legendPanel = panel;
    }

    function hideLegend() {
        if (legendPanel) {
            legendPanel.remove();
            legendPanel = null;
        }
        document.body.classList.remove('co-hide-luna', 'co-hide-custom', 'co-hide-scaffold');
    }

    function updateLegendCounts() {
        if (!legendPanel) return;
        var lunaCount = document.querySelectorAll('[data-component-type="luna"]').length;
        var customCount = document.querySelectorAll('[data-component-type="custom"]').length;
        var scaffoldCount = document.querySelectorAll('[data-component-type="scaffold"]').length;
        var counts = legendPanel.querySelectorAll('.co-legend-count');
        if (counts[0]) counts[0].textContent = lunaCount;
        if (counts[1]) counts[1].textContent = customCount;
        if (counts[2]) counts[2].textContent = scaffoldCount;
    }

    // ─── Auto-Detection ───────────────────────────────────────────────────────

    function autoDetectCustomComponents() {
        var allElements = document.querySelectorAll('.content [class], .modal-overlay [class], .quick-view [class], [class*="drawer"] [class], [class*="panel"] [class]');

        allElements.forEach(function(el) {
            if (el.hasAttribute('data-component') || el.hasAttribute('data-component-auto')) return;
            if (el.closest(AUTO_DETECT_IGNORE)) return;
            // Skip auto-detection inside composite scaffolding — its internals
            // are structural HTML that disappears into the Ember composite.
            if (el.closest('[data-scaffold]')) return;
            if (hasLunaClass(el)) return;

            var matchedClass = null;
            for (var j = 0; j < el.classList.length; j++) {
                if (COMPONENT_KEYWORDS.test(el.classList[j])) {
                    matchedClass = el.classList[j];
                    break;
                }
            }
            if (!matchedClass) return;
            el.setAttribute('data-component-auto', matchedClass);
        });
    }

    function clearAutoDetected() {
        document.querySelectorAll('[data-component-auto]').forEach(function(el) {
            var label = el.querySelector(':scope > .component-label');
            if (label) label.remove();
            el.removeAttribute('data-component-auto');
            el.removeAttribute('data-component-type');
            el.classList.remove('component-el-highlight');
        });
    }

    // ─── Label Rendering ──────────────────────────────────────────────────────

    function updateComponentLabels() {
        if (!componentOverlayActive) return;

        autoDetectCustomComponents();

        // 1. Scaffold roots (gray) — opt-in via data-scaffold
        document.querySelectorAll('[data-scaffold]').forEach(function(el) {
            if (el.querySelector(':scope > .component-label')) return;
            var name = el.getAttribute('data-scaffold');
            addLabel(el, name, 'scaffold');
        });

        // 2. data-component elements (blue if luna, red otherwise). Skip
        //    elements that are themselves marked as scaffold. Inside a
        //    scaffold, only Luna atomics still render — structural tagged
        //    containers (e.g. `.st-filter-bar data-component="XStack"`) are
        //    part of the composite and stay hidden.
        document.querySelectorAll('[data-component]').forEach(function(el) {
            if (el.hasAttribute('data-scaffold')) return;
            if (el.querySelector(':scope > .component-label')) return;
            if (el.closest('.luna-growl-viewport')) return; // toasts are ephemeral — don't decorate
            var isLuna = hasLunaClass(el);
            if (!isLuna && el.closest('[data-scaffold]')) return;
            var name = el.getAttribute('data-component');
            addLabel(el, name, isLuna ? 'luna' : 'custom');
        });

        // 3. Auto-detected customs (red)
        document.querySelectorAll('[data-component-auto]').forEach(function(el) {
            if (el.querySelector(':scope > .component-label')) return;
            addLabel(el, el.getAttribute('data-component-auto'), 'custom');
        });

        setupLabelInteractions();
        updateLegendCounts();
    }

    // ─── Version Switcher ─────────────────────────────────────────────────────

    function initVersionSwitcher() {
        var meta = document.querySelector('meta[name="prototype-versions"]');
        if (!meta) return;

        var versions = meta.getAttribute('content')
            .split(',')
            .map(function(s) { return s.trim(); })
            .filter(Boolean);

        if (versions.length < 2) return;

        var currentFile = window.location.pathname.split('/').pop() || 'index.html';

        var switcher = document.createElement('div');
        switcher.className = 'version-switcher';
        switcher.setAttribute('role', 'navigation');
        switcher.setAttribute('aria-label', 'Prototype versions');

        var label = document.createElement('span');
        label.className = 'version-switcher-label';
        label.textContent = 'Version';
        switcher.appendChild(label);

        versions.forEach(function(filename, index) {
            var isCurrent = filename === currentFile;
            var link = document.createElement('a');
            link.href = filename;
            link.className = 'version-switcher-item' + (isCurrent ? ' active' : '');
            link.textContent = 'v' + (index + 1);
            link.setAttribute('title', filename);
            if (isCurrent) link.setAttribute('aria-current', 'page');
            switcher.appendChild(link);
        });

        var header = document.querySelector('.top-header, header.top-header, [class*="top-header"]');
        var avatar = header && header.querySelector('.header-avatar, .avatar-dropdown');
        if (header && avatar) {
            header.insertBefore(switcher, avatar.closest('.avatar-dropdown') || avatar);
        } else if (header) {
            header.appendChild(switcher);
        }

        if (!document.getElementById('version-switcher-styles')) {
            var style = document.createElement('style');
            style.id = 'version-switcher-styles';
            style.textContent = [
                '.version-switcher { display:flex; align-items:center; gap:0.25rem; margin-left:auto; margin-right:0.75rem; padding:0.25rem 0.5rem; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:6px; }',
                '.version-switcher-label { font-size:0.6875rem; font-weight:500; color:rgba(255,255,255,0.45); margin-right:0.25rem; white-space:nowrap; }',
                '.version-switcher-item { font-size:0.6875rem; font-weight:600; color:rgba(255,255,255,0.55); text-decoration:none; padding:0.125rem 0.375rem; border-radius:4px; transition:background 0.12s, color 0.12s; }',
                '.version-switcher-item:hover { background:rgba(255,255,255,0.12); color:rgba(255,255,255,0.9); }',
                '.version-switcher-item.active { background:rgba(255,255,255,0.15); color:#ffffff; }'
            ].join('\n');
            document.head.appendChild(style);
        }
    }

    // ─── Bootstrap ────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            initComponentOverlay();
            initVersionSwitcher();
        });
    } else {
        initComponentOverlay();
        initVersionSwitcher();
    }

    // Re-label when dynamic content is added
    var observer = new MutationObserver(function(mutations) {
        if (!componentOverlayActive) return;
        var shouldUpdate = false;
        mutations.forEach(function(mutation) {
            if (mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1 && !node.classList.contains('co-legend') &&
                        !node.classList.contains('co-inspect') && !node.classList.contains('component-label')) {
                        shouldUpdate = true;
                    }
                });
            }
        });
        if (shouldUpdate) updateComponentLabels();
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();
