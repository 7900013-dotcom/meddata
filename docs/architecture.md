# MedData architecture (v0.1)

## Two kinds of user

**Patients** sign in with a one-time code sent by email or SMS. No passwords. On first sign-in the account is created.
Patients set a 6-digit **approval PIN**, used only to approve doctor access.

**Doctors** sign in only with **MPass** (SAML 2.0, Moldova's e-government identity service), which gives a verified IDNP and legal
name. A new doctor account starts as `unverified` and cannot see any patient. The doctor submits licence number, specialty,
institution and a photo/PDF of the licence; an **admin reviews it manually** against the official register and certifies or rejects
it. Only `certified` doctors can request access, and every read re-checks certification. Suspending a doctor revokes all
their grants at once.

*Why manual review:* there is no public API for Moldova's register of medical staff that we could find. `doctor_profiles.verification_method`
already distinguishes `manual` from `registry` so an automated check (e.g. via CNAM or the Ministry of Health) can be added later.

## Documents

1. **Upload** (web, multiple files). Photos are resized to 2000 px JPEG in the browser; HEIC is refused with instructions.
   The server checks file signatures, not names. The original is stored **byte-for-byte** with envelope encryption
   (a random AES-256-GCM key per file, wrapped by `STORAGE_MASTER_KEY`). Duplicate files (same SHA-256) are not stored twice.
2. **Reading.** Claude (`claude-opus-5-5`, effort high, server-side refusal fallback) reads the image or PDF and returns structured
   JSON: type, investigation date, institution, doctor, medicines, lab values with units and ranges, a full transcription, and
   which fields are uncertain (`[?]`). Password-protected PDFs are detected and reported to the patient.
3. **Medicines register check.** Each medicine name is matched against Moldova's AMDM nomenclator (loaded from CSV, trigram
   search). Names that don't match are flagged with suggestions and are never auto-corrected.
4. **Mandatory review.** Nothing becomes a record until the patient confirms the reading side by side with the original. Saving with
   unverified medicine names requires an explicit acknowledgement.
5. **Records and PDFs.** Confirmed records are grouped by investigation date. `GET /api/records/dates/:date/pdf` builds one PDF per
   date: the readable transcription of every record that day (Unicode font, so Romanian and Russian render), followed by the original
   pages. Lab values feed the Trends view.

## Lab results by email (Synevo)

Patients connect a mailbox over IMAP with an app password (encrypted at rest). A worker (`npm run mail:poll`) searches only for
messages from known lab senders (`synevo.md` by default, extendable per patient), stores PDF/image attachments as originals with
`source = email`, and reads them. They land in "To review" like uploads.

Open questions that need a real Synevo email:
- the exact sender address(es);
- whether results arrive as attachments, password-protected PDFs (the password is often the patient's IDNP or a code), or only as a link
  to the Synevo portal. Links are detected (`note: no_attachments`) but not followed yet.

Gmail and Outlook may require OAuth instead of app passwords for some accounts; a forwarding address per patient is an alternative.

## Doctor access

Works like confirming a card payment in a banking app:
1. The patient shows a **QR code** (or an 8-character code) valid for 15 minutes and usable once.
2. A certified doctor scans it and requests access with a **scope** (all, labs, prescriptions) and **duration** (2 h to 30 days).
3. The patient is notified by SMS/email and approves in the app with the **PIN**. 5 wrong PINs lock approvals for 15 minutes.
   Unanswered requests expire after 30 minutes.
4. The doctor sees only what the scope allows, until expiry or revocation. Every view is written to the audit log, which the patient
   sees as "Access history".

## Security notes

- Sessions are signed HTTP-only cookies (patients 7 days, doctors 12 h, admins 8 h).
- Production refuses to start with the mock MPass, the demo extractor, or default secrets.
- Sending documents to Claude is processing of health data under Law 133/2011 and GDPR. Patients must give explicit consent to
  "read with AI" before go-live (not implemented yet), and the Anthropic data-retention settings must be reviewed.

## Not built yet

- Push notifications from a mobile app (approval is in the web app; SMS/email notifies).
- AI health hints from trends (the Trends screen shows values against reference ranges only).
- Consent screens, account deletion/export, and the MPass production registration with the e-Government Agency (AGE).
- Object storage (S3-compatible) in place of the local encrypted file store.
