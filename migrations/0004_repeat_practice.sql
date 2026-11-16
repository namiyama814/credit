CREATE UNIQUE INDEX IF NOT EXISTS one_practice_repeat ON practice_sets(user_id,json_extract(conditions,'$.repeatedFrom')) WHERE json_extract(conditions,'$.repeatedFrom') IS NOT NULL;
