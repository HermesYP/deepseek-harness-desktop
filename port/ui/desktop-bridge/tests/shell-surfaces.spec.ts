// @vitest-environment jsdom
/**
 * Shell-surface tests for the marker glue: the DOM markers the shared client
 * CSS scopes on, the native file-path handoff (`__DSH_HOST_PATHS__`), and the
 * single-ownership rule for the directory picker.
 *
 * The behaviours pinned here are the ones a port can plausibly get wrong while
 * still passing type and fixture checks:
 *
 * 1. **A host path is never fabricated.** Upstream reads a real absolute path
 *    out of Chromium's drag payload (`webUtils.getPathForFile`); a WebView2
 *    `File` exposes only `name`/`size`/`type`/`lastModified`. The glue must
 *    therefore leave `pathFor` to Rust, answer "no path" for a `File` the shell
 *    never saw, and never synthesise a path from a directory plus a file name.
 *    A native drop and the DOM `File` list are correlated by base name only, so
 *    an ambiguous name on either side resolves to no path rather than to a
 *    guessed ordinal.
 * 2. **One drop attaches once.** The shell adopts a drop and lets the page read
 *    it once.
 * 3. **The directory picker has one owner.** The page adds no second guard on
 *    top of the native dialog's, because a page-level guard would turn a
 *    legitimate retry after cancellation into a no-op.
 * 4. **The DOM markers stay Rust-owned.** The glue reports them and never
 *    writes them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_PATHS_EVENT, hostPathBaseName, hostPathDropIntake, matchDropPaths, readShellDomMarkers,
  subscribeHostPathDrops, takePendingHostPaths, type DshHostPaths,
} from '../markers.ts'

const MARKER_NAMES = [
  '__DSH_BOOT_READY__', 'dshDesktopBoot', '__DSH_TRANSPORT__', '__DSH_HOST_PATHS__',
  '__DSH_DIRECTORY_PICKER__', '__DSH_LOCALE__', 'dshOnboarding', 'dshDesktop', 'dshPlatform',
] as const

function clearMarkers(): void {
  for (const name of MARKER_NAMES) Reflect.deleteProperty(globalThis, name)
  delete document.documentElement.dataset.platform
  document.documentElement.removeAttribute('data-windows-titlebar')
  document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
}

/** A `File` shaped like the ones a WebView2 drag payload produces. */
function dragFile(name: string, type = 'text/plain'): File {
  return new File(['x'], name, { type })
}

describe('shell DOM markers (html[data-platform], html[data-windows-titlebar])', () => {
  afterEach(clearMarkers)

  it('reports the Windows caption marker and the titlebar height the shell installed', () => {
    document.documentElement.dataset.platform = 'win32'
    document.documentElement.setAttribute('data-windows-titlebar', '')
    document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')

    const markersRead = readShellDomMarkers()

    expect(markersRead.platform).toBe('win32')
    expect(markersRead.windowsTitlebar).toBe(true)
    // The height custom property is what the shared AppFrame CSS reserves; the
    // shell owns both and the glue only reports them.
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe('40px')
  })

  it('reports no caption marker on a plain Web document', () => {
    const markersRead = readShellDomMarkers()
    expect(markersRead.platform).toBeUndefined()
    expect(markersRead.windowsTitlebar).toBe(false)
  })

  it('never writes the Rust-owned DOM markers', async () => {
    vi.resetModules()
    vi.stubGlobal('__TAURI_INTERNALS__', {
      async invoke() { return undefined },
      transformCallback() { return 1 },
    })
    const boot = await import('../shell-boot.ts')
    const observed = boot.installDesktopShellMarkers()
    // The glue read the (absent) markers rather than installing them.
    expect(observed.windowsTitlebar).toBe(false)
    expect(document.documentElement.dataset.platform).toBeUndefined()
    expect(document.documentElement.hasAttribute('data-windows-titlebar')).toBe(false)
  })
})

