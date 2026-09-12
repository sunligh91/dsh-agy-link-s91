import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coerceSetting, humanMs, planSettings, settingByKey, SETTINGS } from '../src/common/settings-schema.ts'
import { defaultConfig } from '../src/common/types.ts'
import { resolveConfig } from '../src/common/config.ts'

test('every setting key exists on the config and matches its declared type', () => {
  // The panel renders straight from this list and the host writes straight into
  // PluginConfig, so a typo here would produce a control that silently does
  // nothing. Assert the linkage rather than trusting it.
  const cfg = defaultConfig() as unknown as Record<string, unknown>
  for (const def of SETTINGS) {
    assert.ok(def.key in cfg, 'SETTINGS key not present on PluginConfig: ' + def.key)
    const expected = def.kind === 'boolean' ? 'boolean' : def.kind === 'number' ? 'number' : 'string'
    assert.equal(typeof cfg[def.key], expected, def.key + ' default type mismatch')
    assert.ok(def.label.length > 0, def.key + ' needs a label')
    assert.ok(def.description.length > 20, def.key + ' needs a real description')
  }
})

test('no duplicate keys and every key is settable through the /config endpoint path', () => {
  const seen = new Set<string>()
  for (const def of SETTINGS) {
    assert.equal(seen.has(def.key), false, 'duplicate setting key: ' + def.key)
    seen.add(def.key)
    assert.notEqual(settingByKey(def.key), undefined)
  }
  assert.equal(settingByKey('definitely-not-a-key'), undefined)
})

test('enum settings declare options and their defaults are valid members', () => {
  const cfg = defaultConfig() as unknown as Record<string, unknown>
  for (const def of SETTINGS.filter((s) => s.kind === 'enum')) {
    assert.ok(def.options !== undefined && def.options.length > 0, def.key + ' must list options')
    const values = def.options?.map((o) => o.value) ?? []
    assert.ok(values.includes(String(cfg[def.key] ?? '')), def.key + ' default must be one of its options')
  }
})

test('number settings declare sane bounds that contain the default', () => {
  const cfg = defaultConfig() as unknown as Record<string, unknown>
  for (const def of SETTINGS.filter((s) => s.kind === 'number')) {
    const v = cfg[def.key] as number
    if (def.min !== undefined) assert.ok(v >= def.min, def.key + ' default below min')
    if (def.max !== undefined) assert.ok(v <= def.max, def.key + ' default above max')
    if (def.min !== undefined && def.max !== undefined) assert.ok(def.min < def.max, def.key + ' min must be < max')
  }
})

test('the watchdog and salvage options are all exposed to the panel', () => {
  // Regression guard for the feature this panel was built for: these must be
  // editable without touching a config file.
  for (const key of ['timeoutMs', 'salvageAnswers', 'salvagePollMs', 'salvageIdleMs', 'salvageMinChars']) {
    const def = settingByKey(key)
    assert.ok(def !== undefined, key + ' must be settable from the panel')
    assert.equal(def?.group, 'watchdog')
  }
})

test('the everyday watchdog controls are visible without unfolding anything', () => {
  // The main area must answer "why did my run die, and can I stop it dying
  // again?" on its own: the timeout and the salvage switch. The fine-tuning
  // numbers (poll interval, silence threshold, minimum length) legitimately live
  // behind the 高级选项 fold, so they are NOT asserted here.
  for (const key of ['timeoutMs', 'salvageAnswers']) {
    const def = settingByKey(key)
    assert.ok(def !== undefined, key + ' missing')
    assert.notEqual(def?.advanced, true, key + ' must stay in the main panel')
  }
})

test('the advanced fold contains the salvage fine-tuning knobs', () => {
  // A corollary of the test above: these are reachable, just folded. Keeping them
  // asserted makes sure a rename or a copy/paste cannot silently orphan them.
  for (const key of ['salvagePollMs', 'salvageIdleMs', 'salvageMinChars']) {
    const def = settingByKey(key)
    assert.ok(def !== undefined, key + ' missing')
    assert.equal(def?.advanced, true, key + ' is expected to sit behind the fold')
  }
})

test('every setting renders EXACTLY once: never duplicated, never dropped', () => {
  // The invariant the first panel got wrong, and the reason this test replaces a
  // count-only check that happily passed while 8 options rendered twice and 4
  // rendered nowhere. Counting CANNOT catch duplication: main+fold still summed
  // to SETTINGS.length when an option appeared in both. Assert placement instead.
  const { groups, fold } = planSettings()
  const placed = new Map<string, string[]>()
  const add = (key: string, where: string): void => {
    if (!placed.has(key)) placed.set(key, [])
    placed.get(key)?.push(where)
  }
  for (const g of groups) for (const s of g.items) add(s.key, g.title)
  for (const s of fold) add(s.key, 'advanced fold')

  const duplicated = [...placed.entries()].filter(([, where]) => where.length > 1)
  assert.deepEqual(duplicated, [], 'no option may render more than once: ' + JSON.stringify(duplicated))

  const dropped = SETTINGS.filter((s) => !placed.has(s.key)).map((s) => s.key)
  assert.deepEqual(dropped, [], 'no option may be missing from the panel: ' + JSON.stringify(dropped))

  assert.equal(placed.size, SETTINGS.length, 'the plan must cover every setting exactly once')
})

