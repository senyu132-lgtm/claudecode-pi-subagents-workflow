import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, checkSchema, sample, SUPPORTED_KEYWORDS } from '../bin/schema.mjs';
import { setLanguage } from '../bin/i18n.mjs';

const pair = (schema, good, bad) => {
  assert.equal(checkSchema(schema), null, JSON.stringify(schema));
  assert.equal(validate(schema, good), null, JSON.stringify(schema));
  assert.equal(typeof validate(schema, bad), 'string', JSON.stringify(schema));
};

test('types, equality, numeric and string keywords', () => {
  pair({ type: ['integer', 'null'] }, 1, 1.5);
  pair({ type: 'number' }, 1, '1');
  pair({ enum: [{ a: 1, b: 2 }] }, { b: 2, a: 1 }, {});
  pair({ const: { a: 1, b: 2 } }, { b: 2, a: 1 }, {});
  pair({ multipleOf: 0.1 }, 0.3, 0.25);
  pair({ minimum: 2 }, 2, 1);
  pair({ maximum: 2 }, 2, 3);
  pair({ exclusiveMinimum: 2 }, 3, 2);
  pair({ exclusiveMaximum: 2 }, 1, 2);
  pair({ minLength: 1 }, '😀', '');
  pair({ maxLength: 1 }, '😀', '😀a');
  pair({ pattern: '^😀$' }, '😀', 'a');
  assert.equal(validate(true, null), null);
  assert.match(validate(false, null), /^\$/);
});

test('array keywords and tuples', () => {
  pair({ items: { type: 'integer' } }, [1], [1.2]);
  pair({ items: [{ type: 'number' }], additionalItems: false }, [1], [1, 2]);
  pair({ items: [true], additionalItems: { type: 'number' } }, [1, 2], [1, 'x']);
  pair({ prefixItems: [{ type: 'number' }], items: { type: 'string' } }, [1, 'a'], [1, 2]);
  pair({ minItems: 1 }, [1], []);
  pair({ maxItems: 1 }, [], [1, 2]);
  pair({ uniqueItems: true }, [{ a: 1, b: 2 }, {}], [{ a: 1, b: 2 }, { b: 2, a: 1 }]);
  pair({ contains: { type: 'number' } }, [1], ['x']);
  pair({ contains: { type: 'number' }, minContains: 2 }, [1, 2], [1]);
  pair({ contains: { type: 'number' }, maxContains: 1 }, [1], [1, 2]);
  assert.equal(validate({ contains: false, minContains: 0 }, [1]), null);
});

test('object keywords', () => {
  pair({ properties: { x: false } }, {}, { x: 1 });
  pair({ patternProperties: { '^x': { type: 'number' } } }, { x1: 1 }, { x1: 'a' });
  pair({ additionalProperties: { type: 'number' } }, { x: 1 }, { x: 'a' });
  pair({ required: ['x'] }, { x: 1 }, {});
  pair({ propertyNames: { pattern: '^a' } }, { abc: 1 }, { x: 1 });
  pair({ minProperties: 1 }, { x: 1 }, {});
  pair({ maxProperties: 1 }, {}, { x: 1, y: 2 });
  pair({ dependentRequired: { x: ['y'] } }, { x: 1, y: 2 }, { x: 1 });
  pair({ dependentSchemas: { x: { required: ['y'] } } }, { x: 1, y: 2 }, { x: 1 });
  assert.equal(validate({ properties: { x: true }, patternProperties: { x: { type: 'number' } }, additionalProperties: false }, { x: 'a' }), '$.x should be number, got string');
  assert.match(validate({ properties: { 'a-b': false } }, { 'a-b': 1 }), /^\$\["a-b"\]/);
});

test('combinators', () => {
  pair({ allOf: [{ type: 'number' }, { minimum: 1 }] }, 2, 0);
  pair({ anyOf: [{ type: 'number' }, { type: 'string' }] }, 'a', false);
  pair({ oneOf: [{ type: 'number' }, { minimum: 1 }] }, 0, 2);
  pair({ not: { type: 'number' } }, 'a', 1);
  const conditional = { if: { type: 'number' }, then: { minimum: 2 }, else: { type: 'string' } };
  pair(conditional, 2, 1);
  assert.equal(validate(conditional, 'a'), null);
  assert.match(validate(conditional, false), /should be string/);
});

test('references and recursion', () => {
  pair({ $defs: { n: { type: 'number' } }, $ref: '#/$defs/n' }, 1, 'a');
  pair({ definitions: { 'a/b~c': { type: 'number' } }, $ref: '#/definitions/a~1b~0c' }, 1, 'a');
  pair({ $defs: { 'a b': { type: 'string' } }, $ref: '#/$defs/a%20b' }, 'a', 1);
});

test('recursive and broken references', () => {
  const tree = { type: 'object', properties: { children: { type: 'array', items: { $ref: '#' } } } };
  assert.equal(checkSchema(tree), null);
  assert.equal(validate(tree, { children: [{ children: [{}] }] }), null);
  assert.match(validate(tree, { children: [{ children: [1] }] }), /children\[0\].children\[0\]/);
  for (const ref of ['#/missing', 'https://example.com/schema']) {
    assert.match(checkSchema({ $ref: ref }), /\$ref/);
    assert.match(validate({ $ref: ref }, 1), /\$ref/);
  }
  assert.match(validate({ $ref: '#' }, 1), /recursion/);
});

