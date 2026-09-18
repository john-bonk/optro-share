// ────────────────────────────────────────────────────────────────────
// MVP-mode spec for tprm-workflow/v04.
//
// Add an ID to `regions` below to hide any element tagged with
//   data-mvp-region="that-id"
// when MVP mode is toggled ON (via the top-right avatar dropdown).
//
// Edit this file → reload the browser. No build step.
// ────────────────────────────────────────────────────────────────────

window.MVP_CONFIG = {
    // ── Lifecycle overrides ─────────────────────────────────────────────
    // Baseline lifecycle (Vendor Intake · Inherent Risk · Due Diligence
    // · Monitoring) stays intact; entries below apply on top in MVP mode.
    //
    // Phase names to match: 'Vendor Intake' | 'Inherent Risk'
    //                    | 'Due Diligence' | 'Monitoring'
    //
    // Substep matching: `phase` + a substring `match` against the current
    // substep name (case-sensitive). First match wins.
    //
    // Override fields on a substep:
    //   name    — replace the substep name
    //   type    — 'agentic' | 'automated' | 'hitl'
    //   actions — array of action-label strings (HITL only)
    //   detail  — plain-text one-liner (replaces the substep render)
    //
    // Example (uncomment to try):
    //   hidePhases:      ['Monitoring'],
    //   hideSubsteps:    [{ phase: 'Vendor Intake', match: 'Parse attached evidence' }],
    //   overrideSubsteps:[
    //     { phase: 'Inherent Risk', match: 'Surface tier recommendation',
    //       name: 'AI proposes a risk tier', detail: 'Suggested Tier 2 · 87% confidence.' },
    //   ],
    lifecycle: {
        hidePhases: [],
        hideSubsteps: [
            // Inherent Risk 2.4–2.7 — hide the sanctions / cyber-score /
            // adverse-news / reconciliation substeps for a leaner MVP loop.
            { phase: 'Inherent Risk', match: 'Query sanctions and watchlist' },
            { phase: 'Inherent Risk', match: 'Retrieve cyber risk posture' },
            { phase: 'Inherent Risk', match: 'Pull adverse news' },
            { phase: 'Inherent Risk', match: 'Reconcile signals across sources' },
            // Monitoring — MVP keeps only Schedule + Track expirations.
            // Every other Monitoring substep is hidden; there is no
            // continuous-monitoring stand-in step (removed).
            { phase: 'Monitoring', match: 'Poll external threat intelligence feeds' },
            { phase: 'Monitoring', match: 'Detect cyber posture drift' },
            { phase: 'Monitoring', match: 'Monitor for adverse news' },
            { phase: 'Monitoring', match: 'Trigger tier re-evaluation' },
            { phase: 'Monitoring', match: 'Surface escalation triggers' },
        ],
        overrideSubsteps: [
            // MVP 4.1 — rename the cadence step so it reads as the top-level
            // recurring-assessment trigger, not a monitoring-specific action.
            { phase: 'Monitoring', match: 'Schedule monitoring cadence',
              name: 'Schedule recurring assessment' },
        ],
    },

    // IDs of regions to hide in MVP mode. Uncomment / add entries below.
    regions: [
        // ── Sidebar (whole sections or individual items) ──
        // 'sidebar-vendor-management',
        'sidebar-inventory',
        'sidebar-assessments',
        // 'sidebar-administration',
        // 'sidebar-item-third-parties',
        // 'sidebar-item-inbox',
        'sidebar-item-watchlist',
        'sidebar-item-risk-register',
        // 'sidebar-item-vendor-catalog',
        // 'sidebar-item-contracts',
        // 'sidebar-item-documents',
        // 'sidebar-item-questionnaire-library',
        // 'sidebar-item-active-assessments',
        // 'sidebar-item-reports',
        // 'sidebar-item-settings',

        // ── Top header (right side) ──
        'header-optroflow-hub',
        // 'header-optro-assistant',
        // 'header-messages',
        // 'header-notifications',
        // 'header-help',

        // ── Vendor Detail tabs (Acme, etc.) ──
        // 'vendor-tab-overview',
        // 'vendor-tab-profile',
        // 'vendor-tab-lifecycle',
        // 'vendor-tab-documents',
        // 'vendor-tab-assessments',
        // 'vendor-tab-reports',
        // 'vendor-tab-intelligence',  // Enabled in MVP — routes to the Watchtower variant
        // 'vendor-tab-issues',
        // 'vendor-tab-relationships',
        'vendor-tab-contracts',

        // ── Settings tabs + version-dropdown items ──
        // 'settings-tab-general',
        // 'settings-tab-documenttypes',
        'settings-tab-automation',
        // 'settings-version-v1',
        // 'settings-version-v2',
        // 'settings-version-v3',
        // 'settings-version-v4',

        // ── V4 settings blocks ──
        // 'v4-summary-banner',
        // 'v4-policy-docs',
        // 'v4-tiering-rules',
        // 'v4-tier-baseline',
        // 'v4-additional-datapoints',
        // 'v4-reassessment-cadence',
        // Tier-baseline gap chrome: the aggregate "N missing" pill in the
        // block header, the per-tier "N missing" chip, the dashed
        // gap-stub rows inside each tier list, and the inline "· N
        // missing" fragment in each subhdr count. Hidden in MVP.
        'v4-tier-gaps',

        // ── Banners / misc ──
        'contract-deltas-banner',       // Profile-tab contract deltas + update workflow
        'documents-context-banner',     // Documents-tab context banner (contract file itself stays in the list)
        'assessments-context-banner',   // Assessments-tab dynamic banner (all workflow states)
        'vendor-history-footer',        // Bottom "Vendor History" footer on Lifecycle + Assessments tabs

        // ── Vendors list page ──
        'vendors-full-auto-toggle',
        'vendors-engage-all',
    ],
};
