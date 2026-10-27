# classhash

Hash CSS class names in a **copy** of a site's source right before deploy; develop with the readable names.
Then prove with headless Chrome that the hashed copy renders identically.

**This is not a security feature.** Hashed class names make the CSS smaller and harder to skim. They hide nothing a browser can't read.

## How it works
1. Copies the project (never touches your tree), builds one class map, rewrites CSS (postcss) and TS/TSX (TypeScript AST).
2. **Fails closed.** Exit 1 and no guessing on: a string that equals a class name but is not clearly a class (`ambiguous-string`), a class built with a template string (`dynamic-class`), etc.
   Resolve each with config: `keep`, `keepPrefixes`, or `ambiguous` (`"name": "keep"|"class"`, or `"file:name": …`), or rewrite the source.
3. Classes also defined in CSS outside `srcDirs`, or named in source outside it, are kept automatically.
4. `gate` builds the plain and hashed copies, serves both, and diffs the computed style of every element, per page, viewport, html-class state (light/dark/…), scripted action (modal open) and hover. Only differences that persist on a retry count.

Needs Node 22+ and Chrome (`CLASSHASH_CHROME` to override). `postcss` and `typescript` are resolved from the **target project's** node_modules.

## Use
```
classhash init --project .                       # starter classhash.config.json
classhash transform --project . --out /tmp/h     # hashed copy + classhash-map.json
classhash gate --project .                       # transform + build both + compare; exit 0 only if identical
classhash compare --config f --a http://localhost:4610 --b http://localhost:4611
```
See `classhash.config.example.json`. Deploy from the hashed tree the gate prints on PASS.

## Limits
Classes assembled at runtime, set by third-party code, or referenced by external tools must be listed in `keep`/`keepPrefixes`. The compare gate covers only the pages, states and actions you configure.
