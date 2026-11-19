// Minimal Python parser for VEXcode IQ Python programs.
// Produces the shared AST described in ast.md-style comments in convert.js.
// Anything it can't understand becomes an {k:'unknown'} statement so the
// converter can flag it instead of crashing.

const KEYWORDS = new Set([
  'if', 'elif', 'else', 'while', 'for', 'in', 'def', 'return', 'break', 'continue',
  'pass', 'global', 'nonlocal', 'import', 'from', 'class', 'try', 'except', 'finally',
  'with', 'as', 'and', 'or', 'not', 'is', 'lambda', 'None', 'True', 'False', 'del',
  'raise', 'assert', 'yield', 'async', 'await'
]);

const OPS3 = ['**=', '//=', '>>=', '<<=', '...'];
const OPS2 = ['**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->', '<<', '>>', ':='];
const OPS1 = '+-*/%<>=()[]{},:.;@&|^~';

class ParseError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

export function tokenizePython(src) {
  src = src.replace(/\r\n?/g, '\n');
  const toks = [];
  const indents = [0];
  let i = 0, line = 1, depth = 0, atLineStart = true;
  const n = src.length;
  const push = (t, v, extra) => toks.push(Object.assign({ t, v, line }, extra || {}));

  while (i < n) {
    if (atLineStart && depth === 0) {
      // measure indentation
      let col = 0, j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\f')) {
        col = src[j] === '\t' ? (Math.floor(col / 8) + 1) * 8 : col + 1;
        j++;
      }
      if (j >= n) { i = j; break; }
      if (src[j] === '\n') { i = j + 1; line++; continue; } // blank line
      if (src[j] === '#') {
        // comment-only line: emit as COMMENT statement token, no indent change
        let k = j; while (k < n && src[k] !== '\n') k++;
        push('COMMENT', src.slice(j + 1, k).trim(), { col });
        i = k; continue;
      }
      if (src[j] === '\\' && src[j + 1] === '\n') { i = j + 2; line++; continue; }
      const top = indents[indents.length - 1];
      if (col > top) { indents.push(col); push('INDENT', col); }
      else if (col < top) {
        while (indents.length > 1 && col < indents[indents.length - 1]) { indents.pop(); push('DEDENT', col); }
        if (col !== indents[indents.length - 1]) throw new ParseError('Indentation does not line up', line);
      }
      i = j; atLineStart = false;
    }
    const c = src[i];
    if (c === '\n') {
      if (depth === 0) { push('NEWLINE', '\n'); atLineStart = true; }
      i++; line++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }

    // strings (with optional prefix)
    const sm = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5));
    if (sm && (sm[1] === '' || /^[A-Za-z]/.test(c))) {
      const prefix = sm[1].toLowerCase(), q = sm[2];
      let j = i + sm[0].length, val = '';
      const startLine = line;
      for (;;) {
        if (j >= n) throw new ParseError('Unterminated string', startLine);
        if (src.startsWith(q, j)) { j += q.length; break; }
        const ch = src[j];
        if (ch === '\n') { if (q.length === 1) throw new ParseError('Unterminated string', startLine); line++; }
        if (ch === '\\' && !prefix.includes('r')) {
          const nx = src[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
          if (nx === '\n') { line++; j += 2; continue; }
          val += map[nx] !== undefined ? map[nx] : '\\' + nx; j += 2; continue;
        }
        val += ch; j++;
      }
      toks.push({ t: 'STRING', v: val, line: startLine, fstr: prefix.includes('f') });
      i = j; continue;
    }
    // numbers
    const nm = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)([eE][+-]?\d+)?)[jJ]?/.exec(src.slice(i, i + 64));
    if (nm && /[\d.]/.test(c) && !(c === '.' && !/\d/.test(src[i + 1] || ''))) {
      const raw = nm[0].replace(/_/g, '');
      let v;
      if (/^0[xX]/.test(raw)) v = parseInt(raw, 16);
      else if (/^0[bB]/.test(raw)) v = parseInt(raw.slice(2), 2);
      else if (/^0[oO]/.test(raw)) v = parseInt(raw.slice(2), 8);
      else v = parseFloat(raw);
      push('NUMBER', v, { raw: nm[0] });
      i += nm[0].length; continue;
    }
    // names
    const idm = /^[A-Za-z_À-￿][\wÀ-￿]*/.exec(src.slice(i, i + 200));
    if (idm) { push('NAME', idm[0]); i += idm[0].length; continue; }
    // operators
    let op = OPS3.find(o => src.startsWith(o, i)) || OPS2.find(o => src.startsWith(o, i));
    if (!op && OPS1.includes(c)) op = c;
    if (op) {
      if ('([{'.includes(op)) depth++;
      if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
      push('OP', op); i += op.length; continue;
    }
    throw new ParseError(`Unexpected character '${c}'`, line);
  }
  if (!atLineStart) push('NEWLINE', '\n');
  while (indents.length > 1) { indents.pop(); push('DEDENT', 0); }
  push('EOF', null);
  return toks;
}

