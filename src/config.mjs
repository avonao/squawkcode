import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  srcDirs: [],                 // directories (relative to the project) whose CSS and TS/TSX/JS get rewritten
  extraTextGlobs: [],          // extensions beyond css/ts/tsx/js/jsx/mjs/cjs whose class="…" attributes are rewritten (e.g. ".mdx", ".html")
  textExts: ['.mdx', '.html', '.md'],
  keep: [],                    // class names that must not change (Tailwind utilities, third-party widgets)
  keepPrefixes: [],            // families that must not change (e.g. "stcm-" or "slide-" built with a template string)
  ambiguous: {},               // bare strings that equal a class name: "open": "keep" | "class", or "path/to/file.tsx:open": "keep"
  selectorCallees: ['querySelector', 'querySelectorAll', 'closest', 'matches', '$', '$$'],
  classCallees: ['clsx', 'cn', 'cx', 'classNames', 'classnames', 'twMerge', 'cva'],
  externalCss: 'auto',         // 'auto' = every .css outside srcDirs; classes defined there are kept
  scanOutsideSource: true,     // classes whose name appears as a word in source outside srcDirs are kept
  names: 'min',                // 'min': the shortest names there are, the most written class first (kept the same between
                               // deploys by the map of the last run, see namesFrom); 'hash': prefix + a hash of seed and
                               // class, the same in every build without any map, and larger once compressed
  seed: 'squawkcode',
  prefix: 'h',
  minPrefix: '',               // written before every minimal name (e.g. "_" when the page also loads CSS this project cannot see)
  namesFrom: null,             // with names "min": a map file of an earlier run, relative to the project (default: mapFile, when it exists)
  copyExclude: ['node_modules', '.next', '.git', '.claude', '.open-next', '.wrangler', 'coverage', 'dist'],
  mapFile: 'squawkcode-map.json',
  build: { cmd: 'npm run build', env: {}, parallel: true },   // parallel: build the plain and the renamed copy at the same time
  serve: { cmd: 'npx next start -p {port}', readyPath: '/', portPlain: 4610, portHashed: 4611, env: {}, readyTimeoutSec: 120 },
  compare: {},
};

export function loadConfig(projectDir, explicit) {
  const file = explicit ? path.resolve(explicit) : path.join(path.resolve(projectDir), 'squawkcode.config.json');
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const cfg = { ...DEFAULTS, ...user, build: { ...DEFAULTS.build, ...user.build }, serve: { ...DEFAULTS.serve, ...user.serve } };
  cfg._file = fs.existsSync(file) ? file : null;
  return cfg;
}
