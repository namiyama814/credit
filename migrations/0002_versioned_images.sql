CREATE TABLE IF NOT EXISTS asset_blobs (content_hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS version_assets (version_id TEXT NOT NULL REFERENCES question_versions(id), path TEXT NOT NULL, content_hash TEXT NOT NULL REFERENCES asset_blobs(content_hash), PRIMARY KEY(version_id,path));
INSERT OR IGNORE INTO asset_blobs SELECT content_hash,mime,bytes FROM assets;
INSERT OR IGNORE INTO version_assets SELECT v.id,j.value,a.content_hash FROM question_versions v,json_each(v.payload,'$.image_paths') j JOIN assets a ON a.path=j.value;
