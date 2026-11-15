# 保存形式サンプル

このディレクトリは形式確認用です。問題文・選択肢・授業名・URLはすべて架空のプレースホルダーで、実際の教材・提出履歴は含みません。

- `questions.json`: 必須項目を備えた形式例2件
- `confirmation-tests/lesson-001.md`: 確認テストの表示例
- `reports/report-01.md`: レポートの表示例
- `reports/report-02.md`〜`report-04.md`: ファイル配置の例
- `assets/`: 画像配置先の説明のみ
- `manifest.md`: 件数・取得状況の記録例

実データはリポジトリ直下の `info1-exam-preparation/` に置きます。この実データ用ディレクトリは全体がGitの対象外です。サンプル側に教材をコピーしないでください。

`choices` は表示順の配列です。正答が未確認の場合は `correct_answer` を「未確認」、`answer_verified` を `false` にします。画像がある場合は `image_paths` に `assets/ファイル名` を指定し、Markdownから `../assets/ファイル名` で参照します。
