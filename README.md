# MedData

Patient-owned medical records for Moldova. Patients photograph prescriptions, discharge notes and lab results (or have lab
results imported from email); MedData keeps the originals, reads them with Claude, lets the patient check the reading,
and files everything by investigation date with one PDF per date. Doctors sign in with MPass, get verified as practising
doctors, and can see a patient's records only after the patient approves with a PIN.

## What's in here

| | |
|---|---|
| `apps/api` | Fastify + PostgreSQL API (TypeScript) |
| `apps/web` | React web app: patient, doctor and admin screens |
| `docs/architecture.md` | How the pieces fit, security model, and what's still open |

## Run it locally

```bash
docker compose up -d db          # or any Postgres 16 with databases meddata and meddata_test
npm install
EXTRACTOR=demo npm run dev:api   # API on :4000, migrates on start. Drop EXTRACTOR=demo and set ANTHROPIC_API_KEY to read real documents
npm run dev:web                  # web app on http://localhost:5173
```

- **Patient sign-in:** enter an email or phone; with the console transports the 6-digit code is printed in the API log.
- **Doctor sign-in:** "Sign in with MPass" opens a local MPass stand-in (`MPASS_MODE=mock`). Enter any 13-digit IDNP.
- **Admin:** `npm -w apps/api run create-admin -- you@example.com`, then sign in with that email to review doctor licences.
- **Medicines register:** `npm -w apps/api run import:medicines -- nomenclator.csv` loads the AMDM export used to check medicine names.
- **Lab email import:** run `npm -w apps/api run mail:poll` as a worker; patients connect their mailbox in Settings.

## Tests

```bash
npm test          # API tests against TEST_DATABASE_URL (default postgres://meddata:meddata@localhost:5432/meddata_test)
npm run typecheck
```

## Put it online (Render)

The repo carries a `Dockerfile` and a `render.yaml`, so Render can run the whole app (API + web + Postgres) from one button:

1. Sign up at https://render.com with the GitHub account that owns this repository.
2. Open https://render.com/deploy?repo=https://github.com/7900013-dotcom/meddata and paste your `ANTHROPIC_API_KEY`. Every other secret is generated.
3. When the first deploy finishes, open the service URL (something like `https://meddata.onrender.com`).

Notes for a hosted pilot:
- Files are stored encrypted inside Postgres (`STORAGE_BACKEND=db`), so the free plan, which has no persistent disk, works.
- Doctor sign-in uses the stand-in MPass page, protected by `MPASS_MOCK_ACCESS_CODE` (visible in the Render dashboard under Environment). Give that code only to doctors you invite.
- Sign-in codes are printed to the service logs until `EMAIL_TRANSPORT=smtp` / `SMS_TRANSPORT=http` are configured; for a pilot, read them under Logs in the Render dashboard.
- Render's free database is deleted after 30 days unless upgraded, and the free web service sleeps when idle (the first request after a pause takes about a minute).

## Browser-only demo

`npm run build:demo -w apps/web` builds a self-contained version of the web app (`apps/web/dist-demo`) in which an in-browser stand-in for the API (`apps/web/src/demo/`) serves sample data from localStorage. It is for showing the product without a server; readings are samples, not real extractions. The hosted app never includes this code.
