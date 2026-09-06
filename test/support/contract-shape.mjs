// SPDX-License-Identifier: Apache-2.0
/**
 * Check a value against a definition of the vendored Worker schema.
 *
 * This exists because "the fake accepted it" is not the same claim as "the contract accepts
 * it". A hand-rolled fake endpoint will happily take whatever the client sends, so a poll
 * that still carried last month's shape would pass every scenario arm in this suite while
 * the deployed Gateway refused it on the first hop. What closes that gap is checking the
 * bytes the Worker actually puts on the wire against the schema itself.
 *
 * It reads the keyword subset the Worker hop uses, and only that subset:
 *
 *     $ref (local, into $defs)   type        required     properties
 *     additionalProperties       enum        const        pattern
 *     propertyNames              items       minLength    minimum / maximum
 *     maxItems                   uniqueItems anyOf
 *
 * An unknown keyword is a fault rather than a shrug: a validator that silently ignores what
 * it does not understand reports "valid" for a rule it never checked, which is the one
 * failure mode a checker must not have. The checker is itself calibrated in
 * `worker-contract.test.mjs` against every `valid` and `invalid` example the committed
 * fixture carries, so a subset that stopped covering the contract turns those arms red.
 */

const KNOWN = new Set([
  '$ref', 'type', 'required', 'properties', 'additionalProperties', 'propertyNames',
  'enum', 'const', 'pattern', 'items', 'minLength', 'minimum', 'maximum',
  'maxItems', 'uniqueItems', 'anyOf', 'if', 'then', 'else', 'not',
  // Prose, carried by the contract and not a constraint.
  'description', '$comment', 'title',
])

const typeOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value)

/** How a ref into a schema this bundle does not carry is reported, so callers can name it. */
export const UNRESOLVED = 'unresolved $ref'

/**
 * Every way `value` fails `schema`, as sentences. Empty means it validates.
 *
 * `defs` is the schema's `$defs`, used to resolve local `$ref`. `at` is a JSON-pointer-ish
 * path used only to make a fault readable.
 */
export function shapeFaults(value, schema, defs, at = '') {
  const faults = []
  const say = (message) => faults.push(`${at || '(root)'}: ${message}`)
  if (schema === undefined) return [`${at || '(root)'}: no schema`]

  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) say(`the checker does not read the keyword ${JSON.stringify(keyword)}`)
  }
  if (typeof schema.$ref === 'string') {
    // A local `#/$defs/X` resolves by name. A ref that names another file resolves only if
    // the caller supplied that file's definitions under the fully qualified key: this
    // bundle carries two schemas, not every schema the contract repository has, and a ref
    // into one it does not carry is reported as unresolved rather than passed over. Silence
    // there would read as "checked and fine" for a rule nothing looked at.
    const local = schema.$ref.startsWith('#/$defs/')
    const target = defs[local ? schema.$ref.slice('#/$defs/'.length) : schema.$ref]
    if (target === undefined) return [`${at || '(root)'}: ${UNRESOLVED} ${schema.$ref}`]
    return [...faults, ...shapeFaults(value, target, defs, at)]
  }

  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((branch) => shapeFaults(value, branch, defs, at))
    if (branches.every((branch) => branch.length > 0)) say(`matches none of ${branches.length} alternatives (${branches.flat().join('; ')})`)
  }
  if (schema.if !== undefined) {
    const branch = shapeFaults(value, schema.if, defs, at).length === 0 ? schema.then : schema.else
    if (branch !== undefined) faults.push(...shapeFaults(value, branch, defs, at))
  }
  if (schema.not !== undefined && shapeFaults(value, schema.not, defs, at).length === 0) {
    say('matches a forbidden shape')
  }

  const actual = typeOf(value)
  if (schema.type !== undefined) {
    const wanted = schema.type === 'integer' ? 'number' : schema.type
    if (actual !== wanted) say(`is ${actual}, and the contract says ${schema.type}`)
    else if (schema.type === 'integer' && !Number.isInteger(value)) say('is not an integer')
  }
  if (schema.const !== undefined && value !== schema.const) say(`is ${JSON.stringify(value)}, and the contract says ${JSON.stringify(schema.const)}`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) say(`is ${JSON.stringify(value)}, which is outside ${JSON.stringify(schema.enum)}`)
  if (typeof schema.pattern === 'string' && typeof value === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    say(`does not match ${schema.pattern}`)
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    say(`is shorter than ${schema.minLength}`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) say(`is below ${schema.minimum}`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) say(`is above ${schema.maximum}`)
  }

  if (actual === 'array') {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) say(`carries ${value.length} items, over the ${schema.maxItems} the contract allows`)
    if (schema.uniqueItems === true) {
      const seen = new Set()
      for (const item of value) {
        const key = JSON.stringify(item)
        if (seen.has(key)) say('repeats an item, and the contract requires them to be unique')
        seen.add(key)
      }
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) faults.push(...shapeFaults(item, schema.items, defs, `${at}[${index}]`))
    }
  }

  if (actual === 'object') {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) say(`is missing the required ${JSON.stringify(name)}`)
    }
    const declared = schema.properties ?? {}
    for (const [name, held] of Object.entries(value)) {
      if (schema.propertyNames?.pattern !== undefined && !new RegExp(schema.propertyNames.pattern, 'u').test(name)) {
        say(`names the member ${JSON.stringify(name)}, which does not match ${schema.propertyNames.pattern}`)
      }
      if (declared[name] !== undefined) {
        faults.push(...shapeFaults(held, declared[name], defs, `${at}.${name}`))
        continue
      }
      if (schema.additionalProperties === false) say(`carries ${JSON.stringify(name)}, which this shape does not define`)
      else if (typeof schema.additionalProperties === 'object') {
        faults.push(...shapeFaults(held, schema.additionalProperties, defs, `${at}.${name}`))
      }
    }
  }
  return faults
}

/** True when `value` satisfies `schema`. */
export const fitsShape = (value, schema, defs) => shapeFaults(value, schema, defs).length === 0