export function parsePython(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let toks;
  try {
    toks = tokenizePython(src);
  } catch (e) {
    return { body: [], fatal: { line: e.line || 1, msg: e.message } };
  }
  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const next = () => toks[p++];
  const isOp = (v, o = 0) => peek(o).t === 'OP' && peek(o).v === v;
  const isKw = (v, o = 0) => peek(o).t === 'NAME' && peek(o).v === v;
  const expectOp = (v) => { if (!isOp(v)) throw new ParseError(`Expected '${v}'`, peek().line); return next(); };
  const expectT = (t) => { if (peek().t !== t) throw new ParseError(`Expected ${t}`, peek().line); return next(); };
  const srcLine = (ln) => (lines[ln - 1] || '').trim();

  function parseBlock() {
    // after ':' -> either simple statement on same line, or NEWLINE INDENT stmts DEDENT
    if (peek().t !== 'NEWLINE') {
      const s = parseSimpleLine();
      return s;
    }
    next();
    const body = [];
    // comments may appear before INDENT
    const pre = [];
    while (peek().t === 'COMMENT') pre.push(stmtComment(next()));
    if (peek().t !== 'INDENT') throw new ParseError('Expected an indented block', peek().line);
    next();
    body.push(...pre);
    while (peek().t !== 'DEDENT' && peek().t !== 'EOF') body.push(...parseStatementSafe());
    if (peek().t === 'DEDENT') next();
    return body;
  }

  function stmtComment(tok) { return { k: 'comment', text: tok.v, line: tok.line }; }

  function skipRestOfStatement(startLine) {
    // skip to end of the logical line; if a block follows, skip it too
    while (peek().t !== 'NEWLINE' && peek().t !== 'EOF') next();
    if (peek().t === 'NEWLINE') next();
    while (peek().t === 'COMMENT') next();
    let endLine = startLine;
    if (peek().t === 'INDENT') {
      let d = 0;
      do {
        const t = next();
        if (t.t === 'INDENT') d++;
        else if (t.t === 'DEDENT') d--;
        else if (t.t !== 'NEWLINE') endLine = Math.max(endLine, t.line);
      } while (d > 0 && peek().t !== 'EOF');
    }
    return endLine;
  }

  function parseStatementSafe() {
    const start = p;
    const startLine = peek().line;
    try {
      return parseStatement();
    } catch (e) {
      p = start;
      const endLine = skipRestOfStatement(startLine);
      return [{ k: 'unknown', line: startLine, endLine, text: srcLine(startLine), reason: e.message }];
    }
  }

  function parseStatement() {
    const tok = peek();
    if (tok.t === 'COMMENT') { next(); return [stmtComment(tok)]; }
    if (tok.t === 'NAME') {
      switch (tok.v) {
        case 'if': return [parseIf()];
        case 'while': {
          next(); const cond = parseExpr(); expectOp(':');
          const body = parseBlock();
          if (isKw('else')) throw new ParseError('while/else is not supported', peek().line);
          return [{ k: 'while', cond, body, line: tok.line }];
        }
        case 'for': {
          next();
          const target = parseTargetList();
          if (!isKw('in')) throw new ParseError("Expected 'in'", peek().line);
          next();
          const iter = parseExprList();
          expectOp(':');
          const body = parseBlock();
          if (isKw('else')) throw new ParseError('for/else is not supported', peek().line);
          return [{ k: 'for', target, iter, body, line: tok.line }];
        }
        case 'def': {
          next();
          const name = expectT('NAME').v;
          expectOp('(');
          const params = [];
          while (!isOp(')')) {
            if (isOp('*') || isOp('**') || isOp('/')) throw new ParseError('*args/**kwargs are not supported', tok.line);
            const pn = expectT('NAME').v;
            let def = null;
            if (isOp(':')) { next(); parseExpr(); } // type hint
            if (isOp('=')) { next(); def = parseExpr(); }
            params.push({ name: pn, def });
            if (!isOp(')')) expectOp(',');
          }
          next();
          if (isOp('->')) { next(); parseExpr(); }
          expectOp(':');
          const body = parseBlock();
          return [{ k: 'func', name, params, body, line: tok.line }];
        }
        case 'class': case 'try': case 'with': case 'async': case 'lambda':
          throw new ParseError(`'${tok.v}' is not supported in blocks`, tok.line);
        case 'elif': case 'else': case 'except': case 'finally':
          throw new ParseError(`Unexpected '${tok.v}'`, tok.line);
      }
    }
    return parseSimpleLine();
  }

  function parseIf() {
    const tok = next();
    const branches = [];
    const cond = parseExpr(); expectOp(':');
    branches.push({ cond, body: parseBlock() });
    let orelse = null;
    for (;;) {
      if (isKw('elif')) {
        next(); const c = parseExpr(); expectOp(':');
        branches.push({ cond: c, body: parseBlock() });
      } else if (isKw('else')) {
        next(); expectOp(':'); orelse = parseBlock(); break;
      } else break;
    }
    return { k: 'if', branches, orelse, line: tok.line };
  }

  function parseSimpleLine() {
    const out = [];
    for (;;) {
      out.push(parseSmall());
      if (isOp(';')) { next(); if (peek().t === 'NEWLINE') break; continue; }
      break;
    }
    if (peek().t === 'NEWLINE') next();
    else if (peek().t !== 'EOF' && peek().t !== 'DEDENT') throw new ParseError('Unexpected ' + (peek().v ?? peek().t), peek().line);
    return out;
  }

  function parseSmall() {
    const tok = peek();
    const line = tok.line;
    if (tok.t === 'NAME') {
      switch (tok.v) {
        case 'pass': next(); return { k: 'pass', line };
        case 'break': next(); return { k: 'break', line };
        case 'continue': next(); return { k: 'continue', line };
        case 'return': {
          next();
          const value = (peek().t === 'NEWLINE' || isOp(';') || peek().t === 'EOF') ? null : parseExprList();
          return { k: 'return', value, line };
        }
        case 'global': case 'nonlocal': {
          next(); const names = [expectT('NAME').v];
          while (isOp(',')) { next(); names.push(expectT('NAME').v); }
          return { k: 'global', names, line };
        }
        case 'import': case 'from': {
          while (peek().t !== 'NEWLINE' && !isOp(';') && peek().t !== 'EOF') next();
          return { k: 'import', line };
        }
        case 'del': case 'raise': case 'assert': case 'yield':
          throw new ParseError(`'${tok.v}' is not supported in blocks`, line);
      }
    }
    const lhs = parseExprList();
    if (isOp('=')) {
      next();
      const value = parseExprList();
      if (isOp('=')) throw new ParseError('Chained assignment is not supported', line);
      return { k: 'assign', target: lhs, op: '=', value, line };
    }
    const aug = ['+=', '-=', '*=', '/=', '%=', '//=', '**=', '&=', '|=', '^=', '>>=', '<<='];
    if (peek().t === 'OP' && aug.includes(peek().v)) {
      const op = next().v;
      const value = parseExprList();
      return { k: 'assign', target: lhs, op, value, line };
    }
    if (isOp(':')) { // annotated assignment  x: int = 5
      next(); parseExpr();
      if (isOp('=')) { next(); const value = parseExprList(); return { k: 'assign', target: lhs, op: '=', value, line }; }
      return { k: 'pass', line };
    }
    return { k: 'expr', e: lhs, line };
  }

  function parseTargetList() {
    const first = parseBitOr();
    if (isOp(',')) {
      const items = [first];
      while (isOp(',')) { next(); if (isKw('in')) break; items.push(parseBitOr()); }
      return { k: 'tuple', items, line: first.line };
    }
    return first;
  }

  function parseExprList() {
    const first = parseExpr();
    if (isOp(',')) {
      const items = [first];
      while (isOp(',')) {
        next();
        if (peek().t === 'NEWLINE' || isOp('=') || isOp(')') || isOp(':')) break;
        items.push(parseExpr());
      }
      return { k: 'tuple', items, line: first.line };
    }
    return first;
  }

  function parseExpr() {
    if (isKw('lambda')) throw new ParseError('lambda is not supported in blocks', peek().line);
    const e = parseOr();
    if (isKw('if')) {
      // conditional expression
      next(); const c = parseOr();
      if (!isKw('else')) throw new ParseError("Expected 'else'", peek().line);
      next(); const o = parseExpr();
      return { k: 'ternary', cond: c, a: e, b: o, line: e.line };
    }
    return e;
  }
  function parseOr() {
    let l = parseAnd();
    while (isKw('or')) { const line = next().line; l = { k: 'logic', op: 'or', l, r: parseAnd(), line }; }
    return l;
  }
  function parseAnd() {
    let l = parseNot();
    while (isKw('and')) { const line = next().line; l = { k: 'logic', op: 'and', l, r: parseNot(), line }; }
    return l;
  }
  function parseNot() {
    if (isKw('not')) { const line = next().line; return { k: 'not', e: parseNot(), line }; }
    return parseCompare();
  }
  function parseCompare() {
    const first = parseBitOr();
    const ops = [], rest = [];
    for (;;) {
      let op = null;
      if (peek().t === 'OP' && ['<', '>', '==', '>=', '<=', '!='].includes(peek().v)) op = next().v;
      else if (isKw('in')) { next(); op = 'in'; }
      else if (isKw('not') && isKw('in', 1)) { next(); next(); op = 'not in'; }
      else if (isKw('is')) { next(); op = 'is'; if (isKw('not')) { next(); op = 'is not'; } }
      if (!op) break;
      ops.push(op); rest.push(parseBitOr());
    }
    if (!ops.length) return first;
    // chain a < b < c  ->  (a<b) and (b<c)
    let result = null, left = first;
    ops.forEach((op, idx) => {
      const c = { k: 'cmp', op, l: left, r: rest[idx], line: first.line };
      result = result ? { k: 'logic', op: 'and', l: result, r: c, line: first.line } : c;
      left = rest[idx];
    });
    return result;
  }
  function binLevel(nextFn, ops) {
    return function () {
      let l = nextFn();
      while (peek().t === 'OP' && ops.includes(peek().v)) {
        const op = next().v;
        l = { k: 'bin', op, l, r: nextFn(), line: l.line };
      }
      return l;
    };
  }
  const parseFactorLevel = () => parseUnary();
  const parseTerm = binLevel(parseFactorLevel, ['*', '/', '//', '%', '@']);
  const parseArith = binLevel(parseTerm, ['+', '-']);
  const parseShift = binLevel(parseArith, ['<<', '>>']);
  const parseBitAnd = binLevel(parseShift, ['&']);
  const parseBitXor = binLevel(parseBitAnd, ['^']);
  const parseBitOr = binLevel(parseBitXor, ['|']);

  function parseUnary() {
    if (isOp('-') || isOp('+') || isOp('~')) {
      const t = next();
      const e = parseUnary();
      if (t.v === '+') return e;
      if (t.v === '~') return { k: 'bitnot', e, line: t.line };
      if (e.k === 'num') return { k: 'num', v: -e.v, line: t.line };
      return { k: 'neg', e, line: t.line };
    }
    return parsePower();
  }
  function parsePower() {
    let base = parsePostfix();
    if (isOp('**')) { const line = next().line; return { k: 'bin', op: '**', l: base, r: parseUnary(), line }; }
    return base;
  }
  function parsePostfix() {
    let e = parseAtom();
    for (;;) {
      if (isOp('.')) { next(); const name = expectT('NAME').v; e = { k: 'attr', obj: e, name, line: e.line }; }
      else if (isOp('(')) {
        next();
        const args = [], kwargs = {};
        while (!isOp(')')) {
          if (isOp('*') || isOp('**')) throw new ParseError('*args are not supported', peek().line);
          if (peek().t === 'NAME' && isOp('=', 1)) {
            const kn = next().v; next(); kwargs[kn] = parseExpr();
          } else args.push(parseExpr());
          if (!isOp(')')) expectOp(',');
        }
        next();
        e = { k: 'call', fn: e, args, kwargs, line: e.line };
      } else if (isOp('[')) {
        next(); const idx = parseExprList(); expectOp(']');
        e = { k: 'index', obj: e, idx, line: e.line };
      } else break;
    }
    return e;
  }
  function parseAtom() {
    const t = peek();
    if (t.t === 'NUMBER') { next(); return { k: 'num', v: t.v, raw: t.raw, line: t.line }; }
    if (t.t === 'STRING') {
      next(); let v = t.v, f = t.fstr;
      while (peek().t === 'STRING') { const s = next(); v += s.v; f = f || s.fstr; }
      return { k: 'str', v, fstr: f, line: t.line };
    }
    if (t.t === 'NAME') {
      if (t.v === 'True' || t.v === 'False') { next(); return { k: 'bool', v: t.v === 'True', line: t.line }; }
      if (t.v === 'None') { next(); return { k: 'none', line: t.line }; }
      if (KEYWORDS.has(t.v) && !['print'].includes(t.v)) throw new ParseError(`Unexpected '${t.v}'`, t.line);
      next(); return { k: 'name', id: t.v, line: t.line };
    }
    if (t.t === 'OP') {
      if (t.v === '(') {
        next();
        if (isOp(')')) { next(); return { k: 'tuple', items: [], line: t.line }; }
        const e = parseExprList(); expectOp(')');
        return e.k === 'tuple' ? e : { k: 'paren', e, line: t.line };
      }
      if (t.v === '[') {
        next(); const items = [];
        while (!isOp(']')) { items.push(parseExpr()); if (isKw('for')) throw new ParseError('List comprehensions are not supported', t.line); if (!isOp(']')) expectOp(','); }
        next(); return { k: 'list', items, line: t.line };
      }
      if (t.v === '{') throw new ParseError('Dictionaries/sets are not supported in blocks', t.line);
    }
    throw new ParseError('Unexpected ' + (t.v ?? t.t), t.line);
  }

  const body = [];
  while (peek().t !== 'EOF') {
    if (peek().t === 'INDENT' || peek().t === 'DEDENT' || peek().t === 'NEWLINE') { next(); continue; }
    body.push(...parseStatementSafe());
  }
  return { body };
}
