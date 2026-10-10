/**
 * Minimal `vitest` surface for `run-transitions.mjs`.
 *
 * Implements exactly the three imports the Updates spec uses, plus the
 * assertion methods it calls, so the spec can execute in-process under the DSH
 * Windows sandbox where every child-spawning runner fails with `spawn EPERM`.
 * The real vitest remains the authority in an unrestricted environment; this
 * shim only has to agree on the assertions the spec exercises, and it throws
 * loudly for anything it does not implement.
 */

const suites = []
let stack = null

export function describe(name, body) {
  const parent = stack
  const suite = { name: parent ? `${parent.name} > ${name}` : name, cases: [] }
  stack = suite
  suites.push(suite)
  body()
  stack = parent
}

export function it(name, body) {
  if (stack === null) throw new Error(`"${name}" is not inside a describe()`)
  stack.cases.push({ name, body })
}

function format(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

export function expect(actual) {
  const fail = (message) => {
    throw new Error(message)
  }
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) {
        fail(`expected ${format(expected)}, received ${format(actual)}`)
      }
    },
    toBeNull() {
      if (actual !== null) fail(`expected null, received ${format(actual)}`)
    },
    toBeUndefined() {
      if (actual !== undefined) fail(`expected undefined, received ${format(actual)}`)
    },
    toBeTruthy() {
      if (!actual) fail(`expected a truthy value, received ${format(actual)}`)
    },
    toBeFalsy() {
      if (actual) fail(`expected a falsy value, received ${format(actual)}`)
    },
    not: {
      toBe(expected) {
        if (Object.is(actual, expected)) fail(`expected a value other than ${format(expected)}`)
      },
      toBeNull() {
        if (actual === null) fail('expected a value other than null')
      },
      toBeUndefined() {
        if (actual === undefined) fail('expected a value other than undefined')
      },
    },
  }
}

/** Execute every registered case and summarize the result. */
export function report() {
  let passed = 0
  const failures = []
  let total = 0
  for (const suite of suites) {
    for (const testCase of suite.cases) {
      total += 1
      try {
        testCase.body()
        passed += 1
      } catch (error) {
        failures.push(`${suite.name} > ${testCase.name}: ${error.message}`)
      }
    }
  }
  return { passed, failures, total }
}
