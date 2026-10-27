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
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const edits = []; const issues = []; const seen = new Set();
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const issue = (kindName, node, detail) => issues.push({ kind: kindName, file, line: lineOf(node.getStart(sf)), detail });
  const edit = (start, end, repl) => { if (text.slice(start, end) !== repl) edits.push({ start, end, repl }); };
  const keptByPrefix = (t) => keepPrefixes.some((p) => t.startsWith(p));

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
        const hasPrev = i > 0, hasNext = i < parts.length - 1;
        let body = raw; let lead = '', trail = '';
        if (hasPrev) { const m = body.match(/^\S+/); if (m) { lead = m[0]; body = body.slice(lead.length); } }
        if (hasNext) { const m = body.match(/\S+$/); if (m) { trail = m[0]; body = body.slice(0, body.length - trail.length); } }
        for (const frag of [lead, trail]) if (frag && !keptByPrefix(frag) && !frag.endsWith(':') && !frag.startsWith(':')) {
          // a half-built class name: it can only stay valid if no class in this family is hashed
          if ([...map.keys()].some((k) => k.startsWith(frag) || k.endsWith(frag))) issue('dynamic-class', node, `"${frag}" next to \${…} — add its prefix to keepPrefixes or rewrite the source`);
        }
        edit(s + lead.length, e - trail.length, mapTokens(body, map));
      } else if (mode === 'plain' && /\bclass(?:Name)?\s*=/.test(raw)) htmlAttrs(s, raw);
    });
  }

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
      node.expression && visit(node.expression, mode);
      node.arguments.forEach((a, idx) => {
        let m = mode;
        if (isClassList) m = 'class';
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
