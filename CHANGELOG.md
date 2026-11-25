# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

- **Minimal names** (`names: "min"`, now the default): the shortest class names there are, the most written class first (`a`, `b`, …). On the benchmark site they make the compressed site smaller, where hashed names make it larger. `squawkcode transform --save-map` and `squawkcode gate --save-map` write the class map into the project; the next run reads it (`namesFrom`), so a class keeps its name between deploys. `minPrefix` puts a prefix before every name. A new name is never one that stays in use: a kept class, a class another stylesheet defines, a class of a kept family.
- **Media states.** A state in `compare.states` can be an object, `{ class, media, type }`: media features to emulate (`{ "prefers-color-scheme": "dark" }`, `forced-colors`, `prefers-contrast`) and a media type (`"print"`), so rules inside media queries are compared too.
- **A keyboard-focus pass** (`compare.focus`, on by default): Tab is pressed up to `focus.max` times and the focused element, what contains it and what it contains are compared, so a changed focus ring is found.
- Hover and focus captures include the element's ancestors (`.card:hover`, `:focus-within`).
- Elements inside open shadow roots are compared.
- `squawkcode explain <name>`: what a renamed class was called, or what a class is renamed to.
- `compare.concurrency` and `--concurrency`: several pages are compared at once, each with its own pair of browsers (default: one per processor, at most 4).
- **The renamed side is told its names.** The html classes of a state (`dark`), a hover selector and the scripts of actions, `readyWhen` and `beforeCapture` are written for the site as it was; the gate rewrites them for the renamed copy with the class map (`renamer`), and `squawkcode compare --map <file>` does the same for two copies that are already running. A script that builds a class name from pieces stops the run instead of being guessed at.
- **More places where a string is a class list:** what is assigned to `el.className`, `el.classList` or `el.classList.value`, the value of `setAttribute('class', …)`, and a `className` property of an object.
- **Concatenations are read like template strings.** In `'card' + (wide ? ' card--wide' : '')` both names are whole and are renamed; in `'slide-' + n` the text is a piece of a name and is reported (`dynamic-class`). A template string whose expression always starts with a space or is empty no longer reports the name before it.
- `--no-sandbox` for Chrome when it runs as root or in CI (`SQUAWKCODE_NO_SANDBOX=1` asks for it elsewhere): Chrome's sandbox needs user namespaces that containers often lack.
- `benchmarks/`: what renaming saves, how long the comparison takes and what it finds that a screenshot comparison does not, on a generated site. [Results](docs/benchmarks.md).

### Changed

- **`names` defaults to `"min"`.** Set `"names": "hash"` to keep the names of 0.1 (`h` + a hash of seed and class: the same in every build without a map, and larger once compressed).
- **A capture waits for the page, not for the clock** (`settleMs: "auto"`): it is taken when the page has loaded, its fonts are ready and neither the network nor the document has changed for `quietMs` (500), at most `settleMaxMs` (5000). A page that differs is captured again after a fixed wait (`carefulSettleMs`, 2500) and only a difference that is still there counts. A number in `settleMs` is the fixed wait of 0.1.
- **One page load serves the states, the hover pass and the focus pass**, as long as the page's document has not changed by itself since it settled; 0.1 loaded the page for each. Every action still gets a page of its own.
- **Hover and focus captures send hashes**, like whole-page captures; values are read for the elements whose hashes differ.
- **The second look is aimed:** a page that differs is captured again after the fixed wait, but only the captures that differed.
- Transitions are ended before every capture (after a state, the pointer, the keyboard focus and an action), so no value is read half way.
- Focus captures are numbered by the elements that took the focus, not by key presses: a Tab that lands on no element (Chrome's first Tab after a scroll) is not the end of the pass.
- What scrolling through the page brings in (lazy images, content that appears in view) is waited for like the rest of the page.
- The gate builds the plain and the renamed copy at the same time (`build.parallel: false` builds one after the other).
- `postcss` and `typescript` are dependencies. The project's copies are still used first; SquawkCode's own are used for a project that has none, or whose TypeScript has no parser API (TypeScript 7).
- Each stylesheet is parsed once, source files are parsed without parent links, and a source file that names no renamed class is not parsed at all.
- Chrome is driven over a pipe, not over a port: nothing listens anywhere, and any number of browsers can start at once.
- What the comparison tells the page (class lists, selectors, property names) is passed to page functions as arguments, never pasted into code.

## [0.1.0] - Unreleased

### Added

- `squawkcode transform`: copy a project, build one class map and rewrite CSS (PostCSS) and TS/TSX (TypeScript AST) in the copy; exits 1, with no guessing, on anything it cannot rewrite with certainty.
- `squawkcode compare`: headless-Chrome computed-style diff of two running copies of a site, per page, viewport, html-class state, scripted action and hover; one hash per element and full values only for differing elements; colour tolerance in lab ΔE; pseudo-elements; `hover.selector`; differences count only when they persist on a retry.
- `squawkcode gate`: transform, build both copies, serve both and compare; exit 0 only when identical.
- `squawkcode init`: a starter `squawkcode.config.json`.