test('a section never repeats what the fold already shows', () => {
  const { groups, fold } = planSettings()
  for (const g of groups) {
    for (const item of g.items) {
      assert.notEqual(item.advanced, true, item.key + ' is advanced and must not appear in section ' + g.id)
    }
  }
  const expected = SETTINGS.filter((s) => s.advanced === true).map((s) => s.key).sort()
  assert.deepEqual(fold.map((s) => s.key).sort(), expected, 'the fold must hold exactly the advanced options')
})

test('the everyday controls are main-panel and the fine-tuning knobs are folded', () => {
  const { groups, fold } = planSettings()
  // Widen to string: SettingDef['key'] is a union of literal keys, so a plain
  // Set would reject the string lookups below.
  const inMain = new Set<string>(groups.flatMap((g) => g.items.map((s) => s.key)))
  const inFold = new Set<string>(fold.map((s) => s.key))
  for (const key of ['timeoutMs', 'salvageAnswers', 'permissionMode', 'defaultEffort', 'workspaceRoot', 'defaultModel']) {
    assert.ok(inMain.has(key), key + ' must be visible in the main panel')
  }
  for (const key of ['salvagePollMs', 'salvageIdleMs', 'salvageMinChars']) {
    assert.ok(inFold.has(key), key + ' is a fine-tuning knob and belongs in the fold')
  }
})

test('every setting is reachable: no key is both advanced-hidden and unlabelled', () => {
  // A cheap coherence check over the whole schema, so a future option cannot be
  // added in a state the panel would render uselessly.
  for (const def of SETTINGS) {
    assert.ok(def.label.length > 0, def.key + ' needs a label')
    assert.ok(def.description.length > 20, def.key + ' needs a real description')
    if (def.kind === 'number') {
      assert.ok(def.min !== undefined && def.max !== undefined, def.key + ' numeric option needs bounds')
    }
    if (def.kind === 'enum') {
      assert.ok(def.options !== undefined && def.options.length > 0, def.key + ' enum option needs choices')
    }
  }
})

test('coerceSetting accepts good values and rejects bad ones', () => {
  const timeout = settingByKey('timeoutMs')
  assert.ok(timeout)
  assert.deepEqual(coerceSetting(timeout!, 300_000), { ok: true, value: 300_000 })
  assert.deepEqual(coerceSetting(timeout!, '300000'), { ok: true, value: 300_000 })
  assert.equal(coerceSetting(timeout!, 1).ok, false, 'below min must be rejected')
  assert.equal(coerceSetting(timeout!, 99_999_999).ok, false, 'above max must be rejected')
  assert.equal(coerceSetting(timeout!, 'abc').ok, false, 'non-numeric must be rejected')

  const salv = settingByKey('salvageAnswers')
  assert.ok(salv)
  assert.deepEqual(coerceSetting(salv!, true), { ok: true, value: true })
  assert.deepEqual(coerceSetting(salv!, 'false'), { ok: true, value: false })
  assert.equal(coerceSetting(salv!, 'nope').ok, false)

  const perm = settingByKey('permissionMode')
  assert.ok(perm)
  assert.deepEqual(coerceSetting(perm!, 'plan'), { ok: true, value: 'plan' })
  assert.equal(coerceSetting(perm!, 'yolo').ok, false, 'unknown enum member must be rejected')
})

test('settings the panel can write are honoured by resolveConfig', () => {
  // End-to-end through the real config layer: an override written by the panel
  // must come back out as the effective value.
  const cfg = resolveConfig(undefined, {} as NodeJS.ProcessEnv, {
    timeoutMs: 300_000,
    salvageAnswers: false,
    salvageIdleMs: 5_000,
  })
  assert.equal(cfg.timeoutMs, 300_000)
  assert.equal(cfg.salvageAnswers, false)
  assert.equal(cfg.salvageIdleMs, 5_000)
})

test('an env var still outranks an override (the panel reports this)', () => {
  const cfg = resolveConfig(undefined, { DSH_AGY_TIMEOUT_MS: '123456' } as NodeJS.ProcessEnv, { timeoutMs: 300_000 })
  assert.equal(cfg.timeoutMs, 123456)
})

test('humanMs renders readable durations', () => {
  assert.equal(humanMs(500), '500 毫秒')
  assert.equal(humanMs(1000), '1 秒')
  assert.equal(humanMs(45_000), '45 秒')
  assert.equal(humanMs(60_000), '1 分钟')
  assert.equal(humanMs(600_000), '10 分钟')
  assert.equal(humanMs(3_600_000), '1 小时')
})
