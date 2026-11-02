CREATE TABLE IF NOT EXISTS players (
 nick VARCHAR(16) PRIMARY KEY,
 password_hash TEXT NOT NULL,
 credits BIGINT NOT NULL DEFAULT 1000,
 last_bonus_date VARCHAR(16) NOT NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE players ALTER COLUMN credits TYPE BIGINT;
CREATE TABLE IF NOT EXISTS casino_sessions (
 token_hash TEXT PRIMARY KEY, nick VARCHAR(16) NOT NULL REFERENCES players(nick),
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS casino_devices (
 secret_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL,
 nick VARCHAR(16) REFERENCES players(nick), expires_at TIMESTAMPTZ NOT NULL,
 claimed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS casino_rounds (
 id UUID PRIMARY KEY, nick VARCHAR(16) NOT NULL REFERENCES players(nick),
 game TEXT NOT NULL, bet BIGINT NOT NULL CHECK(bet>0), payout BIGINT NOT NULL DEFAULT 0,
 state JSONB NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','settled')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), settled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS casino_one_active_round ON casino_rounds(nick) WHERE status='active';
CREATE INDEX IF NOT EXISTS casino_history ON casino_rounds(nick,created_at DESC);
CREATE INDEX IF NOT EXISTS casino_ranking ON players(credits DESC,nick);
CREATE TABLE IF NOT EXISTS casino_requests (
 nick VARCHAR(16) NOT NULL REFERENCES players(nick), request_id UUID NOT NULL,
 fingerprint TEXT NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(nick,request_id)
);
