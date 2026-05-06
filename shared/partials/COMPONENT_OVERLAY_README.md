# Component Overlay System

A QA tool built into every prototype that color-codes UI elements to show which ones genuinely use Luna design system components and which are custom CSS builds.

## How to Toggle

- **Keyboard:** Press `\` (backslash) anywhere on the page (ignored when typing in a text field)
- **Avatar menu:** Click the avatar in the top-right corner, then click "Show Components"

## Color Meanings

| Color | Condition | What it tells you |
|-------|-----------|-------------------|
| **Blue** | Element has `data-component` AND a `luna-*` CSS class | Genuinely implemented with Luna — ready for Ember translation |
| **Red** | Element has `data-component` but NO `luna-*` CSS class | Tagged for translation but custom-built — needs Luna adoption |
| **Red** | No `data-component`, but CSS class name matches a component keyword | Auto-detected custom build with no translation tag — a gap |

## How Classification Works

The overlay does NOT check the `data-component` name against a hardcoded list. Instead, it inspects the element's actual CSS classes:

```
element has luna-* class?
  ├── YES → BLUE (genuinely Luna)
  └── NO
       ├── has data-component? → RED (tagged but custom)
       └── class matches keyword? → RED (auto-detected, untagged)
```

This means `<div class="my-card" data-component="Card">` shows **red** because despite being tagged as a Card, it doesn't use `luna-block`, `luna-data-card`, or any other `luna-*` class.

## Auto-Detection

The overlay automatically scans the `.content` area for elements whose CSS class names contain component-like keywords but have no `luna-*` class and no `data-component` tag. These are highlighted in red with their CSS class name as the label.

**Keywords that trigger detection:** `badge`, `btn`, `button`, `card`, `chip`, `pill`, `tag`, `score`, `status`, `indicator`, `severity`, `alert`, `toast`, `notification`, `modal`, `dialog`, `popup`, `popover`, `tooltip`, `dropdown`, `menu`, `tabs`, `tablist`, `avatar`, `spinner`, `loader`, `progress`, `toggle`, `switch`, `accordion`, `banner`, `notice`, `pagination`, `stepper`, `carousel`, `slider`, `input`, `select`, `textarea`, `field`, `search`, `filter`, `table`, `panel`, `drawer`, `divider`, `separator`, `empty`, `breadcrumb`, `nav`, `form`, `checkbox`, `radio`.

Keywords must appear as a full hyphenated segment (e.g., `threat-score-badge` matches but `badger-widget` does not).

**Ignored areas:** Left nav, top header, sidebar, avatar dropdown, version switcher.

## Required Files

Include in every prototype:

```html
<head>
    <link rel="stylesheet" href="../shared/styles/component-overlay.css">
</head>
<body>
    <!-- ... content ... -->
    <script src="../shared/scripts/component-overlay.js"></script>
</body>
```

## Examples

```html
<!-- BLUE: genuinely Luna -->
<span class="luna-badge green weak" data-component="Badge">Active</span>
<button class="luna-btn" data-component="Button">Save</button>
<span class="luna-icon" data-icon="search" data-component="Icon"></span>

<!-- RED: tagged but custom-built -->
<div class="threat-brief-card" data-component="Card">...</div>
<div class="qv-tabs" data-component="Tablist">...</div>
<div class="ai-chat-input" data-component="Input">...</div>

<!-- RED: auto-detected (no data-component at all) -->
<span class="threat-score-badge critical">82</span>
<div class="hub-breadcrumb">Cyber Risk Management</div>
```

## Hover Behavior

When the overlay is active, hovering over an element highlights the most specific (deepest nested) component. The label becomes more prominent and the element gets a tinted outline matching its color (blue or red).

## Best Practices

1. **Use Luna classes** (`luna-badge`, `luna-btn`, `luna-input`, etc.) whenever a Luna component exists for the pattern
2. **Add `data-component`** to all major UI elements, even custom ones — this documents what they should become in Ember
3. **Check the overlay** before finalizing a prototype to catch gaps in Luna adoption
4. **Fix red labels** where possible by switching from custom CSS to the equivalent `luna-*` class from `layout.css`
