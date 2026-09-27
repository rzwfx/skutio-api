-- 001: jurnalul analizelor. Păstrăm DOAR metadate (verdict, scor, durată),
-- niciodată textul sau imaginea analizată: nu stocăm date personale ale utilizatorilor.
CREATE TABLE analyses (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  source      text        NOT NULL CHECK (source IN ('api', 'demo')),
  input_type  text        NOT NULL CHECK (input_type IN ('text', 'image')),
  input_chars integer     CHECK (input_chars >= 0),
  verdict     text        NOT NULL CHECK (verdict IN ('safe', 'suspicious', 'dangerous')),
  score       smallint    NOT NULL CHECK (score BETWEEN 0 AND 100),
  duration_ms integer     NOT NULL CHECK (duration_ms >= 0)
);

-- Statisticile filtrează pe intervale de timp (ultimele 24h).
CREATE INDEX analyses_created_at_idx ON analyses (created_at);