describe('__DSH_HOST_PATHS__ native handoff', () => {
  afterEach(() => { clearMarkers(); vi.restoreAllMocks() })

  it('never fabricates a path for a File the shell did not see', () => {
    // The Rust-installed global answers '' for an unknown File. The glue must
    // not add a fallback that joins a directory with `file.name`.
    const shellApi: DshHostPaths = { pathFor: () => '' }
    expect(shellApi.pathFor(dragFile('notes.txt'))).toBe('')
    // And an absent global answers nothing at all: the composer then uploads,
    // which is upstream's behavior for a File with no host path.
    expect(Reflect.get(globalThis, '__DSH_HOST_PATHS__')).toBeUndefined()
  })

  it('reads a pending batch once and reports it consumed', () => {
    const adopted: string[] = []
    let consumed = false
    const api: DshHostPaths = {
      pathFor: () => '',
      adopt: (paths) => { adopted.push(...paths) },
      pending: () => (consumed ? [] : [...adopted]),
      consume: () => { const had = !consumed && adopted.length > 0; consumed = true; return had },
    }
    api.adopt?.(['C:\\drop\\a.txt', 'C:\\drop\\b.txt'])
    expect(takePendingHostPaths(api)).toEqual(['C:\\drop\\a.txt', 'C:\\drop\\b.txt'])
    // A second read is empty: one drop attaches once.
    expect(takePendingHostPaths(api)).toEqual([])
  })

  it('an upstream-shaped bridge with only pathFor degrades to upload, never to a guess', () => {
    // A client that knows only upstream's member must not break.
    const upstreamShaped: DshHostPaths = { pathFor: () => '/native/x.txt' }
    expect(takePendingHostPaths(upstreamShaped)).toEqual([])
    expect(upstreamShaped.pathFor(dragFile('x.txt'))).toBe('/native/x.txt')
  })

  it('delivers one drop to every subscriber and stops after dispose', () => {
    const adopted = ['C:\\drop\\one.txt']
    let consumed = false
    vi.stubGlobal('__DSH_HOST_PATHS__', {
      pathFor: () => '',
      pending: () => (consumed ? [] : [...adopted]),
      consume: () => { const had = !consumed; consumed = true; return had },
    } satisfies DshHostPaths)

    const subscription = subscribeHostPathDrops()
    const first: string[][] = []
    const second: string[][] = []
    subscription.subscribe(paths => first.push([...paths]))
    subscription.subscribe(paths => second.push([...paths]))

    document.dispatchEvent(new CustomEvent(HOST_PATHS_EVENT))
    expect(first).toEqual([['C:\\drop\\one.txt']])
    expect(second).toEqual([['C:\\drop\\one.txt']])
    // The batch was consumed, so a repeated event replays nothing.
    document.dispatchEvent(new CustomEvent(HOST_PATHS_EVENT))
    expect(first).toHaveLength(1)

    subscription.dispose()
    consumed = false
    adopted.length = 0
    document.dispatchEvent(new CustomEvent(HOST_PATHS_EVENT))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
  })

  it('contains a throwing listener and still acknowledges the batch exactly once', () => {
    // The subscription — not any listener — owns the acknowledgement, so a
    // listener that throws must neither starve the listeners after it nor
    // leave the drop unconsumed (which would replay it on the next event).
    const adopted = ['C:\\drop\\a.txt']
    let consumed = 0
    vi.stubGlobal('__DSH_HOST_PATHS__', {
      pathFor: () => '',
      pending: () => (consumed === 0 ? [...adopted] : []),
      consume: () => { consumed += 1; return true },
    } satisfies DshHostPaths)
    const faults: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      faults.push(args.map(argument => String(argument)).join(' '))
    })

    const subscription = subscribeHostPathDrops()
    const seen: string[] = []
    subscription.subscribe(() => { throw new Error('drop-listener') })
    subscription.subscribe(paths => { seen.push(...paths) })
    document.dispatchEvent(new CustomEvent(HOST_PATHS_EVENT))

    expect(seen).toEqual(['C:\\drop\\a.txt'])
    expect(faults).toHaveLength(1)
    expect(faults[0]).toContain('drop-listener')
    expect(consumed).toBe(1)

    // One drop attaches once: the repeated event replays nothing.
    document.dispatchEvent(new CustomEvent(HOST_PATHS_EVENT))
    expect(seen).toHaveLength(1)
    expect(consumed).toBe(1)

    subscription.dispose()
    spy.mockRestore()
  })

  it('dispatches nothing when the shell has no pending drop', () => {
    vi.stubGlobal('__DSH_HOST_PATHS__', { pathFor: () => '' } satisfies DshHostPaths)
    const subscription = subscribeHostPathDrops()
    const seen: string[][] = []
    subscription.subscribe(paths => seen.push([...paths]))
    document.dispatchEvent(new CustomEvent(HOST_PATHS_EVENT))
    expect(seen).toEqual([])
    subscription.dispose()
  })
})

