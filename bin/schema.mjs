import { L } from './i18n.mjs';

export const SUPPORTED_KEYWORDS = [
  'type', 'enum', 'const', 'multipleOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'pattern', 'items', 'prefixItems', 'additionalItems', 'minItems', 'maxItems',
  'uniqueItems', 'contains', 'minContains', 'maxContains', 'properties', 'patternProperties',
  'additionalProperties', 'required', 'propertyNames', 'minProperties', 'maxProperties',
  'dependentRequired', 'dependentSchemas', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref',
];

const annotations = ['$schema', '$id', '$comment', '$defs', 'definitions', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format', 'contentMediaType', 'contentEncoding'];
const known = new Set([...SUPPORTED_KEYWORDS, ...annotations]);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSchema = v => typeof v === 'boolean' || isObject(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pathKey = (at, k) => /^[A-Za-z_$][\w$]*$/.test(k) ? `${at}.${k}` : `${at}[${JSON.stringify(k)}]`;
const typeOf = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const equal = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => own(b, k) && equal(a[k], b[k]));
  }
  return false;
};

function resolve(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let pointer;
  try { pointer = decodeURIComponent(ref.slice(1)); } catch { return undefined; }
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) return undefined;
  let node = root;
  for (const part of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(part)) return undefined;
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !own(node, key)) return undefined;
    node = node[key];
  }
  return isSchema(node) ? node : undefined;
}

export function checkSchema(schema) {
  const visited = new WeakSet();
  const fail = (at, en, zh = en) => L(`${at}: ${en}`, `${at}：${zh}`);
  // validate() stops at 200 levels; a schema nested deeper than that is refused here, as a message
  let depth = 0;
  function walk(s, at) {
    if (depth >= 200) return fail(at, 'nested more than 200 levels deep', '嵌套超过 200 层');
    depth++;
    try {
      return walkOne(s, at);
    } finally {
      depth--;
    }
  }
  function walkOne(s, at) {
    if (!isSchema(s)) return fail(at, 'expected a schema (an object or a boolean)', '这里应该是模式（对象或布尔值）');
    if (typeof s === 'boolean') return null;
    if (visited.has(s)) return null;
    visited.add(s);
    for (const [k, v] of Object.entries(s)) {
      const p = pathKey(at, k);
      if (!known.has(k)) return fail(p, `unsupported keyword ${k}`, `不支持的关键字 ${k}`);
      const bad = () => fail(p, `invalid ${k}`, `${k} 的值不合法`);
      if (k === '$ref' && (typeof v !== 'string' || resolve(schema, v) === undefined)) return fail(p, `unresolvable $ref ${String(v)}`, `$ref 无法解析：${String(v)}`);
      if (k === 'type') {
        const types = Array.isArray(v) ? v : [v];
        if (!types.length || new Set(types).size !== types.length || types.some(t => !['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'].includes(t))) return bad();
      }
      if (k === 'enum' && (!Array.isArray(v) || !v.length || v.some((x, i) => v.slice(0, i).some(y => equal(x, y))))) return bad();
      if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(k) && (typeof v !== 'number' || !Number.isFinite(v) || (k === 'multipleOf' && v <= 0))) return bad();
      if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties'].includes(k) && (!Number.isInteger(v) || v < 0)) return bad();
      if (k === 'uniqueItems' && typeof v !== 'boolean') return bad();
      if (k === 'pattern') {
        if (typeof v !== 'string') return bad();
        try { new RegExp(v, 'u'); } catch { return bad(); }
      }
      if (['$schema', '$id', '$comment', 'title', 'description', 'format', 'contentMediaType', 'contentEncoding'].includes(k) && typeof v !== 'string') return bad();
      if (['deprecated', 'readOnly', 'writeOnly'].includes(k) && typeof v !== 'boolean') return bad();
      if (k === 'examples' && !Array.isArray(v)) return bad();
      if (k === 'required' && (!Array.isArray(v) || v.some(x => typeof x !== 'string') || new Set(v).size !== v.length)) return bad();
      if (k === 'dependentRequired') {
        if (!isObject(v) || Object.values(v).some(a => !Array.isArray(a) || a.some(x => typeof x !== 'string') || new Set(a).size !== a.length)) return bad();
      }
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(k)) {
        if (!isObject(v)) return bad();
        for (const [name, sub] of Object.entries(v)) {
          if (k === 'patternProperties') { try { new RegExp(name, 'u'); } catch { return fail(pathKey(p, name), 'invalid pattern', '正则写法不对'); } }
          const e = walk(sub, pathKey(p, name));
          if (e) return e;
        }
      }
      if (['items', 'additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'].includes(k)) {
        if (k === 'items' && Array.isArray(v)) {
          for (let i = 0; i < v.length; i++) { const e = walk(v[i], `${p}[${i}]`); if (e) return e; }
        } else { const e = walk(v, p); if (e) return e; }
      }
      if (['prefixItems', 'allOf', 'anyOf', 'oneOf'].includes(k)) {
        if (!Array.isArray(v) || !v.length) return bad();
        for (let i = 0; i < v.length; i++) { const e = walk(v[i], `${p}[${i}]`); if (e) return e; }
      }
    }
    return null;
  }
  return walk(schema, '$');
}

