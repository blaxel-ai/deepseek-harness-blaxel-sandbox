# Invoice Desk

A dependency-free billing application used for the DeepSeek Harness cloud handoff walkthrough. It includes CSV export and ten tests.

```bash
npm test
npm start
```

Open http://localhost:3000. The Export CSV control downloads the current invoices with amounts and currency codes. Set `PORT` to use a different port.

For a small handoff workspace, copy this directory outside the plugin repository, run `git init`, and open it in DSH Web through `dsh-blaxel`. Move the session to Blaxel, ask it to make and test a change, review the return patch, and rerun `npm test` locally. Do not copy model credentials into the project; configure the selected model in DSH.
