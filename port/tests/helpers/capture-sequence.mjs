/**
 * Action semantics for the capture harness and the steps the parity comparison
 * tracks (lane V).
 *
 * WHY THIS EXISTS: the capture harness recorded an action failure as
 * `{ step, actionError }` and then pushed the step's DOM facts as a separate
 * entry, so `trace.json` held 24 entries for 19 steps. The comparison indexed
 * that array by position, which paired step N against an unrelated entry as soon
 * as any action failed — the more broken the run, the more the report drifted
 * from what it claimed to compare. It also skipped an action whenever its
 * selector matched zero elements (`if (await el.count())`), so a renamed button
 * silently stopped being exercised while the step still reported "identical".
 *
 * The rules encoded here:
 *   1. A step is keyed by its stable id, never by array position.
 *   2. `required: true` (the default) means the step's action MUST be
 *      observable. A selector that matches nothing is a failure, not a skip.
 *      `required: false` marks a genuinely optional affordance, and its absence
 *      is recorded as `not-applicable` so a comparison can see it happened.
 *   3. Each step's expected page identity is declared, so "we captured the
 *      wrong page" is detectable rather than indistinguishable from parity.
 */

/**
 * One recorded step outcome. `outcome` is the discriminator the comparison
 * switches on; `actionError` carries the failure text when an action failed.
 *
 * @typedef {object} StepRecord
 * @property {string} step Stable step id.
 * @property {string} label Human-readable description of the state.
 * @property {'captured'|'not-applicable'|'action-error'} outcome
 * @property {string} [actionError] Present when outcome is action-error.
 * @property {object} [dom] Deterministic DOM facts, present when captured.
 * @property {object} [page] Page identity observed at capture time.
 */

/**
 * The capture sequence. Every step declares what it must observe.
 *
 * `expectedPage` is the sidebar surface the step should leave the application
 * on. The capture harness records the observed surface; the comparison refuses
 * to call two steps parity when the reference and the port were looking at
 * different surfaces.
 */
export const SEQUENCE = [
  {
    id: '00-boot',
    label: 'Application boot / loading page',
    expectedPage: 'app',
  },
  {
    id: '01-onboarding-notice',
    label: 'First-run Internal Testing Notice modal',
    expectedPage: 'app',
  },
  {
    id: '02-notice-dismissed',
    label: 'Workspace after dismissing the notice',
    // The first-run notice is shown once per profile. On a profile that has
    // already dismissed it there is no Continue control to click, which is a
    // legitimate not-applicable, not a defect: the step is marked optional and
    // its absence is recorded explicitly instead of being swallowed.
    optional: true,
    click: [
      '#root button:has-text("Save and continue"):not([disabled])',
      '#root button:has-text("Continue"):not([disabled])',
    ],
    expectedPage: 'app',
  },
  {
    id: '03-empty-session',
    label: 'New session / empty state',
    expectedPage: 'app',
  },
  {
    id: '04-focus-composer',
    label: 'Focus the composer',
    focus: ['#root textarea', '#root [contenteditable="true"]'],
    expectedPage: 'app',
  },
  {
    id: '05-composer-typed',
    label: 'Composer with draft text',
    type: 'Hello from the reference capture harness',
    expectedPage: 'app',
  },
  {
    id: '06-mode-menu',
    label: 'Open the permission-mode menu',
    click: [
      '#root button[aria-label^="Access mode"]',
      '#root button:has-text("Workspace Write")',
    ],
    expectedPage: 'app',
  },
  {
    id: '07-mode-dismiss',
    label: 'Dismiss the mode menu',
    press: 'Escape',
    expectedPage: 'app',
  },
  {
    id: '08-model-picker',
    label: 'Open the model picker',
    click: [
      '#root button[aria-label*="model" i]',
      '#root button:has-text("DeepSeek")',
    ],
    expectedPage: 'app',
  },
  {
    id: '09-model-dismiss',
    label: 'Dismiss the model picker',
    press: 'Escape',
    expectedPage: 'app',
  },
  {
    id: '10-plugins-page',
    label: 'Plugins page',
    click: [
      '#root button[aria-label="Plugins"]',
      '#root button:has-text("Plugins")',
      '#root a:has-text("Plugins")',
    ],
    expectedPage: 'plugins',
  },
  {
    id: '11-sidebar-new-session',
    label: 'Back to a new session',
    click: [
      '#root button[aria-label="New session"]',
      '#root button:has-text("New Session")',
    ],
    expectedPage: 'app',
  },
  {
    id: '12-settings-open',
    label: 'Settings surface',
    click: [
      '#root button[aria-label="Settings"]',
      '#root button:has-text("Settings")',
      '#root a:has-text("Settings")',
    ],
    expectedPage: 'settings',
  },
  {
    id: '13-settings-dismiss',
    label: 'Close Settings',
    press: 'Escape',
    expectedPage: 'app',
  },
  {
    id: '14-sidebar-toggle',
    label: 'Toggle the sidebar',
    press: 'Control+B',
    expectedPage: 'app',
  },
  {
    id: '15-sidebar-restore',
    label: 'Restore the sidebar',
    press: 'Control+B',
    expectedPage: 'app',
  },
  {
    id: '16-command-palette',
    label: 'Command palette / slash command hint',
    press: 'Control+K',
    expectedPage: 'app',
  },
  {
    id: '17-palette-dismiss',
    label: 'Dismiss the palette',
    press: 'Escape',
    expectedPage: 'app',
  },
  {
    id: '18-shortcut-hint',
    label: 'New Session shortcut (Ctrl+Alt+N)',
    press: 'Control+Alt+N',
    expectedPage: 'app',
  },
]

