#!/usr/bin/env node
/**
 * Semantic-color sweep for SPX frontend.
 *
 * Maps the legacy rainbow palette (cyan / emerald / amber / rose / violet)
 * to the semantic tokens defined in `src/frontend/index.css`:
 *   cyan    → info
 *   emerald → success
 *   amber   → warning
 *   rose    → danger
 *   red     → danger
 *   violet  → primary
 *   slate-200/300 → foreground
 *   white text → foreground (text-white only)
 *
 * Conservative: only replaces fragments that look like Tailwind class atoms.
 * Run from repo root: `node scripts/sweep-semantic-colors.mjs`
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const TARGETS = [
    'src/frontend/routes/settings.tsx',
    'src/frontend/routes/login.tsx',
    'src/frontend/routes/line-bot.tsx',
    'src/frontend/routes/line-image-extractions.tsx',
    'src/frontend/routes/auto-accept-history.tsx',
    'src/frontend/components/CreateRuleDialog.tsx',
    'src/frontend/components/EditRuleDialog.tsx',
    'src/frontend/components/RulePreviewDialog.tsx',
    'src/frontend/components/DeleteConfirmDialog.tsx',
    'src/frontend/components/VehicleTypeMultiSelect.tsx',
    'src/frontend/components/SettingsLineBotSection.tsx',
]

// Order matters: longest / most specific first.
// Each entry: [regex, replacement].
const RULES = [
    // Borders + soft fills (most common rainbow pattern: border-X/{10|20|22|30|40|60} bg-X/{5|10})
    [/border-cyan-(?:200|300|400)\/(?:10|20|22|30|40|60)\b/g, 'border-[color:var(--color-info-border)]'],
    [/border-emerald-(?:200|300|400)\/(?:10|20|22|30|40|60)\b/g, 'border-[color:var(--color-success-border)]'],
    [/border-amber-(?:200|300|400)\/(?:10|20|22|30|40|60)\b/g, 'border-[color:var(--color-warning-border)]'],
    [/border-(?:rose|red)-(?:200|300|400|500)\/(?:10|20|22|30|40|60)\b/g, 'border-[color:var(--color-danger-border)]'],
    [/border-violet-(?:200|300|400)\/(?:10|20|22|30|40|60)\b/g, 'border-primary/22'],

    [/bg-cyan-(?:200|300|400)\/(?:5|10|15|20|22)\b/g, 'bg-[color:var(--color-info-soft)]'],
    [/bg-emerald-(?:200|300|400)\/(?:5|10|15|20|22)\b/g, 'bg-[color:var(--color-success-soft)]'],
    [/bg-amber-(?:200|300|400)\/(?:5|10|15|20|22)\b/g, 'bg-[color:var(--color-warning-soft)]'],
    [/bg-(?:rose|red)-(?:200|300|400|500)\/(?:5|10|15|20|22)\b/g, 'bg-[color:var(--color-danger-soft)]'],
    [/bg-violet-(?:200|300|400)\/(?:5|10|15|20|22)\b/g, 'bg-primary/10'],

    // Text
    [/text-cyan-(?:200|300|400)\b/g, 'text-info'],
    [/text-emerald-(?:200|300|400)\b/g, 'text-success'],
    [/text-amber-(?:200|300|400|100|100\/70)\b/g, 'text-warning'],
    [/text-(?:rose|red)-(?:200|300|400|500)\b/g, 'text-danger'],
    [/text-violet-(?:200|300|400)\b/g, 'text-primary'],

    // Slate body text → foreground / muted
    [/text-slate-(?:200|300)\b/g, 'text-foreground'],

    // text-white in our dark theme is just foreground
    [/text-white\b/g, 'text-foreground'],
]

let changed = 0
let totalRepl = 0
for (const rel of TARGETS) {
    const path = join(ROOT, rel)
    if (!existsSync(path)) {
        console.warn(`[skip] missing: ${rel}`)
        continue
    }
    const before = readFileSync(path, 'utf8')
    let after = before
    let fileRepl = 0
    for (const [pattern, replacement] of RULES) {
        after = after.replace(pattern, (m) => {
            fileRepl++
            totalRepl++
            return typeof replacement === 'function' ? replacement(m) : replacement
        })
    }
    if (after !== before) {
        writeFileSync(path, after, 'utf8')
        changed++
        console.log(`[ok] ${rel}: ${fileRepl} replacements`)
    } else {
        console.log(`[--] ${rel}: no changes`)
    }
}

console.log(`\nDone. ${changed} files updated, ${totalRepl} total replacements.`)
