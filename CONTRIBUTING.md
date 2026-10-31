# Contributing to SquawkCode

Thanks for helping. SquawkCode exists to prove that a change did not change how a site looks, so every change is judged first by whether that proof still holds.

## Setup

SquawkCode has no runtime dependencies and no build step. At run time `postcss` and `typescript` are resolved from the project it runs on; the tests use the development copies. Google Chrome is needed for `compare` and `gate` (`SQUAWKCODE_CHROME` names the binary):

```sh
npm install        # postcss and typescript, which the tests resolve from this repository
npm test           # node --test
```

## Ground rules

- **Fail closed.** A string it cannot classify, a class built at run time or a rewrite it cannot prove is reported and exits 1. A change must never turn one of those into a guess.
- **Keep the comparison honest.** `compare` must not hide a difference to get a green run: a new ignored property, tolerance or retry needs a test and a reason in the pull request.
- **Never touch the source tree.** `transform` and `gate` work on a copy.
- **Style.** Plain ESM JavaScript, small focused modules, and error messages that tell the author what to write in the configuration instead.

## Pull requests

Describe the behaviour change, link an issue if there is one, and fill in the checklist in the PR template. Keep each PR to one concern.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
