<p align="center">
  <img src="docs/assets/squawkcode-banner.png" alt="SquawkCode" width="100%">
</p>

<p align="center">
  <strong>Hash the CSS class names of your site in a copy before deploy, and prove with headless Chrome that not one computed style changed.</strong>
</p>

<p align="center">
  <a href="https://github.com/avonao/squawkcode/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/avonao/squawkcode/ci.yml?branch=main&label=ci"></a>
  <img alt="Status: Preview" src="https://img.shields.io/badge/status-preview-f59e0b">
  <img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-0f766e">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0f766e"></a>
  <img alt="Headless Chrome" src="https://img.shields.io/badge/Chrome-headless-4285f4">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%E2%89%A522-339933">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/runtime%20dependencies-0-0f766e">
</p>

SquawkCode is a **proof tool for CSS**. It does two things that belong together: it rewrites the class names of a site to short hashes in a *copy* of the source, and it compares the computed style of every element of two running copies of a site in headless Chrome. The first is the change; the second is the evidence that the change did not alter how the site looks.

It works on a copy and never touches your source tree. It **fails closed**: a string it cannot classify, or a class built at run time, is reported and stops the run instead of being guessed. The comparison is not tied to hashing, so it also checks any other CSS change, such as a move from one stylesheet architecture to another, against a known-good copy of the site.

SquawkCode needs **no infrastructure of its own**. It resolves `postcss` and `typescript` from the project it runs on, starts the build and server commands you configure, and drives a local Chrome over the DevTools protocol.