/** Step ids in capture order. */
export const STEP_IDS = SEQUENCE.map(step => step.id)

/** Look a step up by id. */
export function stepById(id) {
  return SEQUENCE.find(step => step.id === id)
}

/**
 * Index a capture's recorded steps by their stable id.
 *
 * Duplicate ids (an error entry plus a state entry for the same step) are
 * merged: the error is kept and the DOM facts are attached to it rather than
 * being pushed as a separate positional entry. This is what makes a
 * position-free comparison possible.
 *
 * @param {object|undefined} trace Parsed trace.json.
 * @returns {Map<string, StepRecord>} Steps keyed by id.
 */
export function indexSteps(trace) {
  const index = new Map()
  for (const entry of trace?.trace ?? []) {
    if (typeof entry?.step !== 'string') continue
    const existing = index.get(entry.step) ?? { step: entry.step, label: entry.label ?? '' }
    if (entry.label) existing.label = entry.label
    if (entry.actionError) existing.actionError = entry.actionError
    if (entry.notApplicable) existing.notApplicable = entry.notApplicable
    if (entry.dom) existing.dom = entry.dom
    if (entry.page) existing.page = entry.page
    index.set(entry.step, existing)
  }
  for (const record of index.values()) {
    record.outcome = record.actionError
      ? 'action-error'
      : (record.notApplicable ? 'not-applicable' : (record.dom ? 'captured' : 'incomplete'))
  }
  return index
}

/**
 * The deterministic DOM facts compared for state parity.
 *
 * `textSample` is compared as a normalized value: the two engines differ in
 * trailing whitespace and line-ending handling, which is presentation noise
 * rather than a state difference. Every other fact is compared exactly.
 */
export const TRACKED_FACTS = ['title', 'lang', 'landmarkCount', 'fonts', 'textSample']

/** Facts whose comparison tolerates whitespace normalization. */
export const WHITESPACE_TOLERANT_FACTS = new Set(['textSample'])

/** Normalize a fact value for comparison. */
export function normalizeFact(fact, value) {
  if (WHITESPACE_TOLERANT_FACTS.has(fact) && typeof value === 'string') {
    return value.replace(/\r\n/gu, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim()
  }
  return value
}

/**
 * Compare the tracked DOM facts of two steps.
 *
 * @param {object|undefined} left Reference DOM facts.
 * @param {object|undefined} right Port DOM facts.
 * @returns {string[]} Names of facts that differ.
 */
export function diffFacts(left, right) {
  const differences = []
  for (const fact of TRACKED_FACTS) {
    const a = JSON.stringify(normalizeFact(fact, left?.[fact] ?? null))
    const b = JSON.stringify(normalizeFact(fact, right?.[fact] ?? null))
    if (a !== b) differences.push(fact)
  }
  return differences
}