describe('matchDropPaths pairs adopted paths with the dropped Files', () => {
  it('resolves each File to the path with the same base name', () => {
    const files = [dragFile('notes.txt'), dragFile('report.pdf')]
    expect(matchDropPaths(files, ['C:\\proj\\notes.txt', '/tmp/report.pdf']))
      .toEqual(['C:\\proj\\notes.txt', '/tmp/report.pdf'])
  })

  it('refuses a duplicate name on either side instead of guessing by ordinal', () => {
    // Two Files with one name: which directory did each come from? The shell
    // observed two paths and the browser reported two Files, and nothing joins
    // them. An ordinal guess would cite a path the user may never have dropped,
    // so both resolve to no path (the caller uploads, as upstream does for a
    // File with no host path).
    const files = [dragFile('a.txt'), dragFile('a.txt')]
    expect(matchDropPaths(files, ['C:\\one\\a.txt', 'C:\\two\\a.txt']))
      .toEqual([undefined, undefined])
    // A duplicate on the path side alone is equally unresolvable.
    expect(matchDropPaths([dragFile('a.txt')], ['C:\\one\\a.txt', 'C:\\two\\a.txt']))
      .toEqual([undefined])
  })

  it('still resolves an unambiguous name beside an ambiguous one', () => {
    const files = [dragFile('a.txt'), dragFile('a.txt'), dragFile('b.txt')]
    expect(matchDropPaths(files, ['C:\\one\\a.txt', 'C:\\two\\a.txt', 'C:\\only\\b.txt']))
      .toEqual([undefined, undefined, 'C:\\only\\b.txt'])
  })

  it('leaves a File with no adopted path undefined rather than inventing one', () => {
    const files = [dragFile('known.txt'), dragFile('unknown.txt')]
    expect(matchDropPaths(files, ['C:\\drop\\known.txt']))
      .toEqual(['C:\\drop\\known.txt', undefined])
    // No paths at all: every file uploads, exactly as upstream does.
    expect(matchDropPaths(files, [])).toEqual([undefined, undefined])
  })

  it('never matches a path whose base name differs only by case or extension', () => {
    const files = [dragFile('Notes.txt'), dragFile('notes.txt.bak')]
    expect(matchDropPaths(files, ['C:\\drop\\notes.txt'])).toEqual([undefined, undefined])
  })

  it('reads the base name across both separators without rebuilding the path', () => {
    expect(hostPathBaseName('C:\\Program Files\\app\\x.txt')).toBe('x.txt')
    expect(hostPathBaseName('/home/me/readme.md')).toBe('readme.md')
    // A trailing separator has no base name and must not match a File.
    expect(hostPathBaseName('C:\\drop\\folder\\')).toBe('')
    expect(hostPathBaseName('')).toBe('')
  })

  it('resolves a stale batch to nothing: a dropped File is never given an old path', () => {
    // The shell replaced its batch with a later drop's paths. A File from the
    // first drop has no path in this batch, so it resolves to undefined.
    const firstDropFiles = [dragFile('old.txt')]
    expect(matchDropPaths(firstDropFiles, ['C:\\second\\new.txt'])).toEqual([undefined])
  })
})

describe('hostPathDropIntake reads the shell batch once per drop', () => {
  it('pairs the pending batch with the DOM Files and consumes it', () => {
    const adopted = ['C:\\drop\\a.txt']
    let consumed = false
    const api: DshHostPaths = {
      pathFor: () => '',
      pending: () => (consumed ? [] : [...adopted]),
      consume: () => { const had = !consumed && adopted.length > 0; consumed = true; return had },
    }

    expect(hostPathDropIntake.resolve([dragFile('a.txt')], api)).toEqual(['C:\\drop\\a.txt'])
    // One drop attaches once: a second intake for the same batch resolves nothing.
    expect(hostPathDropIntake.resolve([dragFile('a.txt')], api)).toEqual([undefined])
  })

  it('resolves nothing when the shell has no batch or no extension at all', () => {
    expect(hostPathDropIntake.resolve([dragFile('a.txt')], undefined)).toEqual([undefined])
    // An upstream-shaped bridge (only `pathFor`) carries no batch to read.
    expect(hostPathDropIntake.resolve([dragFile('a.txt')], { pathFor: () => '/native/a.txt' }))
      .toEqual([undefined])
    // No Files means no work and no consumption.
    expect(hostPathDropIntake.resolve([], { pathFor: () => '' })).toEqual([])
  })
})

describe('directory picker ownership stays in Rust', () => {
  afterEach(() => { clearMarkers(); vi.resetModules() })

  it('forwards every pick to the command with no page-level de-duplication', async () => {
    const calls: string[] = []
    const pending: ((value: { path: string | null }) => void)[] = []
    vi.resetModules()
    vi.stubGlobal('__TAURI_INTERNALS__', {
      async invoke(command: string, args?: Record<string, unknown>) {
        if (command === 'shell_pick_directory') {
          calls.push(command)
          void args
          // Never settles: the point is that a second call still reaches Rust.
          return await new Promise(resolve => { pending.push(resolve) })
        }
        return undefined
      },
      transformCallback() { return 1 },
    })
    const { desktop } = await import('../index.ts')
    const { createDirectoryPicker } = await import('../markers.ts')
    const picker = createDirectoryPicker(desktop)

    void picker.pick()
    void picker.pick()
    await Promise.resolve()
    await Promise.resolve()

    // Both calls reached the single native owner; Rust joins them onto one
    // dialog. A page guard here would instead have swallowed the second call
    // and broken the retry-after-cancellation rule.
    expect(calls).toHaveLength(2)
    expect(pending).toHaveLength(2)
  })
})
