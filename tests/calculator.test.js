import assert from 'node:assert/strict';
import test from 'node:test';
import { createCalculatorTools, evaluateExpression } from '../src/tools/calculator.js';
import { ValidationError } from '../src/utils/errors.js';

test('evaluateExpression honours precedence, associativity and unary signs', () => {
  assert.equal(evaluateExpression('2 + 3 * 4'), 14);
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateExpression('2 ^ 3 ^ 2'), 512, '^ is right associative');
  assert.equal(evaluateExpression('2 ^ -1'), 0.5, 'signed exponent');
  assert.equal(evaluateExpression('-2 ^ 2'), -4, 'unary minus binds tighter than ^');
  assert.equal(evaluateExpression('10 % 3'), 1);
  assert.equal(evaluateExpression('1_000 + 24'), 1024, 'digit separators are allowed');
  assert.equal(evaluateExpression('21 * 2'), 42);
});

test('evaluateExpression supports constants and the function whitelist', () => {
  assert.equal(evaluateExpression('sqrt(16) + abs(-2)'), 6);
  assert.equal(evaluateExpression('round(3.14159, 2)'), 3.14);
  assert.equal(evaluateExpression('max(1, 7, 3) - min(1, 7, 3)'), 6);
  assert.equal(evaluateExpression('floor(2.9)'), 2);
  assert.ok(Math.abs(evaluateExpression('pi') - Math.PI) < 1e-12);
  assert.ok(Math.abs(evaluateExpression('log(1000)') - 3) < 1e-12);
});

test('evaluateExpression rejects anything outside the arithmetic grammar', () => {
  assert.throws(() => evaluateExpression('1 / 0'), ValidationError);
  assert.throws(() => evaluateExpression('process.exit(1)'), ValidationError);
  assert.throws(() => evaluateExpression('require("fs")'), ValidationError);
  assert.throws(() => evaluateExpression('1; rm -rf /'), /Unsupported character/);
  assert.throws(() => evaluateExpression('1 + '), /Unexpected end of expression/);
  assert.throws(() => evaluateExpression('('), ValidationError);
  assert.throws(() => evaluateExpression(''), /must not be empty/);
  assert.throws(() => evaluateExpression('x'.repeat(501)), /too long/);
  assert.throws(() => evaluateExpression('unknownFn(2)'), /Unknown identifier/);
});

test('calculator tool returns a structured, rounded result', async () => {
  const [tool] = createCalculatorTools();
  assert.equal(tool.name, 'calculator.eval');
  assert.equal(tool.sideEffects, false);

  const output = await tool.handler({ expression: '(21 * 2) + sqrt(16)' });
  assert.equal(output.expression, '(21 * 2) + sqrt(16)');
  assert.equal(output.result, 46);
  assert.equal(output.rounded, 46);
});
