import { loadFrom } from './modules.mjs';
import { mapSelector } from './selector.mjs';

const DEFAULT_SELECTOR_CALLEES = ['querySelector', 'querySelectorAll', 'closest', 'matches', '$', '$$'];
const DEFAULT_CLASS_CALLEES = ['clsx', 'cn', 'cx', 'classNames', 'classnames', 'twMerge', 'cva'];
const CLASSLIST_METHODS = new Set(['add', 'remove', 'toggle', 'contains', 'replace']);
const HTML_CLASS_ATTR = /(\bclass(?:Name)?\s*=\s*\\?)(["'])([^"'\\]*)(\\?)\2/g;

const mapTokens = (raw, map) => raw.replace(/\S+/g, (t) => (map.has(t) ? map.get(t) : t));

// Rewrite class names in one TS/TSX/JS file. `map` is original -> hashed. Anything that cannot be rewritten with
// certainty is returned in `issues` (the caller fails the run on them) instead of being guessed at.
export function processSource(projectDir, file, text, { map, ambiguous = {}, keepPrefixes = [], selectorCallees = DEFAULT_SELECTOR_CALLEES, classCallees = DEFAULT_CLASS_CALLEES } = {}) {
  const ts = loadFrom(projectDir, 'typescript');
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  // No parent links: nothing here walks upwards, and setting them costs twice the parse.
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const edits = []; const issues = []; const seen = new Set();
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const issue = (kindName, node, detail) => issues.push({ kind: kindName, file, line: lineOf(node.getStart(sf)), detail });
  const edit = (start, end, repl) => { if (text.slice(start, end) !== repl) edits.push({ start, end, repl }); };
  const keptByPrefix = (t) => keepPrefixes.some((p) => t.startsWith(p));
  const unwrap = (n) => { while (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n)) n = n.expression; return n; };
  const isText = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  // Does the expression always give text that starts (side 'start') or ends ('end') with white space, or no text at
  // all? Then the text written next to it is a whole class name, not a part of one.
  function edgeIsSpace(node, side) {
    const n = unwrap(node);
    const test = side === 'start' ? /^\s/ : /\s$/;
    if (isText(n)) return n.text === '' || test.test(n.text);
    if (ts.isConditionalExpression(n)) return edgeIsSpace(n.whenTrue, side) && edgeIsSpace(n.whenFalse, side);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return edgeIsSpace(n.left, side) && edgeIsSpace(n.right, side);
    if (ts.isTemplateExpression(n)) return test.test(side === 'start' ? n.head.text : n.templateSpans[n.templateSpans.length - 1].literal.text);
    return false;
  }
  // A piece of a class name next to an expression: `slide-` before ${n} starts a name, `__title` after ${block} ends
  // one. It is only safe when no renamed class starts (ends) like that.
  function fragment(frag, node, side) {
    if (!frag || keptByPrefix(frag) || frag.endsWith(':') || frag.startsWith(':')) return;
    for (const k of map.keys()) if (side === 'start' ? k.startsWith(frag) : k.endsWith(frag)) { issue('dynamic-class', node, `"${frag}" next to an expression — add its prefix to keepPrefixes or rewrite the source so the name is written whole`); return; }
  }
  // Class names in a piece of text that has an expression before it (prev) and/or after it (next): the names that
  // touch an expression are left alone and checked, the others are renamed.
  function classPiece(start, raw, prev, next, node) {
    let body = raw; let lead = ''; let trail = '';
    if (prev && !edgeIsSpace(prev, 'end')) { const m = body.match(/^\S+/); if (m) { lead = m[0]; body = body.slice(lead.length); } }
    if (next && !edgeIsSpace(next, 'start')) { const m = body.match(/\S+$/); if (m) { trail = m[0]; body = body.slice(0, body.length - trail.length); } }
    fragment(lead, node, 'end');
    if (lead && !body && next && !edgeIsSpace(next, 'start')) fragment(lead, node, 'start'); // one word between two expressions
    fragment(trail, node, 'start');
    edit(start + lead.length, start + raw.length - trail.length, mapTokens(body, map));
  }

  function classText(rawStart, raw, node) { // tokens of a class list
    edit(rawStart, rawStart + raw.length, mapTokens(raw, map));
  }
  function selectorText(rawStart, raw, node) {
    edit(rawStart, rawStart + raw.length, mapSelector(raw, (n) => (map.has(n) ? map.get(n) : n), { onSkip: (n) => issue('escaped-class', node, `.${n}`) }));
  }
  function htmlAttrs(rawStart, raw) {
    const out = raw.replace(HTML_CLASS_ATTR, (m, a, q, v, b) => a + q + mapTokens(v, map) + b + q);
    edit(rawStart, rawStart + raw.length, out);
  }
  function plainString(rawStart, raw, node) { // a string with no class context: html attribute inside it, or an ambiguous bare word
    if (/\bclass(?:Name)?\s*=/.test(raw)) { htmlAttrs(rawStart, raw); return; }
    const tokens = raw.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length || tokens.length > 8) return;
    const hits = tokens.filter((t) => map.has(t));
    if (!hits.length) return;
    if (hits.length !== tokens.length) { // mixed words and class names: a sentence that happens to contain one
      return;
    }
    let decided = true; const choice = {};
    for (const t of tokens) {
      const c = ambiguous[`${file}:${t}`] ?? ambiguous[t];
      if (c === 'class') choice[t] = true; else if (c === 'keep') choice[t] = false; else { decided = false; }
    }
    if (!decided) { issue('ambiguous-string', node, JSON.stringify(raw)); return; }
    const m2 = new Map(tokens.filter((t) => choice[t]).map((t) => [t, map.get(t)]));
    if (m2.size) edit(rawStart, rawStart + raw.length, mapTokens(raw, m2));
  }
  function calleeInfo(call) {
    const e = call.expression;
    if (ts.isIdentifier(e)) return { name: e.text, owner: '' };
    if (ts.isPropertyAccessExpression(e)) return { name: e.name.text, owner: e.expression.getText(sf) };
    return { name: '', owner: '' };
  }

  function stringLike(node, mode) { // mode: 'class' | 'selector' | 'plain'
    const start = node.getStart(sf) + 1; const raw = text.slice(start, node.getEnd() - 1);
    if (mode === 'class') { classText(start, raw, node); htmlAttrsOnly(raw); } else if (mode === 'selector') selectorText(start, raw, node); else plainString(start, raw, node);
    function htmlAttrsOnly() {}
  }
  function templateExpr(node, mode) {
    const parts = [node.head, ...node.templateSpans.map((s) => s.literal)];
    parts.forEach((p, i) => {
      const s = p.getStart(sf) + 1; const e = p.getEnd() - (p === node.head || ts.isTemplateMiddle(p) ? 2 : 1); const raw = text.slice(s, e);
      if (mode === 'class') {
        classPiece(s, raw, i > 0 ? node.templateSpans[i - 1].expression : null, i < parts.length - 1 ? node.templateSpans[i].expression : null, node);
      } else if (mode === 'plain' && /\bclass(?:Name)?\s*=/.test(raw)) htmlAttrs(s, raw);
    });
  }

  // 'a ' + b + ' c' where class names are expected: every text is a list of names, and a name that touches another
  // operand is a piece of one.
  function concat(node) {
    const operands = [];
    (function flat(n) { const u = unwrap(n); if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) { flat(u.left); flat(u.right); } else operands.push(u); })(node);
    operands.forEach((o, i) => {
      if (!isText(o)) { visit(o, 'class'); return; }
      const start = o.getStart(sf) + 1;
      classPiece(start, text.slice(start, o.getEnd() - 1), operands[i - 1] ?? null, operands[i + 1] ?? null, o);
    });
  }
  // el.className, el.classList and el.classList.value hold class names: what is assigned to them is a class list.
  const isClassTarget = (n) => ts.isPropertyAccessExpression(n) && (n.name.text === 'className' || n.name.text === 'classList' || (n.name.text === 'value' && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'classList'));

  function visit(node, mode, inType) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node) || ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) { return; }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (node.initializer) {
        const m = /^(class|className)$/.test(name) || /class/i.test(name) ? 'class' : mode;
        if (ts.isStringLiteral(node.initializer)) stringLike(node.initializer, m === 'class' ? 'class' : 'plain');
        else visit(node.initializer, m);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const { name, owner } = calleeInfo(node);
      const isClassList = CLASSLIST_METHODS.has(name) && /classList$/.test(owner);
      const setsClass = name === 'setAttribute' && node.arguments.length > 1 && isText(node.arguments[0]) && node.arguments[0].text === 'class';
      node.expression && visit(node.expression, mode);
      node.arguments.forEach((a, idx) => {
        let m = mode;
        if (setsClass) { if (idx === 0) return; m = idx === 1 ? 'class' : mode; }
        else if (isClassList) m = 'class';
        else if (classCallees.includes(name)) m = 'class';
        else if (selectorCallees.includes(name) && idx === 0) m = 'selector';
        visit(a, m);
      });
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // property names that are strings in class context behave as class tokens
      stringLike(node, mode === 'selector' ? 'selector' : mode === 'class' ? 'class' : 'plain'); return;
    }
    if (ts.isTemplateExpression(node)) {
      templateExpr(node, mode === 'selector' ? 'plain' : mode);
      node.templateSpans.forEach((s) => visit(s.expression, mode === 'class' ? mode : 'plain'));
      return;
    }
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) && isClassTarget(unwrap(node.left))) {
      visit(node.left, 'plain');
      if (isText(unwrap(node.right))) stringLike(unwrap(node.right), 'class'); else visit(node.right, 'class');
      return;
    }
    if (mode === 'class' && ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) { concat(node); return; }
    // { className: … } in an object of props
    if (mode !== 'class' && ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'className') { visit(node.initializer, 'class'); return; }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      for (const side of [node.left, node.right]) if (!(ts.isStringLiteral(side) || ts.isNoSubstitutionTemplateLiteral(side))) visit(side, 'plain'); // comparing against "open" is state, not a class
      return;
    }
    if (ts.isConditionalExpression(node)) { visit(node.condition, 'plain'); visit(node.whenTrue, mode); visit(node.whenFalse, mode); return; }
    if (mode === 'class' && ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && map.has(node.name.text)) {
      edit(node.name.getStart(sf), node.name.getEnd(), JSON.stringify(map.get(node.name.text)));
      visit(node.initializer, 'plain'); return;
    }
    if (mode === 'class' && ts.isShorthandPropertyAssignment(node) && map.has(node.name.text)) { issue('shorthand-class-key', node, node.name.text); return; }
    if (mode === 'class' && ts.isPropertyAssignment(node)) { // string keys are class tokens, values are conditions
      if (ts.isStringLiteral(node.name)) stringLike(node.name, 'class');
      visit(node.initializer, 'plain'); return;
    }
    if (mode === 'class' && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) { node.forEachChild((c) => visit(c, 'plain')); return; }
    node.forEachChild((c) => visit(c, mode));
  }
  visit(sf, 'plain');

  // apply non-overlapping edits back to front
  edits.sort((a, b) => b.start - a.start);
  let out = text; let last = Infinity;
  for (const e of edits) { if (e.end > last) continue; out = out.slice(0, e.start) + e.repl + out.slice(e.end); last = e.start; }
  return { text: out, issues, changed: out !== text };
}
