# Benchmarks

Three questions, answered on one generated site: what renaming class names saves, how long the proof takes, and what the proof finds that a screenshot comparison does not. Everything here can be run again with [`benchmarks/run.mjs`](../benchmarks/run.mjs); this page is written from its result file by `benchmarks/report.mjs`.

The site is 120 components with BEM class names (`card`, `card__title`, `card--featured`), 4 pages of 40 components each, one stylesheet with hover, focus, dark-theme, breakpoint and print rules, and a script that opens a dialog: 854 classes in all. It is static, so what is measured is SquawkCode and Chrome and not a framework's build. Measured on 2026-11-25 with Node v22.23.4 on 2 cores (Intel(R) Xeon(R) Processor, linux x64).

## What renaming saves

Sizes in kB (1,000 bytes); every file is compressed on its own, the way a server sends it (Brotli at quality 11, gzip at level 9).

| | Stylesheet | Markup | Script | **Total, Brotli** | Total, gzip | Total, as written | Transform |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| As written | 6.65 | 5.66 | 0.21 | **12.5** | 16.8 | 173.9 |  |
| Hashed names (6 characters a name) | 7.64 | 7.61 | 0.23 | **15.5** (+23.5%) | 20.0 (+19.3%) | 153.3 (-11.9%) | 31 ms |
| Minimal names (1.94 characters a name) | 5.58 | 5.38 | 0.20 | **11.2** (-10.9%) | 15.2 (-9.3%) | 141.1 (-18.8%) | 28 ms |

- **Minimal names** make the site 10.9% smaller compressed (18.8% as written). The class that is written most often gets a one-letter name.
- **Hashed names** make it 11.9% smaller as written and 23.5% larger compressed. A readable name such as `card__title` shares most of its letters with `card` and `card__body`, which is exactly what a compressor removes; a hash shares nothing with anything. Hashed names are for when a name must be the same in every build without a map being kept, not for size.
- Between the two, minimal names are 27.9% smaller compressed.

How much a real site gains depends on how much of it is class names: markup that repeats long BEM names gains most, a page of prose gains little.

## How long the proof takes

The plain site against the renamed one: 8 page views (4 pages at two viewports), each in the light and the dark state, with the hover pass over up to 30 links and buttons a page.

| | Time |
| --- | ---: |
| SquawkCode 0.1.0, as released: a fixed wait after every navigation, a page load for every pass, one page at a time | 73.1 s |
| The same captures now, one page at a time | 15.4 s |
| The defaults: the keyboard-focus pass added, 2 pages at a time (one per processor, at most four) | 9.8 s |

The same captures take 4.7 times less time than in 0.1.0, which was run for this table on the same site (with the plain site on both sides: it cannot be told how a copy is renamed). Four things make the difference:

- **The page is waited for, not the clock.** A page counts as settled when it has loaded, its fonts are ready and neither the network nor the document has changed for half a second.
- **One page load serves the states, the hover pass and the focus pass**, as long as the page's document has not changed by itself since it settled. A page that a pass did change is loaded again for the next one.
- **A hash per element crosses the wire**, not its `getComputedStyle` values; the values are read for the elements whose hashes differ.
- **The second look is aimed.** A page that differs is captured again after a fixed wait, and only a difference that is still there is reported; that second look takes the captures that differed and nothing else.

## What the proof finds

20 copies of the site, each with one rule of the stylesheet changed, compared with the unchanged site in two ways:

- **Computed styles:** `squawkcode compare` with the light and dark states, a dark system setting and print as media states, one scripted action (the dialog opened), the hover pass and the keyboard-focus pass.
- **Screenshots:** a full-page screenshot of every page at both viewports, as loaded, compared pixel by pixel with pixelmatch at threshold 0.2 (what Playwright's `toHaveScreenshot` uses). This is what a visual regression suite does when it is set up in an afternoon; a suite can be taught more states, one screenshot each.

| Changed | Where it shows | Computed styles | Screenshots |
| --- | --- | :---: | :---: |
| a card's padding, 1px more | at rest | found | found |
| the current link's weight | at rest | found | found |
| an arrow glyph in a button | at rest | found | found |
| one column gap, 2px more | at rest | found | found |
| the mobile navigation wraps no more | at rest (mobile) | found | missed |
| text colour, one step of 255 | at rest, below what an eye sees | found | missed |
| line height 1.5 to 1.51 | at rest, below a pixel per line | found | found |
| a link's hover background | hover | found | missed |
| a card's hover border | hover | found | missed |
| a button's hover background | hover | found | missed |
| a link's focus ring | keyboard focus | found | missed |
| a button's focus ring offset | keyboard focus | found | missed |
| the dark theme's background | dark theme (a class) | found | missed |
| a featured card in the dark theme | dark theme (a class) | found | missed |
| a rule for a dark system setting | prefers-color-scheme: dark | found | missed |
| the navigation shows in print | print | found | missed |
| the open dialog's padding | after a click | found | missed |
| the open dialog's backdrop | after a click | found | missed |
| a button's cursor | nothing is painted | found | missed |
| a transition's duration | nothing is painted | found | missed |
| **20 changes** | | **20 found** | **5 found** |

A screenshot shows the page in one state; most of a stylesheet is about the others. What the screenshots miss here is everything that needs a pointer, a keyboard, a theme, a media query or a click, everything that is not painted, and everything below the threshold that keeps a screenshot comparison from failing on noise. The computed-style comparison has no threshold to tune, because it does not look at pixels: it reads what the browser computed for every element, and two sites either agree or they do not.

It also cannot tell you that a difference matters. A text colour one step of 255 away is reported like any other change; whether to accept it is a decision, and `colourTolerance` is where the line is drawn for colours that are written differently and mean the same.

## What to keep in mind

- The site is generated, by the authors of the tool. It is built to have the kinds of rules a real stylesheet has, not to favour a result; the generator is [`benchmarks/site.mjs`](../benchmarks/site.mjs), and a change to it is a pull request away.
- The comparison covers the pages, states and actions it is configured with. A rule for a state nobody listed is not seen by either method.
- No other renaming tool is measured here. Their output size depends on the names they give (the table above covers both kinds); what differs is what they do with a string they cannot classify, and that is not a number.