// A value that matches the schema, for a workflow's dry run: the smallest plausible one (enum/const first,
// required fields plus the other listed ones, one item per array). Best effort: patterns, `not` and the like are
// not solved for, so the caller checks the result with validate().
export function sample(schema) {
  function gen(s, depth) {
    if (depth > 30 || s === false) return null;
    if (s === true || !isObject(s)) return 'sample';
    if (own(s, '$ref')) {
      const t = resolve(schema, s.$ref);
      if (t !== undefined) return gen(t, depth + 1);
    }
    if (own(s, 'const')) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    for (const v of [...(Array.isArray(s.examples) ? s.examples : []), ...(own(s, 'default') ? [s.default] : [])])
      if (validate(s, v) === null) return v;
    // allOf: one value that satisfies the branches, built from their merged object parts
    if (Array.isArray(s.allOf) && s.allOf.length) {
      const parts = s.allOf.map(b => (isObject(b) && own(b, '$ref') ? resolve(schema, b.$ref) : b)).filter(isObject);
      const merged = { ...s, allOf: undefined, properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
      for (const b of parts) {
        Object.assign(merged.properties, b.properties || {});
        merged.required.push(...(b.required || []));
        if (b.type && !merged.type) merged.type = b.type;
      }
      delete merged.allOf;
      return gen(merged, depth + 1);
    }
    for (const k of ['anyOf', 'oneOf']) {
      if (!Array.isArray(s[k]) || !s[k].length) continue;
      const rest = { ...s };
      delete rest[k];
      for (const b of s[k]) {
        const v = gen(isObject(b) ? { ...rest, ...b } : b, depth + 1);
        if (validate(s, v) === null) return v;
      }
      return gen(s[k][0], depth + 1);
    }
    const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
    const type =
      types.find(t => t !== 'null') ||
      types[0] ||
      (s.properties || s.required ? 'object' : s.items || s.prefixItems ? 'array' : s.minimum !== undefined || s.maximum !== undefined ? 'number' : 'string');
    if (type === 'null') return null;
    if (type === 'boolean') return false;
    if (type === 'number' || type === 'integer') {
      let v = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 0);
      if (s.maximum !== undefined && v > s.maximum) v = s.maximum;
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) v = s.exclusiveMaximum - 1;
      if (s.multipleOf) v = Math.ceil(v / s.multipleOf) * s.multipleOf;
      return type === 'integer' ? Math.ceil(v) : v;
    }
    if (type === 'string') {
      let v = 'sample';
      if (s.minLength !== undefined && v.length < s.minLength) v = v.padEnd(s.minLength, 'x');
      if (s.maxLength !== undefined) v = v.slice(0, s.maxLength);
      return v;
    }
    if (type === 'array') {
      const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : [];
      const each = Array.isArray(s.items) ? s.additionalItems : s.items;
      const n = Math.max(tuple.length, s.minItems ?? 0, each === undefined && !tuple.length ? 0 : 1);
      const max = s.maxItems ?? Infinity;
      const out = [];
      for (let i = 0; i < Math.min(n, max); i++) {
        const v = gen(i < tuple.length ? tuple[i] : each ?? true, depth + 1);
        // uniqueItems: tell repeated samples apart
        out.push(s.uniqueItems && typeof v === 'string' && i ? `${v}${i + 1}` : s.uniqueItems && typeof v === 'number' && i ? v + i : v);
      }
      return out;
    }
    // object
    const props = s.properties || {};
    const required = Array.isArray(s.required) ? s.required : [];
    const max = s.maxProperties ?? Infinity;
    const out = {};
    for (const k of [...required, ...Object.keys(props).filter(k => !required.includes(k))]) {
      if (Object.keys(out).length >= max && !required.includes(k)) break;
      out[k] = gen(own(props, k) ? props[k] : s.additionalProperties ?? true, depth + 1);
    }
    return out;
  }
  return gen(schema, 0);
}

