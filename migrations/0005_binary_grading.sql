-- Preserve the original evaluations and append binary results for old review states.
WITH review AS (
 SELECT *,CASE WHEN method='rule' THEN 0 ELSE COALESCE(
  json_extract(evaluation_data,'$.components.concepts')+json_extract(evaluation_data,'$.components.accuracy')+json_extract(evaluation_data,'$.components.conditions'),score) END AS binary_score
 FROM effective_attempts WHERE verdict='needs_review' AND (method='rule' OR (method='ai' AND score IS NOT NULL))
)
INSERT INTO evaluations(id,attempt_id,verdict,score,method,data,created_at)
SELECT lower(hex(randomblob(16))),id,
 CASE WHEN method='ai' AND binary_score>=80
  AND json_extract(evaluation_data,'$.essentialConceptsMet')=1
  AND json_extract(evaluation_data,'$.criticalError')=0 THEN 'correct' ELSE 'incorrect' END,
 binary_score,method,
 json_set(evaluation_data,'$.score',binary_score,'$.verdict',
  CASE WHEN method='ai' AND binary_score>=80
   AND json_extract(evaluation_data,'$.essentialConceptsMet')=1
   AND json_extract(evaluation_data,'$.criticalError')=0 THEN 'correct' ELSE 'incorrect' END,
  '$.rubricVersion','concept50-accuracy30-conditions20-v2-binary',
  '$.gradedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM review;

-- An inference failure is not an incorrect answer: retry it automatically.
INSERT INTO evaluations(id,attempt_id,verdict,score,method,data,created_at)
SELECT lower(hex(randomblob(16))),id,'pending',NULL,'ai',
 json_set(evaluation_data,'$.verdict','pending','$.reason','AI採点を自動再試行します。',
  '$.gradedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM effective_attempts WHERE verdict='needs_review' AND method='ai' AND score IS NULL;
UPDATE jobs SET status='pending',tries=0,lease_until=NULL,
 next_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE kind='grade' AND status='failed'
 AND json_extract(payload,'$.attemptId') IN (SELECT id FROM effective_attempts WHERE verdict='pending');