SquawkCode is a sister product of [Purser CSS](https://github.com/avonao/purser), Avonao's compile-time atomic CSS, and of [Hypdriv](https://github.com/avonao/hypdriv), Avonao's sidecar for performance, security and observability. Purser rewrites how a site is styled; SquawkCode is what proves that a rewrite left the look unchanged.

> **This is not a security feature.** Hashed class names make the CSS smaller and harder to skim. They hide nothing a browser cannot read.

> **Preview.** SquawkCode 0.1.0 is a Preview release. Preview releases are available to build with and evaluate ahead of general availability. Command options, configuration keys and the map format can change between Preview versions, and Preview builds are not covered by a service-level agreement. The [Preview status](#preview-status) section lists what is included, what has been verified and the constraints that apply.

## Contents

- [Highlights](#highlights)
- [Supported sites](#supported-sites)
- [Requirements](#requirements)
- [Install a Preview build](#install-a-preview-build)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [What it will not guess at](#what-it-will-not-guess-at)
- [Command line](#command-line)
- [Configuration](#configuration)
- [Source layout](#source-layout)
- [Works with Purser and Hypdriv](#works-with-purser-and-hypdriv)
- [Preview status](#preview-status)
- [Documentation](#documentation)
- [Develop from source](#develop-from-source)
- [Feedback, security and contributing](#feedback-security-and-contributing)
- [License](#license)

## Highlights

| Area | SquawkCode adds |
| --- | --- |
| **Hashing** | One class map for the whole project · deterministic, collision-checked names (same seed and class give the same hash, so browser caches survive a redeploy) · CSS rewritten with PostCSS, TS, TSX, JS and JSX with the TypeScript AST, `class="…"` in MDX, HTML and Markdown · selectors inside `querySelector`, `closest` and `matches`, and class helpers such as `clsx`, `cn`, `cx` and `cva` understood |
| **Fail closed** | Exit 1 and no guessing on an ambiguous string, a class built with a template string, an escaped class name or a class attribute selector · every issue is resolved in the configuration (`keep`, `keepPrefixes`, `ambiguous`) or in the source |
| **Safe by default** | Classes defined in CSS outside `srcDirs`, or named in source outside it, are kept automatically · Tailwind utilities and third-party widgets are listed in `keep` · the source tree is never touched |
| **Computed-style compare** | Every element and every rendered pseudo-element of two running copies, per page, viewport, html-class state (light, dark, high contrast, …), scripted action (a modal opened) and hover · one hash per element, full values only for the elements that differ · a difference counts only when it persists on a retry |
| **Honest comparison** | Colours written differently count as equal inside a tolerance (`rgb(169, 169, 169)` and `lab(69.2378 0 0)`, ΔE 0.02) · properties one browser does not know are reported and left out · reduced motion, scrolling through lazy content, settling and transitions cancelled so a capture never catches an animation half way |
| **Gate** | `squawkcode gate` builds the plain and the hashed copy, serves both and compares them; exit 0 only when they are identical, and the hashed tree it prints on PASS is the one to deploy |
| **Tooling** | The `squawkcode` CLI (`init`, `transform`, `compare`, `gate`) · zero runtime dependencies · a Chrome that is stopped with the process, even on Ctrl-C |

## Supported sites

SquawkCode does not care what framework made the site; it needs source it can rewrite and a way to start the built site.

| What | How it is handled |
| --- | --- |
| CSS and CSS-in-files | Every `.css` under `srcDirs`, rewritten with PostCSS; CSS outside `srcDirs` is kept |
| TypeScript, TSX, JavaScript, JSX | Rewritten through the TypeScript AST: string classes, `className`, class helpers and selector calls |
| MDX, HTML, Markdown | `class="…"` attributes rewritten (`textExts`) |
| Any build and server | `build.cmd` and `serve.cmd` in the configuration (default `npm run build` and `npx next start -p {port}`) |
| Two running sites | `squawkcode compare` takes any two base URLs, so it also checks changes that are not hashing |

Verified on a Next.js 16 site. Other frameworks need only their build and serve commands in the configuration.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | 22 or later |
| Google Chrome or Chromium | Any recent build; `SQUAWKCODE_CHROME` or `compare.chrome` names the binary (the common macOS and Linux paths are tried) |
| `postcss`, `typescript` | Installed in the **project being processed**: SquawkCode resolves them from there, so it parses with the versions the site builds with |
| A built site | A `build.cmd` and a `serve.cmd` that serves it on a port |
| Package manager | npm, pnpm, yarn or bun |

## Install a Preview build

Preview builds are not published to a package registry. Install from the source repository.

```sh
git clone https://github.com/avonao/squawkcode.git
cd squawkcode
npm install                 # postcss and typescript for the tests only
npm test
node bin/squawkcode.mjs --help
```

SquawkCode has no build step: the source in `src/` is the tool. Run it from a clone, or link it:

```sh
npm link                    # puts `squawkcode` on your PATH
```

## Quickstart

```sh
squawkcode init --project .         # writes a starter squawkcode.config.json
squawkcode transform --project . --out /tmp/hashed    # hashed copy + squawkcode-map.json
squawkcode gate --project .         # transform, build both copies, serve both, compare: exit 0 only if identical
squawkcode compare --config f --a http://localhost:4610 --b http://localhost:4611
```

A configuration, from [`squawkcode.config.example.json`](squawkcode.config.example.json):

```json
{
  "srcDirs": ["components/site"],
  "keep": ["hidden", "container", "sr-only"],
  "keepPrefixes": ["slide-"],
  "ambiguous": { "open": "keep", "components/site/nav.tsx:title": "class" },
  "build": { "cmd": "npm run build" },
  "serve": { "cmd": "npx next start -p {port}", "readyPath": "/", "portPlain": 4610, "portHashed": 4611 },
  "compare": {
    "pages": ["/", "/pricing"],
    "states": { "light": "", "dark": "dark", "hc": "hc" },
    "actions": [{ "name": "menu", "eval": "document.querySelector('[aria-label=Menu]').click()" }]
  }
}
```

Deploy from the hashed tree the gate prints on PASS.

### Compare two copies of a site

`compare` does not need hashing. Serve a known-good copy of the site on one port and the changed copy on another, and it reports every element whose computed style differs, with the property and both values:

```sh
squawkcode compare --config squawkcode.config.json --a http://localhost:4401 --b http://localhost:4400
```

It loads the two copies side by side, in two headless Chrome instances with separate profiles, at the same time. A structure difference (`N elements vs M`) is content, not CSS: find the first differing element before reading styles.

## How it works

`gate` runs the same ordered stages on every project:

`copy → map → rewrite → build plain → build hashed → serve both → compare`

1. **Copy.** The project is copied (`copyExclude` leaves out `node_modules`, `.next`, `.git`, build output and similar), and `node_modules` is cloned into each copy.
2. **Map.** One class map is built from every class defined under `srcDirs`. Classes defined in CSS outside `srcDirs`, or named in source outside it, are kept automatically; `keep` and `keepPrefixes` add the rest.
3. **Rewrite.** CSS is rewritten with PostCSS and TS, TSX, JS and JSX with the TypeScript AST; `class="…"` in the other text types. Anything it cannot rewrite with certainty is an issue.
4. **Fail closed.** With any issue the run exits 1 and prints each one with its file and line.
5. **Build and serve.** The plain and the hashed copy are built with `build.cmd` and served on `portPlain` and `portHashed`.
6. **Compare.** Both are captured in headless Chrome and diffed. Only differences that persist on a retry count.

The map is written next to the hashed copy as `squawkcode-map.json` (`seed`, `map`, `kept`).

### What a capture covers

Every page in `compare.pages`, at each viewport (default `desktop` 1440×900 and `mobile` 390×844), in each html-class state (`light`, `dark`, or your own, such as `hc`), after each scripted action (`compare.actions`), and with the pointer over up to `hover.max` links, buttons and fields per page and their descendants. Whole-page captures send one hash per element and per pseudo-element and only read the full values of the ones whose hashes differ.

## What it will not guess at

| Issue | What it means | Resolve with |
| --- | --- | --- |
| `ambiguous-string` | A string that equals a class name but is not clearly a class | `ambiguous`: `"name": "keep"` or `"class"`, or `"file:name": …`; or rewrite the source |
| `dynamic-class` | A class assembled with a template string | `keepPrefixes`, or rewrite the source |
| `escaped-class` | A class name with escapes in CSS (it cannot be rewritten safely) | Rename the class in the source, or keep it |
| `class-attribute-selector` | A CSS selector that reads class text, such as `[class*="slide-"]`; it stops the run only when classes are being hashed | Rewrite the selector, or keep the classes it reads with `keep` or `keepPrefixes` |

Classes assembled at run time, set by third-party code, or referenced by external tools must be listed in `keep` or `keepPrefixes`. The compare gate covers only the pages, states and actions you configure.

## Command line

Every command takes `--project <dir>` (default the current directory) and `--config <file>` (default `squawkcode.config.json` in the project).

| Command | Purpose |
| --- | --- |
| `squawkcode init` | Write a starter `squawkcode.config.json` |
| `squawkcode transform` | Copy the project, hash class names in the copy and write `<out>/squawkcode-map.json`; `--out <dir>`; exit 1 on anything it cannot rewrite with certainty (`--allow-issues` writes the copy anyway) |
| `squawkcode compare` | Headless-Chrome computed-style diff of two running copies: `--a <baseUrl> --b <baseUrl>`, `--out <file>` for the JSON report |
| `squawkcode gate` | Transform, build both copies, serve both and compare; exit 0 only when identical; the hashed tree is left for deploy |

The earlier name of this tool, `classhash`, still runs the same command.

## Configuration

Keys of `squawkcode.config.json` (defaults in [`src/config.mjs`](src/config.mjs)):

| Key | Default | Purpose |
| --- | --- | --- |
| `srcDirs` | `[]` (required) | Directories, relative to the project, whose CSS and TS/TSX/JS get rewritten |
| `textExts` | `.mdx`, `.html`, `.md` | Extensions whose `class="…"` attributes are rewritten |
| `keep` | `[]` | Class names that must not change (Tailwind utilities, third-party widgets) |
| `keepPrefixes` | `[]` | Families that must not change (built with a template string) |
| `ambiguous` | `{}` | Bare strings that equal a class name: `"open": "keep"` or `"class"`, or `"path/file.tsx:open": …` |
| `selectorCallees` | `querySelector`, `querySelectorAll`, `closest`, `matches`, `$`, `$$` | Calls whose string argument is a selector |
| `classCallees` | `clsx`, `cn`, `cx`, `classNames`, `classnames`, `twMerge`, `cva` | Calls whose string arguments are class names |
| `externalCss` | `auto` | Every `.css` outside `srcDirs`; the classes defined there are kept |
| `scanOutsideSource` | `true` | Keep classes whose name appears as a word in source outside `srcDirs` |
| `seed`, `prefix` | `squawkcode`, `h` | Hash seed and name prefix (same seed and class give the same name) |
| `copyExclude` | `node_modules`, `.next`, `.git`, `.claude`, `.open-next`, `.wrangler`, `coverage`, `dist` | Left out of the copy |
| `mapFile` | `squawkcode-map.json` | Name of the written map |
| `build` | `{ cmd: "npm run build", env: {} }` | How to build a copy |
| `serve` | `{ cmd: "npx next start -p {port}", readyPath: "/", portPlain: 4610, portHashed: 4611, readyTimeoutSec: 120 }` | How to serve a copy; `{port}` is replaced |
| `compare` | `{}` | The comparison, below |

### The `compare` block

| Key | Default | Purpose |
| --- | --- | --- |
| `pages` | `["/"]` | Paths to capture |
| `viewports` | `desktop [1440, 900, false]`, `mobile [390, 844, true]` | Name → `[width, height, mobile]` |
| `states` | `light ""`, `dark "dark"` | html classes added for a capture |
| `actions` | `[]` | `{ name, eval }`: run in the page, then capture the whole document |
| `hover` | `{ max: 30, perElement: 40, viewports: null, selector: null }` | Hover up to `max` elements per page and compare them and their descendants; `viewports` names where to hover (`null` = every viewport except `mobile`); `selector` picks the elements (`null` = links, buttons and fields) |
| `colourTolerance` | `0.02` | ΔE (CIE76, lab) under which two colours count as equal |
| `ignoreProps` | `^--`, `^-webkit-text-fill`, `perspective-origin`, `transform-origin` | Regular expressions on property names to leave out |
| `scrollThrough`, `reducedMotion` | `true`, `true` | Scroll the page to wake lazy content; emulate reduced motion |
| `settleMs` | `2500` | Wait after load |
| `readyWhen` | `null` | An expression that must be true before a capture (for example an iframe's ready class), for at most `readyTimeoutMs` (20000) |
| `beforeCapture` | `null` | An expression evaluated before every capture, to pin what changes on a timer (a carousel) |
| `retries` | `1` | Pages with differences are captured again and only persistent ones count |
| `maxReport` | `15` | Differences printed per entry |
| `chrome` | `null` | Path to Chrome |

## Source layout

| Module | Purpose |
| --- | --- |
| [`bin/squawkcode.mjs`](bin/squawkcode.mjs) | The command line |
| [`src/transform.mjs`](src/transform.mjs) | Copy, class map, rewrite, issue report |
| [`src/css.mjs`](src/css.mjs), [`src/selector.mjs`](src/selector.mjs) | CSS and selector rewriting (PostCSS) |
| [`src/source.mjs`](src/source.mjs) | TS, TSX, JS and JSX rewriting (TypeScript AST) |
| [`src/names.mjs`](src/names.mjs) | Deterministic, collision-checked hashed names |
| [`src/compare.mjs`](src/compare.mjs) | The computed-style capture and diff |
| [`src/colour.mjs`](src/colour.mjs) | Colour equality inside a ΔE tolerance |
| [`src/gate.mjs`](src/gate.mjs) | Copy, build, serve and compare |
| [`src/cdp.mjs`](src/cdp.mjs) | Chrome over the DevTools protocol |
| [`src/config.mjs`](src/config.mjs), [`src/modules.mjs`](src/modules.mjs), [`src/walk.mjs`](src/walk.mjs) | Configuration, loading `postcss` and `typescript` from the project, file walking |

## Works with Purser and Hypdriv

- **[Purser CSS](https://github.com/avonao/purser)** moves a site's styles into one deterministic atomic stylesheet in which no declaration can be overridden. Moving an existing site onto Purser one component at a time is exactly the kind of change `squawkcode compare` proves: serve the site before the move on one port and after it on another, and every element's computed style, in every state and viewport, is compared.
- **[Hypdriv](https://github.com/avonao/hypdriv)** audits a running deployment (headers, CSP, cache, HTTPS, zero CSS overrides). SquawkCode answers a different question, whether a change altered the look, and runs before deploy.

## Preview status

| | Status |
| --- | --- |
| Release | 0.1.0 Preview |
| Implemented | Everything in this README |
| Tests | 12 tests in 2 files on Node 22 and 24 (rewriting, selectors and colour equality; the Chrome comparison is exercised on real sites, not in the unit tests) |
| In use | Comparing Avonao's own site against its previous version while moving it onto Purser CSS |
| API stability | Not yet guaranteed. 1.0 will commit to the configuration schema and the map format under semver |
| Distribution | Source |

### Constraints in this Preview

- **Registry.** Distributed as source; an npm release follows the Preview.
- **Not a security feature.** Hashing hides nothing a browser cannot read.
- **Run-time classes.** Classes assembled at run time, set by third-party code or referenced by external tools must be listed in `keep` or `keepPrefixes`.
- **Coverage is yours to configure.** The compare covers only the pages, states and actions you list.
- **Different browsers.** The two sides run in the same Chrome. Properties the two captures do not both list are reported and left out.
- **Chrome only.** The comparison uses headless Chrome; other engines are not compared.
- **Sites that change on a timer** (a carousel, a clock) need `beforeCapture` or `readyWhen` to hold them still.

## Documentation

- **Concepts:** [How it works](#how-it-works) · [What it will not guess at](#what-it-will-not-guess-at) · [Changelog](CHANGELOG.md)
- **Reference:** [Command line](#command-line) · [Configuration](#configuration) · [`squawkcode.config.example.json`](squawkcode.config.example.json)
- **Sister products:** [Purser CSS](https://github.com/avonao/purser) · [Hypdriv](https://github.com/avonao/hypdriv)

## Develop from source

```sh
npm install                 # postcss and typescript, for the tests
npm test                    # node --test
```

Continuous integration runs the suite on Node 22 and 24. The ground rules (fail closed, keep the comparison honest, never touch the source tree) are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Feedback, security and contributing

- **Bugs and feature requests:** open an issue with the templates in this repository. Include your configuration and the smallest page that shows the problem.
- **Security:** report vulnerabilities privately through GitHub's *Report a vulnerability* on the Security tab. See [`SECURITY.md`](SECURITY.md).
- **Contributing:** see [`CONTRIBUTING.md`](CONTRIBUTING.md). A change to the comparison needs a test and a reason: it must never hide a difference to get a green run.
- **Conduct:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 Avonao, Inc. and SquawkCode contributors.