export function validate(schema, value) {
  function visit(s, v, at, depth) {
    if (depth > 200) throw new Error(L(`${at} exceeds schema recursion limit`, `${at} 超过模式递归限制`));
    if (s === true) return null;
    if (s === false) return L(`${at} is rejected by the schema`, `${at} 被模式拒绝`);
    if (!isObject(s)) throw new Error(L(`${at} has an invalid schema`, `${at} 的模式无效`));
    const sub = (child, val = v, path = at) => visit(child, val, path, depth + 1);
    let e;
    if (own(s, '$ref')) {
      const target = resolve(schema, s.$ref);
      if (target === undefined) throw new Error(L(`${at} has an unresolvable $ref ${s.$ref}`, `${at} 的 $ref 无法解析 ${s.$ref}`));
      if ((e = sub(target))) return e;
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      const actual = typeOf(v);
      if (!types.some(t => t === actual || (t === 'integer' && typeof v === 'number' && Number.isInteger(v)))) return L(`${at} should be ${types.join('|')}, got ${actual}`, `${at} 应为 ${types.join('|')}，实际是 ${actual}`);
    }
    if (s.enum && !s.enum.some(x => equal(x, v))) return L(`${at} must be one of ${JSON.stringify(s.enum)}`, `${at} 必须是 ${JSON.stringify(s.enum)} 之一`);
    if (own(s, 'const') && !equal(s.const, v)) return L(`${at} must equal ${JSON.stringify(s.const)}`, `${at} 必须等于 ${JSON.stringify(s.const)}`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) return L(`${at} must be >= ${s.minimum}`, `${at} 不能小于 ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) return L(`${at} must be <= ${s.maximum}`, `${at} 不能大于 ${s.maximum}`);
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) return L(`${at} must be > ${s.exclusiveMinimum}`, `${at} 必须大于 ${s.exclusiveMinimum}`);
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) return L(`${at} must be < ${s.exclusiveMaximum}`, `${at} 必须小于 ${s.exclusiveMaximum}`);
      if (s.multipleOf !== undefined) {
        const q = v / s.multipleOf;
        if (Math.abs(q - Math.round(q)) > Number.EPSILON * Math.max(1, Math.abs(q)) * 4) return L(`${at} must be a multiple of ${s.multipleOf}`, `${at} 必须是 ${s.multipleOf} 的倍数`);
      }
    }
    if (typeof v === 'string') {
      const length = [...v].length;
      if (s.minLength !== undefined && length < s.minLength) return L(`${at} must be at least ${s.minLength} characters`, `${at} 长度不能小于 ${s.minLength}`);
      if (s.maxLength !== undefined && length > s.maxLength) return L(`${at} must be at most ${s.maxLength} characters`, `${at} 长度不能大于 ${s.maxLength}`);
      if (s.pattern !== undefined && !new RegExp(s.pattern, 'u').test(v)) return L(`${at} does not match pattern ${s.pattern}`, `${at} 不匹配模式 ${s.pattern}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) return L(`${at} needs at least ${s.minItems} items`, `${at} 至少要有 ${s.minItems} 项`);
      if (s.maxItems !== undefined && v.length > s.maxItems) return L(`${at} allows at most ${s.maxItems} items`, `${at} 最多 ${s.maxItems} 项`);
      if (s.uniqueItems && v.some((x, i) => v.slice(0, i).some(y => equal(x, y)))) return L(`${at} must have unique items`, `${at} 的各项必须唯一`);
      const tuple = Array.isArray(s.items) ? s.items : (s.prefixItems || []);
      for (let i = 0; i < v.length; i++) {
        const itemSchema = i < tuple.length ? tuple[i] : Array.isArray(s.items) ? s.additionalItems : s.items;
        if (itemSchema !== undefined && (e = sub(itemSchema, v[i], `${at}[${i}]`))) return e;
      }
      if (s.contains !== undefined) {
        const count = v.reduce((n, item, i) => n + (sub(s.contains, item, `${at}[${i}]`) === null ? 1 : 0), 0);
        if (count < (s.minContains ?? 1) || (s.maxContains !== undefined && count > s.maxContains)) return L(`${at} has ${count} matching items for contains`, `${at} 有 ${count} 项匹配 contains`);
      }
    }
    if (isObject(v)) {
      const keys = Object.keys(v);
      if (s.minProperties !== undefined && keys.length < s.minProperties) return L(`${at} needs at least ${s.minProperties} properties`, `${at} 至少要有 ${s.minProperties} 个属性`);
      if (s.maxProperties !== undefined && keys.length > s.maxProperties) return L(`${at} allows at most ${s.maxProperties} properties`, `${at} 最多 ${s.maxProperties} 个属性`);
      for (const k of s.required || []) if (!own(v, k)) return L(`${at} is missing field ${k}`, `${at} 缺少字段 ${k}`);
      for (const k of keys) {
        const p = pathKey(at, k);
        if (s.propertyNames !== undefined && (e = sub(s.propertyNames, k, p))) return e;
        let matched = false;
        if (s.properties && own(s.properties, k)) { matched = true; if ((e = sub(s.properties[k], v[k], p))) return e; }
        for (const [pattern, child] of Object.entries(s.patternProperties || {})) {
          if (new RegExp(pattern, 'u').test(k)) { matched = true; if ((e = sub(child, v[k], p))) return e; }
        }
        if (!matched && s.additionalProperties === false) return L(`${at} must not have field ${k}`, `${at} 不允许有字段 ${k}`);
        if (!matched && s.additionalProperties !== undefined && (e = sub(s.additionalProperties, v[k], p))) return e;
      }
      for (const [k, required] of Object.entries(s.dependentRequired || {})) if (own(v, k)) {
        for (const name of required) if (!own(v, name)) return L(`${at} is missing field ${name}`, `${at} 缺少字段 ${name}`);
      }
      for (const [k, child] of Object.entries(s.dependentSchemas || {})) if (own(v, k) && (e = sub(child))) return e;
    }
    for (const child of s.allOf || []) if ((e = sub(child))) return e;
    if (s.anyOf && !s.anyOf.some(child => sub(child) === null)) return L(`${at} must match an anyOf schema`, `${at} 必须匹配一个 anyOf 模式`);
    if (s.oneOf) {
      const count = s.oneOf.filter(child => sub(child) === null).length;
      if (count !== 1) return L(`${at} must match exactly one of the oneOf schemas (matched ${count})`, `${at} 必须恰好匹配一个 oneOf 模式（匹配 ${count} 个）`);
    }
    if (s.not !== undefined && sub(s.not) === null) return L(`${at} must not match the not schema`, `${at} 不能匹配 not 模式`);
    if (s.if !== undefined) {
      const branch = sub(s.if) === null ? s.then : s.else;
      if (branch !== undefined && (e = sub(branch))) return e;
    }
    return null;
  }
  try { return visit(schema, value, '$', 0); } catch (error) { return error.message; }
}
