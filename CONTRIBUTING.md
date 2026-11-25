# Contributing to SmokeProof

Thank you for helping improve SmokeProof!

## Development Setup

```bash
npm install
npm run typecheck
npm test
```

## Pull Request Checklist

- Keep changes focused and modular.
- Add or update tests in `test/` for new assertions, chaos probes, or CLI options.
- Ensure `npm run typecheck` and `npm test` pass cleanly before opening a PR.
- Never commit `.smokeproof/` artifacts, `.env` files, or secrets.
