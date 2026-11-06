# End-to-end suite (Playwright)

```bash
npx playwright@1.65.0 install chromium-headless-shell   # once
npm run e2e
```

The suite builds the web app in production mode and serves it on port 3100. The API is an in-memory stub gateway ([`stub/server.mjs`](stub/server.mjs), port 4010) that follows the services' contracts: paths, bodies, problem documents, and the `Bearer`, `Session ast_…` and `Proctor`/`Interview` token schemes.

| Spec                        | What                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full-flow.spec.ts`         | Invite → magic-link and invitation sign-in → create, publish and link an assessment → the candidate codes in Monaco, loses the network, keeps typing, submits offline, reconnects → the recruiter sees 100% and downloads the PDF |
| `a11y-and-security.spec.ts` | axe-core (WCAG 2.2 AA tags), zero serious or critical violations on 13 pages; Arabic RTL; a strict CSP with a fresh nonce and no unsigned scripts; sign-in redirect; role-based navigation                                        |

The real services are covered by their own acceptance tests. A full-stack run (docker compose: Postgres, Kafka, the judge, Chromium) is not part of this suite.

**Note (macOS, headless):** fake microphone capture never resolves, so the pre-check asks for the camera first and the microphone with a timeout. That is also the right behaviour for candidates with a stuck audio device.
