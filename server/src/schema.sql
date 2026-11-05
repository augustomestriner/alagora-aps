CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'citizen' CHECK (role IN ('citizen', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY,
  author_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'moderate', 'high')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'monitoring', 'resolved')),
  photo TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  payload_hash TEXT NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_status_created ON reports(status, created_at DESC);
CREATE TABLE IF NOT EXISTS report_history (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_id, version)
);
-- Consulta incremental (sync delta): o app pede só o que mudou desde a última leitura.
CREATE INDEX IF NOT EXISTS reports_updated ON reports(updated_at);

-- Serviços em execução (API, coletor): cada processo grava um "batimento" periódico.
CREATE TABLE IF NOT EXISTS services (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('api', 'collector')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  interval_s INTEGER NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'
);

-- Áreas monitoradas e chuva hora a hora (medida ou prevista) coletada de fonte externa.
CREATE TABLE IF NOT EXISTS rain_areas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  radius_m INTEGER NOT NULL CHECK (radius_m > 0)
);
CREATE TABLE IF NOT EXISTS rain_hourly (
  area_id TEXT NOT NULL REFERENCES rain_areas(id) ON DELETE CASCADE,
  hour TIMESTAMPTZ NOT NULL,
  precipitation_mm REAL NOT NULL CHECK (precipitation_mm >= 0),
  forecast BOOLEAN NOT NULL,
  source TEXT NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (area_id, hour)
);
CREATE TABLE IF NOT EXISTS rain_status (
  area_id TEXT PRIMARY KEY REFERENCES rain_areas(id) ON DELETE CASCADE,
  rain_1h REAL NOT NULL DEFAULT 0,
  rain_3h REAL NOT NULL DEFAULT 0,
  rain_24h REAL NOT NULL DEFAULT 0,
  forecast_3h REAL NOT NULL DEFAULT 0,
  open_reports INTEGER NOT NULL DEFAULT 0,
  high_reports INTEGER NOT NULL DEFAULT 0,
  risk TEXT NOT NULL CHECK (risk IN ('none', 'attention', 'high', 'very_high')),
  previous_risk TEXT,
  reasons TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  reference_hour TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
