# Security Policy

SquawkCode runs on your own source tree and your own build, and it starts a headless Chrome against sites you point it at. Bugs that make it read or write outside the project, run something it was not asked to run, or report a changed look as unchanged are treated with priority.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (Preview) | yes, security fixes land on the latest Preview version |
| latest minor of the current major | yes (from 1.0) |
| older | no |

## Reporting a vulnerability

Please **do not** open a public issue. Report the vulnerability privately through GitHub's private vulnerability reporting ([report a vulnerability](https://github.com/avonao/squawkcode/security/advisories/new), also the **Report a vulnerability** button on the repository's *Security* tab) with:

- the affected version,
- a description of the issue and its impact,
- steps or a proof of concept to reproduce it.

You will receive an acknowledgement within 72 hours and a status update at least every 7 days. We aim to release a fix within 30 days of confirmation, coordinated with you on disclosure timing. Credit is given in the release notes unless you prefer otherwise.

## Scope notes

- **Hashed class names are not a security feature.** They make the CSS smaller and harder to skim and hide nothing a browser cannot read. Reports that they can be reversed are not vulnerabilities.
- `squawkcode gate` and `squawkcode compare` run the `build.cmd` and `serve.cmd` commands from the configuration file. A configuration file is code: only run one you trust.
- Reports about third-party dependencies should go to the respective project, but tell us too so we can bump versions quickly.
