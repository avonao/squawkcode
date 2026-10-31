# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- `squawkcode transform`: copy a project, build one class map and rewrite CSS (PostCSS) and TS/TSX (TypeScript AST) in the copy; exits 1, with no guessing, on anything it cannot rewrite with certainty.
- `squawkcode compare`: headless-Chrome computed-style diff of two running copies of a site, per page, viewport, html-class state, scripted action and hover; one hash per element and full values only for differing elements; colour tolerance in lab ΔE; pseudo-elements; `hover.selector`; differences count only when they persist on a retry.
- `squawkcode gate`: transform, build both copies, serve both and compare; exit 0 only when identical.
- `squawkcode init`: a starter `squawkcode.config.json`.
