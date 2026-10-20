/**
 * Small helpers shared by the three plugin rows: a JSON-returning tool wrapper
 * and the config-independent plumbing each `apply()` needs.
 */

/** Wraps a handler as a DSH tool whose result is pretty-printed JSON. */
export function jsonTool({ name, description, parameters, handler }) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      return handler(args ?? {}, exec)
    },
  }
}

export const str = (description) => ({ type: 'string', description })
export const num = (description) => ({ type: 'number', description })
export const bool = (description) => ({ type: 'boolean', description })
export const arr = (description, items = { type: 'string' }) => ({ type: 'array', description, items })

export function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}
