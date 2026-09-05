# Contributing

Thank you for your interest in Penpal.

## Before you start

1. Fork the repository and create a focused feature branch.
2. Never commit workspaces, API keys, real writing, `settings/`, temporary scans, or private provider documents.
3. Install Node.js 20 or newer and run `npm install`.

## Before opening a pull request

Run at least:

```bash
npm run typecheck
npm run build
git diff --check
```

If you change summary, retrieval, file conversion, or API compatibility code, describe the models, file types, and failure cases you tested.

## Pull request guidance

- Keep one pull request focused on one topic.
- Describe the problem, implementation, compatibility impact, and verification result.
- Include a screenshot or recording for UI changes.
- Explain migration and rollback behavior for data-format changes.
- Do not paste API keys, authorization headers, user files, or private logs into public issues or pull requests.
