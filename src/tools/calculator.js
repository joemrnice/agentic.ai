import { defineTool } from '../core/registry.js';
import { ValidationError } from '../utils/errors.js';

const CONSTANTS = Object.freeze({ pi: Math.PI, e: Math.E, tau: Math.PI * 2 });

const FUNCTIONS = Object.freeze({
  abs: Math.abs,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  ln: Math.log,
  log: Math.log10,
  log10: Math.log10,
  log2: Math.log2,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  round: (value, digits = 0) => Number(value.toFixed(Math.max(0, Math.min(15, Number(digits) || 0)))),
  sign: Math.sign,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
});

function tokenize(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      let end = index;
      while (end < source.length && /[0-9._]/.test(source[end])) end += 1;
      const raw = source.slice(index, end).replace(/_/g, '');
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new ValidationError(`Invalid number literal "${raw}"`);
      tokens.push({ type: 'number', value, index });
      index = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      tokens.push({ type: 'identifier', value: source.slice(index, end).toLowerCase(), index });
      index = end;
      continue;
    }

    if ('+-*/%^(),'.includes(char)) {
      tokens.push({ type: 'operator', value: char, index });
      index += 1;
      continue;
    }

    throw new ValidationError(`Unsupported character "${char}" at position ${index}`);
  }

  return tokens;
}

/**
 * Evaluate an arithmetic expression with a recursive-descent parser.
 *
 * Deterministic, sandboxed and side-effect free -- deliberately **not** `eval`,
 * because a tool that executes model-authored JavaScript is a remote code
 * execution hole. Supports `+ - * / % ^`, parentheses, unary signs, the
 * constants `pi`/`e`/`tau` and a whitelist of math functions.
 */
export function evaluateExpression(input) {
  const source = String(input ?? '').trim();
  if (source === '') throw new ValidationError('Expression must not be empty');
  if (source.length > 500) throw new ValidationError('Expression is too long (max 500 characters)');

  const tokens = tokenize(source);
  if (tokens.length === 0) throw new ValidationError('Expression must not be empty');

  let position = 0;
  const peek = () => tokens[position];
  const advance = () => tokens[position++];

  function parseExpression() {
    let left = parseTerm();
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const operator = advance().value;
      const right = parseTerm();
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  }

  const parsePrimary = () => {
    const token = advance();
    if (!token) throw new ValidationError('Unexpected end of expression');

    if (token.type === 'number') return token.value;

    if (token.type === 'identifier') {
      if (Object.hasOwn(CONSTANTS, token.value)) return CONSTANTS[token.value];
      const fn = FUNCTIONS[token.value];
      if (!fn) throw new ValidationError(`Unknown identifier "${token.value}" (position ${token.index})`);

      const open = advance();
      if (!open || open.value !== '(') throw new ValidationError(`Expected "(" after function name "${token.value}"`);

      const args = [];
      if (peek() && peek().value !== ')') {
        args.push(parseExpression());
        while (peek() && peek().value === ',') {
          advance();
          args.push(parseExpression());
        }
      }

      const closing = advance();
      if (!closing || closing.value !== ')') throw new ValidationError(`Missing closing parenthesis in call to "${token.value}"`);

      let value;
      try {
        value = fn(...args);
      } catch (error) {
        throw new ValidationError(`Function "${token.value}" failed: ${error.message}`);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(`Function "${token.value}" returned a non-finite result`);
      }
      return value;
    }

    if (token.value === '(') {
      const value = parseExpression();
      const closing = advance();
      if (!closing || closing.value !== ')') throw new ValidationError(`Missing closing parenthesis at position ${token.index}`);
      return value;
    }

    throw new ValidationError(`Unexpected token "${token.value}" at position ${token.index}`);
  };

  const parsePower = () => {
    const base = parsePrimary();
    if (peek() && peek().value === '^') {
      advance();
      // Parsing the exponent with parseUnary() keeps `^` right associative
      // (2^3^2 === 512) while still allowing a signed exponent (2^-1 === 0.5).
      return base ** parseUnary();
    }
    return base;
  };

  function parseUnary() {
    const token = peek();
    if (token && token.value === '-') {
      advance();
      return -parseUnary();
    }
    if (token && token.value === '+') {
      advance();
      return parseUnary();
    }
    return parsePower();
  }

  function parseTerm() {
    let left = parseUnary();
    while (peek() && ['*', '/', '%'].includes(peek().value)) {
      const operator = advance().value;
      const right = parseUnary();
      if ((operator === '/' || operator === '%') && right === 0) throw new ValidationError('Division by zero');
      if (operator === '*') left *= right;
      else if (operator === '/') left /= right;
      else left %= right;
    }
    return left;
  }

  const result = parseExpression();
  if (position < tokens.length) {
    throw new ValidationError(`Unexpected token "${tokens[position].value}" at position ${tokens[position].index}`);
  }
  if (!Number.isFinite(result)) throw new ValidationError('Result is not a finite number');
  return result;
}

/** Deterministic arithmetic without shelling out and without `eval`. */
export function createCalculatorTools() {
  return [
    defineTool({
      name: 'calculator.eval',
      description:
        'Evaluate a deterministic arithmetic expression and return the numeric result. Supports + - * / % ^, parentheses, unary minus, the constants pi/e/tau and the functions abs, round, floor, ceil, min, max, pow, sqrt, ln, log (base 10), log2, exp, sin, cos, tan. Use it for any non-trivial arithmetic so percents and totals are verified rather than guessed.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', minLength: 1, maxLength: 500, description: 'Arithmetic expression, e.g. "(21 * 2) + sqrt(16)".' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      tags: ['math', 'deterministic'],
      handler: ({ expression }) => {
        const result = evaluateExpression(expression);
        return { expression, result, rounded: Number(result.toPrecision(12)) };
      },
    }),
  ];
}
