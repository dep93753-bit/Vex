// Minimal C++ parser for VEXcode IQ C++ programs.
// Produces the same AST shape as parse-python.js so one converter handles both.

class ParseError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

const OPS3 = ['<<=', '>>=', '...', '->*'];
const OPS2 = ['::', '->', '++', '--', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'];
const OPS1 = '+-*/%<>=!&|^~?:;,.()[]{}';

export function tokenizeCpp(src) {
  src = src.replace(/\r\n?/g, '\n');
  const toks = [];
  let i = 0, line = 1, lineStart = true;
  const n = src.length;
  const push = (t, v, extra) => toks.push(Object.assign({ t, v, line }, extra || {}));
  while (i < n) {
    const c = src[i];
    if (c === '\n') { i++; line++; lineStart = true; continue; }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '#' && lineStart) {
      // preprocessor line (with continuations)
      const startLine = line;
      let j = i;
      while (j < n && src[j] !== '\n') { if (src[j] === '\\' && src[j + 1] === '\n') { j += 2; line++; continue; } j++; }
      push('PP', src.slice(i, j), { line: startLine });
      i = j; continue;
    }
    lineStart = false;
    if (c === '/' && src[i + 1] === '/') {
      let j = i; while (j < n && src[j] !== '\n') j++;
      // comment is a "statement comment" if nothing but whitespace precedes it on its line
      const before = src.slice(src.lastIndexOf('\n', i - 1) + 1, i);
      push('COMMENT', src.slice(i + 2, j).trim(), { own: /^\s*$/.test(before) });
      i = j; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line;
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) { if (src[j] === '\n') line++; j++; }
      const before = src.slice(src.lastIndexOf('\n', i - 1) + 1, i);
      const text = src.slice(i + 2, j).split('\n').map(s => s.replace(/^\s*\*?\s?/, '')).join(' ').trim();
      push('COMMENT', text, { own: /^\s*$/.test(before), line: startLine });
      i = j + 2; continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let j = i + 1, val = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\n') throw new ParseError('Unterminated string', startLine);
        if (src[j] === '\\') {
          const nx = src[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
          val += map[nx] !== undefined ? map[nx] : nx; j += 2; continue;
        }
        val += src[j]; j++;
      }
      if (j >= n) throw new ParseError('Unterminated string', startLine);
      push(c === '"' ? 'STRING' : 'CHAR', val, { line: startLine });
      i = j + 1;
      continue;
    }
    const nm = /^(0[xX][0-9a-fA-F']+|0[bB][01']+|(\d[\d']*\.?[\d']*|\.\d[\d']*)([eE][+-]?\d+)?)[fFlLuU]*/.exec(src.slice(i, i + 64));
    if (nm && /[\d.]/.test(c) && !(c === '.' && !/\d/.test(src[i + 1] || ''))) {
      const raw = nm[1].replace(/'/g, '');
      const v = /^0[xX]/.test(raw) ? parseInt(raw, 16) : /^0[bB]/.test(raw) ? parseInt(raw.slice(2), 2) : parseFloat(raw);
      push('NUMBER', v, { raw: nm[0] });
      i += nm[0].length; continue;
    }
    const idm = /^[A-Za-z_][\w]*/.exec(src.slice(i, i + 200));
    if (idm) { push('NAME', idm[0]); i += idm[0].length; continue; }
    const op = OPS3.find(o => src.startsWith(o, i)) || OPS2.find(o => src.startsWith(o, i)) || (OPS1.includes(c) ? c : null);
    if (op) { push('OP', op); i += op.length; continue; }
    throw new ParseError(`Unexpected character '${c}'`, line);
  }
  push('EOF', null);
  return toks;
}

const TYPE_WORDS = new Set([
  'void', 'int', 'float', 'double', 'bool', 'char', 'long', 'short', 'unsigned', 'signed',
  'auto', 'const', 'static', 'volatile', 'constexpr', 'inline', 'extern', 'register', 'uint8_t',
  'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint64_t', 'size_t', 'string', 'std'
]);

export function parseCpp(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let toks;
  try { toks = tokenizeCpp(src); } catch (e) { return { body: [], fatal: { line: e.line || 1, msg: e.message } }; }
  // drop trailing (non-own-line) comments; keep own-line comments as statements
  toks = toks.filter(t => !(t.t === 'COMMENT' && !t.own));
  let p = 0;
  const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)];
  const next = () => toks[p++];
  const isOp = (v, o = 0) => peek(o).t === 'OP' && peek(o).v === v;
  const isName = (v, o = 0) => peek(o).t === 'NAME' && peek(o).v === v;
  const expectOp = (v) => { if (!isOp(v)) throw new ParseError(`Expected '${v}'`, peek().line); return next(); };
  const expectName = () => { if (peek().t !== 'NAME') throw new ParseError('Expected a name', peek().line); return next(); };
  const srcLine = (ln) => (lines[ln - 1] || '').trim();
  const pragmas = [];

  // ---- declarations ----
  // Try to read a type at position p. Returns {type, end} or null (doesn't move p).
  function tryType(at) {
    let q = at;
    const parts = [];
    const tk = (o) => toks[Math.min(q + o, toks.length - 1)];
    while (tk(0).t === 'NAME' && ['const', 'static', 'volatile', 'constexpr', 'inline', 'extern', 'unsigned', 'signed', 'long', 'short', 'register'].includes(tk(0).v)) { parts.push(tk(0).v); q++; }
    if (tk(0).t !== 'NAME') return parts.length ? { type: parts.join(' '), end: q } : null;
    // qualified name  a::b::c
    let name = tk(0).v; q++;
    while (tk(0).t === 'OP' && tk(0).v === '::' && tk(1).t === 'NAME') { name += '::' + tk(1).v; q += 2; }
    // template args
    if (tk(0).t === 'OP' && tk(0).v === '<') {
      let d = 0, r = q;
      for (; r < toks.length; r++) {
        const t = toks[r];
        if (t.t === 'OP' && t.v === '<') d++;
        else if (t.t === 'OP' && t.v === '>') { d--; if (d === 0) break; }
        else if (t.t === 'OP' && t.v === '>>') { d -= 2; if (d <= 0) break; }
        else if (t.t === 'OP' && (t.v === ';' || t.v === '{' || t.v === ')')) return null;
      }
      q = r + 1; name += '<>';
    }
    while (tk(0).t === 'NAME' && ['const', 'long', 'int', 'double'].includes(tk(0).v)) { name += ' ' + tk(0).v; q++; }
    while (tk(0).t === 'OP' && (tk(0).v === '*' || tk(0).v === '&' || tk(0).v === '&&')) { name += tk(0).v; q++; }
    parts.push(name);
    return { type: parts.join(' '), end: q };
  }
  // A declaration looks like: TYPE NAME ( '=' | ';' | ',' | '(' | '[' | '{' )
  function looksLikeDecl() {
    const ty = tryType(p);
    if (!ty) return null;
    const t = toks[ty.end];
    if (!t || t.t !== 'NAME') return null;
    const after = toks[ty.end + 1];
    if (!after || after.t !== 'OP' || !['=', ';', ',', '(', '[', '{'].includes(after.v)) return null;
    // "x = 5;" has no type; "a b = ..." does. Reject when the "type" is a known non-type keyword.
    if (['return', 'else', 'case', 'goto', 'delete', 'new', 'throw'].includes(toks[p].v)) return null;
    return ty;
  }

  function parseParams() {
    expectOp('(');
    const params = [];
    if (isName('void') && isOp(')', 1)) { next(); }
    while (!isOp(')')) {
      const ty = tryType(p);
      if (!ty) throw new ParseError('Could not read function parameter', peek().line);
      p = ty.end;
      let name = '';
      if (peek().t === 'NAME') name = next().v;
      let def = null, array = false;
      while (isOp('[')) { array = true; next(); while (!isOp(']') && peek().t !== 'EOF') next(); next(); }
      if (isOp('=')) { next(); def = parseAssignExpr(); }
      params.push({ name, type: ty.type, def, array });
      if (!isOp(')')) expectOp(',');
    }
    next();
    return params;
  }

  function parseDeclaration(ty, line) {
    // after type: one or more declarators
    p = ty.end;
    const out = [];
    const name = expectName().v;
    if (isOp('(')) {
      // function definition / prototype  OR  constructor-style init  "motor m(PORT1)"
      const save = p;
      let isFunc = false;
      try {
        const params = parseParams();
        if (isName('const')) next();
        if (isOp('{')) {
          const body = parseBraceBlock();
          return [{ k: 'func', name, params, retType: ty.type, body, line }];
        }
        const baseType = ty.type.replace(/^(const|static|inline|extern)\s+/g, '').split(/[\s*&]/)[0];
        if (isOp(';') && TYPE_WORDS.has(baseType) && params.every(pp => pp.name)) { next(); return [{ k: 'proto', name, line }]; }
        if (!isOp(';')) isFunc = true;
      } catch (e) {
        if (isFunc) throw e;
      }
      // ctor-style: TYPE NAME(args);
      p = save;
      expectOp('(');
      const args = [];
      while (!isOp(')')) { args.push(parseAssignExpr()); if (!isOp(')')) expectOp(','); }
      next();
      expectOp(';');
      return [{ k: 'decl', type: ty.type, name, ctorArgs: args, line }];
    }
    let cur = name;
    for (;;) {
      if (isOp('[')) throw new ParseError('Arrays are not supported in blocks', line);
      let value = null;
      if (isOp('=')) { next(); value = parseAssignExpr(); }
      else if (isOp('{')) { next(); if (!isOp('}')) value = parseAssignExpr(); expectOp('}'); }
      out.push({ k: 'decl', type: ty.type, name: cur, value, line });
      if (isOp(',')) { next(); while (isOp('*') || isOp('&')) next(); cur = expectName().v; continue; }
      break;
    }
    expectOp(';');
    return out;
  }

  // ---- statements ----
  function parseBraceBlock() {
    expectOp('{');
    const body = [];
    while (!isOp('}')) {
      if (peek().t === 'EOF') throw new ParseError("Missing '}'", peek().line);
      body.push(...parseStatementSafe());
    }
    next();
    return body;
  }
  function parseBody() {
    if (isOp('{')) return parseBraceBlock();
    return parseStatementSafe();
  }

  function skipStatement(startLine) {
    // skip to ';' at depth 0 or a balanced {...} block
    let d = 0, endLine = startLine;
    while (peek().t !== 'EOF') {
      const t = next();
      endLine = t.line;
      if (t.t === 'OP' && (t.v === '{' || t.v === '(' || t.v === '[')) d++;
      else if (t.t === 'OP' && (t.v === '}' || t.v === ')' || t.v === ']')) {
        d--;
        if (d <= 0 && t.v === '}') {
          // "} else ..." / "} while(...);" continue the same statement
          if (isName('else') || isName('while')) continue;
          if (isOp(';')) next();
          break;
        }
        if (d < 0) { p--; break; }
      } else if (t.t === 'OP' && t.v === ';' && d <= 0) break;
    }
    return endLine;
  }

  function parseStatementSafe(topLevel = false) {
    const start = p, startLine = peek().line;
    try {
      return parseStatement(topLevel);
    } catch (e) {
      p = start;
      if (isOp('}') && !topLevel) { next(); return []; }
      const endLine = skipStatement(startLine);
      return [{ k: 'unknown', line: startLine, endLine, text: srcLine(startLine), reason: e.message }];
    }
  }

  function parseStatement(topLevel) {
    const t = peek();
    const line = t.line;
    if (t.t === 'COMMENT') { next(); return t.v ? [{ k: 'comment', text: t.v, line }] : []; }
    if (t.t === 'PP') { next(); pragmas.push(t); return []; }
    if (t.t === 'OP') {
      if (t.v === ';') { next(); return []; }
      if (t.v === '{') { const b = parseBraceBlock(); return b; }
    }
    if (t.t === 'NAME') {
      switch (t.v) {
        case 'using': case 'typedef': case 'namespace':
          if (t.v === 'namespace') throw new ParseError('namespace blocks are not supported', line);
          while (!isOp(';') && peek().t !== 'EOF') next(); next(); return [];
        case 'if': return [parseIf()];
        case 'while': {
          next(); expectOp('('); const cond = parseExpr(); expectOp(')');
          if (isOp(';')) { next(); return [{ k: 'while', cond, body: [], line }]; }
          return [{ k: 'while', cond, body: parseBody(), line }];
        }
        case 'for': return [parseFor()];
        case 'do': throw new ParseError('do/while loops are not supported in blocks', line);
        case 'switch': throw new ParseError('switch is not supported in blocks', line);
        case 'goto': throw new ParseError('goto is not supported in blocks', line);
        case 'class': case 'struct': case 'enum': case 'union': case 'template':
          throw new ParseError(`'${t.v}' is not supported in blocks`, line);
        case 'break': next(); expectOp(';'); return [{ k: 'break', line }];
        case 'continue': next(); expectOp(';'); return [{ k: 'continue', line }];
        case 'return': {
          next();
          const value = isOp(';') ? null : parseExpr();
          expectOp(';');
          return [{ k: 'return', value, line }];
        }
        case 'repeat': {
          // VEXcode macro: repeat(n) { ... }
          if (isOp('(', 1)) {
            next(); expectOp('('); const count = parseExpr(); expectOp(')');
            return [{ k: 'for', target: null, iter: { k: 'call', fn: { k: 'name', id: 'range' }, args: [count], kwargs: {}, line }, body: parseBody(), line }];
          }
        }
      }
      const ty = looksLikeDecl();
      if (ty) return parseDeclaration(ty, line);
    }
    // expression statement
    const e = parseExprStatement();
    expectOp(';');
    return [e];
  }

  function parseIf() {
    const line = next().line;
    const branches = [];
    expectOp('('); const cond = parseExpr(); expectOp(')');
    branches.push({ cond, body: parseBody() });
    let orelse = null;
    while (isName('else')) {
      next();
      if (isName('if')) {
        next(); expectOp('('); const c = parseExpr(); expectOp(')');
        branches.push({ cond: c, body: parseBody() });
      } else { orelse = parseBody(); break; }
    }
    return { k: 'if', branches, orelse, line };
  }

  function parseFor() {
    const line = next().line;
    expectOp('(');
    // init
    let varName = null, startExpr = null;
    if (!isOp(';')) {
      const ty = looksLikeDecl();
      if (ty) p = ty.end;
      varName = expectName().v;
      if (isOp(':')) throw new ParseError('Range-based for loops are not supported', line);
      expectOp('=');
      startExpr = parseAssignExpr();
    }
    expectOp(';');
    const cond = isOp(';') ? null : parseExpr();
    expectOp(';');
    const inc = isOp(')') ? null : parseExprStatement();
    expectOp(')');
    const body = parseBody();
    // recognise: for (i = 0; i < N; i++)  ->  repeat N
    const isVar = (e) => e && e.k === 'name' && e.id === varName;
    if (varName && startExpr && startExpr.k === 'num' && cond && cond.k === 'cmp' && isVar(cond.l) &&
      (cond.op === '<' || cond.op === '<=') && inc &&
      ((inc.k === 'assign' && isVar(inc.target) && (inc.op === '+=' && inc.value.k === 'num' && inc.value.v === 1)) ||
        (inc.k === 'incdec' && isVar(inc.target) && inc.op === '++'))) {
      let count = cond.r;
      const s = startExpr.v;
      if (cond.op === '<=') count = count.k === 'num' ? { k: 'num', v: count.v + 1 } : { k: 'bin', op: '+', l: count, r: { k: 'num', v: 1 }, line };
      if (s !== 0) count = count.k === 'num' ? { k: 'num', v: count.v - s } : { k: 'bin', op: '-', l: count, r: { k: 'num', v: s }, line };
      return { k: 'for', target: { k: 'name', id: varName }, iter: { k: 'call', fn: { k: 'name', id: 'range' }, args: [count], kwargs: {}, line }, body, line };
    }
    throw new ParseError('Only simple counting for-loops (for i = 0; i < N; i++) can become a repeat block', line);
  }

  function parseExprStatement() {
    const line = peek().line;
    if (isOp('++') || isOp('--')) { const op = next().v; const target = parseUnary(); return { k: 'incdec', op, target, line }; }
    const lhs = parseTernary();
    if (isOp('++') || isOp('--')) { const op = next().v; return { k: 'incdec', op, target: lhs, line }; }
    const assignOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
    if (peek().t === 'OP' && assignOps.includes(peek().v)) {
      const op = next().v;
      const value = parseAssignExpr();
      return { k: 'assign', target: lhs, op, value, line };
    }
    if (isOp(',')) throw new ParseError('Comma expressions are not supported', line);
    return { k: 'expr', e: lhs, line };
  }

  // ---- expressions ----
  function parseAssignExpr() {
    const e = parseTernary();
    if (peek().t === 'OP' && ['=', '+=', '-=', '*=', '/='].includes(peek().v)) throw new ParseError('Assignments inside expressions are not supported', e.line);
    return e;
  }
  function parseExpr() { return parseAssignExpr(); }
  function parseTernary() {
    const c = parseOr();
    if (isOp('?')) {
      next(); const a = parseAssignExpr(); expectOp(':'); const b = parseAssignExpr();
      return { k: 'ternary', cond: c, a, b, line: c.line };
    }
    return c;
  }
  function left(nextFn, ops, mk) {
    return function () {
      let l = nextFn();
      while (peek().t === 'OP' && ops.includes(peek().v)) {
        const op = next().v;
        l = mk(op, l, nextFn());
      }
      return l;
    };
  }
  const parseUnaryW = () => parseUnary();
  const parseMul = left(parseUnaryW, ['*', '/', '%'], (op, l, r) => ({ k: 'bin', op, l, r, line: l.line }));
  const parseAdd = left(parseMul, ['+', '-'], (op, l, r) => ({ k: 'bin', op, l, r, line: l.line }));
  const parseShift = left(parseAdd, ['<<', '>>'], (op, l, r) => ({ k: 'bin', op, l, r, line: l.line }));
  const parseRel = left(parseShift, ['<', '>', '<=', '>='], (op, l, r) => ({ k: 'cmp', op, l, r, line: l.line }));
  const parseEq = left(parseRel, ['==', '!='], (op, l, r) => ({ k: 'cmp', op, l, r, line: l.line }));
  const parseBand = left(parseEq, ['&'], (op, l, r) => ({ k: 'bin', op, l, r, line: l.line }));
  const parseBxor = left(parseBand, ['^'], (op, l, r) => ({ k: 'bin', op, l, r, line: l.line }));
  const parseBor = left(parseBxor, ['|'], (op, l, r) => ({ k: 'bin', op, l, r, line: l.line }));
  const parseAnd = left(parseBor, ['&&'], (op, l, r) => ({ k: 'logic', op: 'and', l, r, line: l.line }));
  const parseOr = left(parseAnd, ['||'], (op, l, r) => ({ k: 'logic', op: 'or', l, r, line: l.line }));

  function parseUnary() {
    const t = peek();
    if (t.t === 'OP') {
      if (t.v === '!') { next(); return { k: 'not', e: parseUnary(), line: t.line }; }
      if (t.v === '-') { next(); const e = parseUnary(); return e.k === 'num' ? { k: 'num', v: -e.v, line: t.line } : { k: 'neg', e, line: t.line }; }
      if (t.v === '+') { next(); return parseUnary(); }
      if (t.v === '~') { next(); return { k: 'bitnot', e: parseUnary(), line: t.line }; }
      if (t.v === '++' || t.v === '--') throw new ParseError('++/-- inside expressions is not supported', t.line);
      if (t.v === '*' || t.v === '&') throw new ParseError('Pointers are not supported in blocks', t.line);
      if (t.v === '(') {
        // C-style cast: (float)x
        const ty = tryType(p + 1);
        if (ty && toks[ty.end] && toks[ty.end].t === 'OP' && toks[ty.end].v === ')' &&
          (TYPE_WORDS.has(toks[p + 1].v))) {
          p = ty.end + 1;
          return parseUnary();
        }
      }
    }
    if (t.t === 'NAME' && t.v === 'sizeof') throw new ParseError('sizeof is not supported', t.line);
    return parsePostfix();
  }
  function parsePostfix() {
    let e = parseAtom();
    for (;;) {
      if (isOp('.') || isOp('->')) { next(); const name = expectName().v; e = { k: 'attr', obj: e, name, line: e.line }; }
      else if (isOp('(')) {
        next();
        const args = [];
        while (!isOp(')')) { args.push(parseAssignExpr()); if (!isOp(')')) expectOp(','); }
        next();
        e = { k: 'call', fn: e, args, kwargs: {}, line: e.line };
      } else if (isOp('[')) {
        next(); const idx = parseExpr(); expectOp(']');
        e = { k: 'index', obj: e, idx, line: e.line };
      } else break;
    }
    return e;
  }
  function parseAtom() {
    const t = peek();
    if (t.t === 'NUMBER') { next(); return { k: 'num', v: t.v, raw: t.raw, line: t.line }; }
    if (t.t === 'STRING') {
      next(); let v = t.v;
      while (peek().t === 'STRING') v += next().v;
      return { k: 'str', v, line: t.line };
    }
    if (t.t === 'CHAR') { next(); return { k: 'str', v: t.v, line: t.line }; }
    if (t.t === 'NAME') {
      next();
      if (t.v === 'true' || t.v === 'false') return { k: 'bool', v: t.v === 'true', line: t.line };
      if (t.v === 'nullptr' || t.v === 'NULL') return { k: 'none', line: t.line };
      if (['static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast'].includes(t.v)) {
        // static_cast<T>(x) -> x
        expectOp('<'); let d = 1;
        while (d > 0 && peek().t !== 'EOF') { const x = next(); if (x.t === 'OP' && x.v === '<') d++; if (x.t === 'OP' && x.v === '>') d--; if (x.t === 'OP' && x.v === '>>') d -= 2; }
        expectOp('('); const e = parseExpr(); expectOp(')');
        return e;
      }
      if (t.v === 'new' || t.v === 'delete' || t.v === 'this') throw new ParseError(`'${t.v}' is not supported in blocks`, t.line);
      // qualified names: vex::forward, std::abs, colorType::none
      let id = t.v;
      const quals = [];
      while (isOp('::') && peek(1).t === 'NAME') { next(); quals.push(id); id = next().v; }
      return { k: 'name', id, quals, line: t.line };
    }
    if (t.t === 'OP' && t.v === '(') {
      next(); const e = parseExpr(); expectOp(')');
      return { k: 'paren', e, line: t.line };
    }
    if (t.t === 'OP' && t.v === '::') { next(); return parseAtom(); }
    throw new ParseError('Unexpected ' + (t.v ?? t.t), t.line);
  }

  const body = [];
  while (peek().t !== 'EOF') {
    if (isOp('}')) { next(); continue; }
    body.push(...parseStatementSafe(true));
  }
  return { body, pragmas };
}
