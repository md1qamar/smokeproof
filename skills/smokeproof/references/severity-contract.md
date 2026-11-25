# SmokeProof Machine-Readable Contract & Severity Rubric

## Score Formula

Each audit starts at `100` points and deducts per unique `(rule, route)` group (capped at 2x weight per rule/route so repeated identical warnings do not distort the score):

| Severity | Weight | Default Gate (`--fail-on high`) | Typical Meaning |
| --- | --- | --- | --- |
| `critical` | -25 | Blocks ship (`passed: false`) | Blank screen, uncaught exception, HTTP 5xx, leaked private API/DB key |
| `high` | -12 | Blocks ship (`passed: false`) | Console error, hydration mismatch, broken image, mobile overflow, HTTP 4xx API, error-on-click, missing viewport meta, `[object Object]`/`NaN` UI leak |
| `medium` | -5 | Advisory (unless `--fail-on medium`) | Desktop overflow, overlapping controls, dead button, missing `<title>`, unlabeled button/input, Lorem ipsum placeholder |
| `low` | -2 | Advisory | Small mobile tap target, missing `<html lang>`, missing `<h1>`, missing `alt`, slow request (`>3.5s`), hardcoded localhost |

## Rule IDs Reference

- `runtime/uncaught-exception`
- `runtime/console-error`
- `runtime/hydration-warning`
- `runtime/navigation-failed`
- `runtime/hardcoded-localhost`
- `network/route-http-5xx` / `network/route-http-4xx`
- `network/http-5xx` / `network/http-4xx` / `network/request-failed` / `network/slow-response`
- `layout/blank-screen`
- `layout/horizontal-overflow`
- `layout/overlapping-controls`
- `layout/small-tap-target`
- `asset/broken-image`
- `interaction/error-on-click`
- `interaction/dead-control`
- `security/exposed-*` / `security/source-*` / `security/committed-env-file` / `security/unsafe-inner-html`
- `meta/missing-title` / `meta/missing-viewport`
- `a11y/missing-lang` / `a11y/missing-h1` / `a11y/unlabeled-control` / `a11y/unlabeled-input` / `a11y/image-missing-alt`
- `content/object-object-leak` / `content/nan-or-undefined-leak` / `content/placeholder-lorem-ipsum`
