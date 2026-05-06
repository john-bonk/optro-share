/**
 * AI Agent Chat - Shared script for AuditBoard prototypes
 * Injects the AI Assistant icon into the top nav (right of Help, left of avatar)
 * and provides a right-aligned, draggable, resizable chat panel.
 * Use AgentChat.openWithPrompt('text') or data-agent-open="text" on a CTA to open with a pre-filled prompt.
 */
(function() {
    'use strict';

    var panel = null;
    var messagesEl = null;
    var inputEl = null;
    var zeroStateEl = null;
    var isDragging = false;
    var isResizing = false;
    var dragStartX = 0, dragStartY = 0, panelStartX = 0, panelStartY = 0;
    var resizeStartX = 0, resizeStartWidth = 0;

    var AI_ICON_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.49805 0C8.49805 2.18689 9.21707 4.06227 10.5771 5.42285C11.9377 6.78293 13.8131 7.50195 16 7.50195V8.49805C13.8131 8.49805 11.9377 9.21707 10.5771 10.5771C9.21707 11.9377 8.49805 13.8131 8.49805 16H7.50195C7.50195 13.8131 6.78293 11.9377 5.42285 10.5771C4.06227 9.21707 2.18689 8.49805 0 8.49805V7.50195C2.18689 7.50195 4.06227 6.78293 5.42285 5.42285C6.78293 4.06227 7.50195 2.18689 7.50195 0H8.49805ZM7.76562 4.23633C7.76562 5.26545 7.42715 6.14781 6.78711 6.78809C6.14685 7.42802 5.26439 7.7666 4.23535 7.7666V8.23535C5.26436 8.23535 6.14686 8.57397 6.78711 9.21387C7.42712 9.85412 7.7656 10.7365 7.76562 11.7656H8.23535C8.23538 10.7365 8.57385 9.85412 9.21387 9.21387C9.85402 8.57413 10.7359 8.23545 11.7646 8.23535V7.7666C10.7359 7.76651 9.85403 7.42786 9.21387 6.78809C8.57383 6.14781 8.23535 5.26545 8.23535 4.23633H7.76562Z" fill="currentColor"/></svg>';

    function getZeroStateHTML() {
        return (
            '<div class="agent-chat-zero-state">' +
            '  <div class="agent-chat-zero-state-title">AI Assistant</div>' +
            '  <div class="agent-chat-zero-state-text">Ask a question or try one of the suggestions below.</div>' +
            '  <div class="agent-chat-suggestions">' +
            '    <button type="button" class="agent-chat-suggestion-chip" data-prompt="Summarize the risks on this page">Summarize the risks on this page</button>' +
            '    <button type="button" class="agent-chat-suggestion-chip" data-prompt="Find related controls">Find related controls</button>' +
            '    <button type="button" class="agent-chat-suggestion-chip" data-prompt="Suggest improvements">Suggest improvements</button>' +
            '  </div>' +
            '</div>'
        );
    }

    function createPanel() {
        if (panel) return panel;
        var wrap = document.createElement('div');
        wrap.className = 'agent-chat-panel is-hidden';
        wrap.innerHTML =
            '<div class="agent-chat-resize" aria-hidden="true"></div>' +
            '<div class="agent-chat-title-bar">' +
            '  <span>AI Assistant</span>' +
            '  <button type="button" class="agent-chat-close" aria-label="Close">×</button>' +
            '</div>' +
            '<div class="agent-chat-messages"></div>' +
            '<div class="agent-chat-input-wrap">' +
            '  <div class="agent-chat-input-row">' +
            '    <textarea class="agent-chat-input" rows="1" placeholder="Ask a question..." aria-label="Message"></textarea>' +
            '    <button type="button" class="agent-chat-send">Send</button>' +
            '  </div>' +
            '</div>';
        document.body.appendChild(wrap);
        panel = wrap;
        messagesEl = wrap.querySelector('.agent-chat-messages');
        inputEl = wrap.querySelector('.agent-chat-input');
        var titleBar = wrap.querySelector('.agent-chat-title-bar');
        var closeBtn = wrap.querySelector('.agent-chat-close');
        var sendBtn = wrap.querySelector('.agent-chat-send');
        var resizeHandle = wrap.querySelector('.agent-chat-resize');

        closeBtn.addEventListener('click', function() { setOpen(false); });
        sendBtn.addEventListener('click', function() { sendMessage(); });
        inputEl.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        titleBar.addEventListener('mousedown', function(e) {
            if (e.target === closeBtn || closeBtn.contains(e.target)) return;
            isDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            var rect = panel.getBoundingClientRect();
            panelStartX = rect.right - rect.width;
            panelStartY = rect.top;
            panel.style.left = '';
            panel.style.right = '0';
            panel.style.top = panelStartY + 'px';
            panel.style.width = rect.width + 'px';
        });

        resizeHandle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartWidth = panel.getBoundingClientRect().width;
        });

        wrap.querySelector('.agent-chat-suggestions') && wrap.querySelector('.agent-chat-suggestions').addEventListener('click', function(e) {
            var chip = e.target.closest('.agent-chat-suggestion-chip');
            if (chip && chip.dataset.prompt) {
                inputEl.value = chip.dataset.prompt;
                sendMessage();
            }
        });

        document.addEventListener('mousemove', function(e) {
            if (isDragging) {
                var dx = e.clientX - dragStartX;
                var newLeft = panelStartX + dx;
                var maxLeft = window.innerWidth - panel.getBoundingClientRect().width;
                if (newLeft < 0) newLeft = 0;
                if (newLeft > maxLeft) newLeft = maxLeft;
                panel.style.right = '';
                panel.style.left = newLeft + 'px';
            }
            if (isResizing) {
                var dw = resizeStartX - e.clientX;
                var newWidth = resizeStartWidth + dw;
                if (newWidth >= 320 && newWidth <= window.innerWidth - 40) {
                    panel.style.width = newWidth + 'px';
                }
            }
        });
        document.addEventListener('mouseup', function() {
            isDragging = false;
            isResizing = false;
        });

        return panel;
    }

    function showZeroState() {
        if (!messagesEl) return;
        messagesEl.innerHTML = '';
        zeroStateEl = document.createElement('div');
        zeroStateEl.innerHTML = getZeroStateHTML();
        var inner = zeroStateEl.firstElementChild;
        if (inner) {
            messagesEl.appendChild(inner);
            var chips = inner.querySelectorAll('.agent-chat-suggestion-chip');
            chips.forEach(function(chip) {
                chip.addEventListener('click', function() {
                    inputEl.value = chip.dataset.prompt || '';
                    sendMessage();
                });
            });
        }
    }

    function showConversation() {
        if (zeroStateEl && zeroStateEl.parentNode) {
            var z = messagesEl.querySelector('.agent-chat-zero-state');
            if (z) z.remove();
        }
    }

    function addUserMessage(text) {
        showConversation();
        var div = document.createElement('div');
        div.className = 'agent-msg agent-msg-user';
        div.innerHTML = '<div class="agent-msg-bubble">' + escapeHtml(text) + '</div>';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addAssistantMessage(html) {
        showConversation();
        var div = document.createElement('div');
        div.className = 'agent-msg agent-msg-assistant';
        div.innerHTML = '<div class="agent-msg-bubble"><div class="agent-msg-body">' + html + '</div></div>';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function escapeHtml(s) {
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    function sendMessage() {
        var text = (inputEl && inputEl.value && inputEl.value.trim()) || '';
        if (!text) return;
        inputEl.value = '';
        addUserMessage(text);
        addAssistantMessage('<p>This is a prototype. In the full experience, the AI would respond here.</p>');
    }

    function setOpen(open) {
        createPanel();
        if (open) {
            panel.classList.remove('is-hidden');
        } else {
            panel.classList.add('is-hidden');
        }
    }

    function toggle() {
        createPanel();
        var isOpen = !panel.classList.contains('is-hidden');
        setOpen(!isOpen);
        if (!isOpen && !messagesEl.querySelector('.agent-msg')) {
            showZeroState();
        }
    }

    function openWithPrompt(promptText) {
        createPanel();
        setOpen(true);
        messagesEl.innerHTML = '';
        if (promptText && promptText.trim()) {
            var p = promptText.trim();
            inputEl.value = '';
            addUserMessage(p);
            addAssistantMessage('<p>This is a prototype. In the full experience, the AI would respond to: &ldquo;' + escapeHtml(p) + '&rdquo;</p>');
        } else {
            showZeroState();
        }
    }

    function injectIcon() {
        var headerRight = document.querySelector('.header-right');
        var avatar = document.querySelector('.header-avatar');
        if (!headerRight || !avatar || document.querySelector('.header-icon-ai')) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'header-icon header-icon-ai';
        btn.setAttribute('data-tooltip', 'AI Assistant');
        btn.setAttribute('aria-label', 'Open AI Assistant');
        btn.innerHTML = AI_ICON_SVG;
        btn.addEventListener('click', function() { toggle(); });
        var ref = (avatar.parentNode === headerRight) ? avatar : avatar.parentNode;
        headerRight.insertBefore(btn, ref);
    }

    function bindDataAgentOpen() {
        document.addEventListener('click', function(e) {
            var el = e.target.closest('[data-agent-open]');
            if (el && el.dataset.agentOpen) {
                e.preventDefault();
                openWithPrompt(el.dataset.agentOpen);
            }
        });
    }

    function init() {
        injectIcon();
        bindDataAgentOpen();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.AgentChat = {
        openWithPrompt: openWithPrompt,
        toggle: toggle,
        setOpen: setOpen
    };
})();
