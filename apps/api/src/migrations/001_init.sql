CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role text NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  email text UNIQUE,
  phone text UNIQUE,
  idnp text UNIQUE,                       -- Moldovan personal ID number, from MPass (doctors)
  first_name text,
  last_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL OR idnp IS NOT NULL)
);

CREATE TABLE patient_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  approval_pin_hash text,                  -- confirms doctor access, like a banking app
  pin_failures int NOT NULL DEFAULT 0,
  pin_locked_until timestamptz,
  birth_date date
);

CREATE TABLE otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  destination text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_dest ON otp_codes (destination, created_at DESC);

CREATE TABLE doctor_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'pending', 'certified', 'rejected', 'suspended')),
  license_number text,
  specialty text,
  institution text,
  license_file_key text,
  verification_method text CHECK (verification_method IN ('manual', 'registry')),
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('upload', 'email')),
  original_name text NOT NULL,
  mime text NOT NULL,
  size_bytes int NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'extracting', 'needs_review', 'confirmed', 'failed')),
  extraction jsonb,
  medicine_checks jsonb,
  error text,
  email_message_id text,
  email_from text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id, sha256)
);

CREATE TABLE records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  investigation_date date NOT NULL,
  institution text,
  doctor_name text,
  title text NOT NULL,
  summary text,
  transcription text,
  data jsonb NOT NULL DEFAULT '{}',
  confirmed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX records_patient_date ON records (patient_id, investigation_date DESC);

CREATE TABLE lab_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_name text NOT NULL,
  value numeric,
  value_text text,
  unit text,
  ref_low numeric,
  ref_high numeric,
  investigation_date date NOT NULL
);
CREATE INDEX lab_values_trend ON lab_values (patient_id, lower(test_name), investigation_date);

-- Moldova medicines register (AMDM nomenclator), loaded with `npm run import:medicines`.
CREATE TABLE medicines (
  id serial PRIMARY KEY,
  name text NOT NULL,
  inn text,
  form text,
  strength text,
  registration_number text,
  normalized text NOT NULL
);
CREATE INDEX medicines_trgm ON medicines USING gin (normalized gin_trgm_ops);

CREATE TABLE share_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  short_code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES users(id),
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('all', 'labs', 'prescriptions')),
  duration_hours int NOT NULL CHECK (duration_hours BETWEEN 1 AND 720),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES access_requests(id),
  doctor_id uuid NOT NULL REFERENCES users(id),
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_grants_active ON access_grants (doctor_id, patient_id) WHERE revoked_at IS NULL;

CREATE TABLE mail_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  imap_host text NOT NULL,
  imap_port int NOT NULL DEFAULT 993,
  username text NOT NULL,
  secret_enc text NOT NULL,                -- app password, encrypted with the storage master key
  mailbox text NOT NULL DEFAULT 'INBOX',
  sender_patterns text[] NOT NULL,         -- e.g. {'synevo.md'}
  last_uid int NOT NULL DEFAULT 0,
  last_polled_at timestamptz,
  last_error text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  patient_id uuid REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_patient ON audit_log (patient_id, at DESC);
