// Sets the active left-nav icon based on the sidebar header text.
// Include this script in every prototype (before </body>).
(function() {
    function setActiveModule() {
        var sidebarHeader = document.querySelector('.sidebar-header');
        if (!sidebarHeader) return;
        var moduleName = sidebarHeader.textContent.trim().toLowerCase();
        var moduleMap = {
            'itrm': 'itrm', 'dashboard': 'dashboard', 'controls': 'controls',
            'risk oversight': 'risk-oversight', 'esg': 'esg', 'crosscomply': 'crosscomply',
            'regcomply': 'regcomply', 'opsaudit': 'opsaudit', 'tprm': 'tprm',
            'narratives': 'narratives', 'narratives & reports': 'narratives',
            'reports': 'narratives', 'workstream': 'workstream', 'exceptions': 'exceptions',
            'issues': 'issues', 'automations': 'automations', 'integrations': 'integrations',
            'files': 'files', 'timesheets': 'timesheets', 'settings': 'settings',
            'support': 'support'
        };
        var activeModule = moduleMap[moduleName];
        if (activeModule) {
            document.querySelectorAll('.nav-icon').forEach(function(i) { i.classList.remove('active'); });
            var icon = document.querySelector('.nav-icon[data-module="' + activeModule + '"]');
            if (icon) icon.classList.add('active');
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setActiveModule);
    } else {
        setActiveModule();
    }
})();