test('schema checking', () => {
  for (const schema of [null, 1, [], { required: 'x' }, { minimum: '1' }, { properties: [] }, { items: 1 }, { type: 'wat' }, { pattern: '[' }, { patternProperties: { '[': true } }]) assert.equal(typeof checkSchema(schema), 'string');
  assert.match(checkSchema({ properties: { x: { unevaluatedProperties: false } } }), /\$\.properties\.x\.unevaluatedProperties/);
  assert.match(checkSchema({ $defs: { x: { dependencies: {} } } }), /dependencies/);
  assert.match(checkSchema({ items: [{ $dynamicRef: '#' }] }), /\$dynamicRef/);
  assert.equal(checkSchema({ $schema: 'x', $id: 'x', $comment: '', title: '', description: '', default: 1, examples: [], deprecated: true, readOnly: false, writeOnly: false, format: 'email', contentMediaType: '', contentEncoding: '', definitions: { x: true } }), null);
  assert.equal(validate({ unknown: false, format: 'email' }, 'not email'), null);
  assert.ok(SUPPORTED_KEYWORDS.includes('$ref'));
});

test('exact messages in both languages', () => {
  const cases = [
    [{ type: 'integer' }, 1.5, '$ should be integer, got number', '$ 应为 integer，实际是 number'],
    [{ enum: [1, 2] }, 3, '$ must be one of [1,2]', '$ 必须是 [1,2] 之一'],
    [{ const: 1 }, 2, '$ must equal 1', '$ 必须等于 1'],
    [{ minimum: 2 }, 1, '$ must be >= 2', '$ 不能小于 2'],
    [{ maximum: 2 }, 3, '$ must be <= 2', '$ 不能大于 2'],
    [{ minLength: 2 }, 'a', '$ must be at least 2 characters', '$ 长度不能小于 2'],
    [{ minItems: 2 }, [], '$ needs at least 2 items', '$ 至少要有 2 项'],
    [{ maxItems: 0 }, [1], '$ allows at most 0 items', '$ 最多 0 项'],
    [{ required: ['x'] }, {}, '$ is missing field x', '$ 缺少字段 x'],
    [{ additionalProperties: false }, { x: 1 }, '$ must not have field x', '$ 不允许有字段 x'],
  ];
  try {
    for (const [schema, value, en, zh] of cases) {
      setLanguage('en'); assert.equal(validate(schema, value), en);
      setLanguage('zh'); assert.equal(validate(schema, value), zh);
    }
  } finally { setLanguage('en'); }
});

test('flow regression', () => {
  const s = {
    type: 'object',
    properties: { ok: { type: 'boolean' }, items: { type: 'array', items: { type: 'integer' } }, kind: { enum: ['x', 'y'] } },
    required: ['ok'],
    additionalProperties: false,
  };
  assert.equal(validate(s, { ok: true, items: [1, 2], kind: 'x' }), null);
  assert.match(validate(s, {}), /missing field ok/);
  assert.match(validate(s, { ok: 1 }), /\$\.ok should be boolean/);
  assert.match(validate(s, { ok: true, items: [1, 1.5] }), /\$\.items\[1\]/);
  assert.match(validate(s, { ok: true, z: 1 }), /must not have field z/);
  assert.match(validate(s, { ok: true, kind: 'q' }), /one of/);
});

test('a schema nested too deeply is refused with a message, not a crash', () => {
  setLanguage('en');
  let deep = { type: 'string' };
  for (let i = 0; i < 5000; i++) deep = { items: deep };
  assert.match(checkSchema(deep), /nested more than 200 levels deep/);
  let fine = { type: 'string' };
  for (let i = 0; i < 150; i++) fine = { items: fine };
  assert.equal(checkSchema(fine), null);
});

test('sample() makes data that matches the schema, for dry runs', () => {
  const schemas = [
    { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    { type: 'object', properties: { verdict: { enum: ['ok', 'bad'] }, score: { type: 'integer', minimum: 3, maximum: 5 }, ratio: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 } }, required: ['verdict', 'score'], additionalProperties: false },
    { type: 'object', properties: { tags: { type: 'array', items: { type: 'string', minLength: 8 }, minItems: 3, uniqueItems: true } }, required: ['tags'] },
    { type: 'object', properties: { pair: { type: 'array', prefixItems: [{ type: 'integer' }, { type: 'boolean' }], minItems: 2 } }, required: ['pair'] },
    { type: 'object', properties: { v: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 3 }] }, k: { const: 'fixed' } }, required: ['v', 'k'] },
    { type: 'object', allOf: [{ properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'integer' } }, required: ['b'] }] },
    { $defs: { item: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }, type: 'object', properties: { items: { type: 'array', items: { $ref: '#/$defs/item' } } }, required: ['items'] },
    { type: 'object', properties: { n: { type: ['null', 'integer'] }, x: { type: 'string', examples: ['picked'] } }, required: ['n', 'x'] },
  ];
  for (const s of schemas) {
    assert.equal(checkSchema(s), null, JSON.stringify(s));
    const v = sample(s);
    assert.equal(validate(s, v), null, JSON.stringify({ s, v }));
  }
  assert.deepEqual(sample(schemas[1]), { verdict: 'ok', score: 3, ratio: 1 });
  assert.equal(sample(schemas[7]).x, 'picked');
  // A pattern is not solved for: the caller sees that the sample does not match
  const hard = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } }, required: ['code'] };
  assert.equal(typeof validate(hard, sample(hard)), 'string');
});
