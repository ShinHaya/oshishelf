/** Validate the JSON Schema vocabulary used by the shipped data contracts. */
export function validateSchema(value, schema, field = "root") {
  const fail = () => { throw new Error(`runtime-config-invalid:${field}`); };
  const keywords = new Set(["$schema", "type", "enum", "properties", "required", "additionalProperties", "items", "minLength", "pattern", "minimum", "minItems", "uniqueItems"]);
  if (Object.keys(schema).some(key => !keywords.has(key))) throw new Error("runtime-schema-keyword-unsupported");
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some(type => type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isSafeInteger(value) : typeof value === type);
    if (!ok) fail();
  }
  if (typeof value === "string") {
    if (schema.minLength && value.length < schema.minLength) fail();
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail();
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) fail();
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) fail();
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) fail();
    if (schema.items) value.forEach((v, i) => validateSchema(v, schema.items, `${field}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail();
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) validateSchema(item, schema.properties[key], `${field}.${key}`);
      else if (schema.additionalProperties === false) fail();
    }
  }
}
