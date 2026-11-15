ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'github' CHECK(auth_method IN ('github','study'));
