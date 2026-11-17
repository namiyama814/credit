import {PracticeQuestion} from './practice-content';
import { z } from 'zod';

export const SourceQuestion = z.looseObject({
  id: z.string().min(1).max(160), source_type: z.enum(['確認テスト', 'レポート']),
  unit_name: z.string(), lesson_name: z.string(), source_url: z.url(),
  question_number: z.string(), question_type: z.enum(['選択式', '記述式', '論述式']),
  question_text: z.string().min(1), choices: z.array(z.string()), correct_answer: z.string(),
  explanation: z.string(), image_paths: z.array(z.string()), answer_verified: z.boolean(),
});
export type Question = z.infer<typeof SourceQuestion>;
export type Verdict = 'pending' | 'needs_review' | 'correct' | 'incorrect';
export interface GradingRule {
  type: 'choice' | 'short' | 'essay' | 'none';
  accepted: string[]; normalizeWidth: boolean; caseSensitive: boolean;
  requiredCase?: 'upper' | 'lower'; width?: 'half' | 'full'; version: string;
}
export interface Evaluation {
  verdict: Verdict; score: number | null; reason: string; strengths: string[];
  missing: string[]; improvement: string; model: string; promptVersion: string;
  rubricVersion: string; gradedAt: string; confidence?: number; components?: {concepts:number;accuracy:number;conditions:number}; essentialConceptsMet?:boolean; criticalError?:boolean;
}
export const AIGrading = z.object({
  score: z.number().min(0).max(100),
  verdict: z.enum(['correct', 'incorrect']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(2000).regex(/[ぁ-んァ-ヶ一-龯]/u), strengths: z.array(z.string().max(500)).max(10),
  missing: z.array(z.string().max(500)).max(10), improvement: z.string().max(2000),
  essentialConceptsMet: z.boolean(), criticalError: z.boolean(),
  components: z.object({ concepts: z.number().min(0).max(50), accuracy: z.number().min(0).max(30), conditions: z.number().min(0).max(20) }),
});
export const AnswerInput = z.object({
  id: z.uuid(), contextType: z.enum(['round', 'practice', 'review']),
  contextId: z.string().min(1).max(160), questionId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160), response: z.union([z.string().trim().min(1).max(5000), z.array(z.string().max(160)).min(1).max(10)]),
  durationMs: z.number().int().min(0).max(86400000),
});
export type Answer = z.infer<typeof AnswerInput>;
export const PracticeInput = z.object({
  name: z.string().trim().min(1).max(80).default('問題集'),
  origin: z.enum(['school', 'ai']).default('ai'),
  mode: z.enum(['weakness', 'application', 'comprehensive', 'mock']).default('weakness'),
  count: z.number().int().min(1).max(20).optional(),
  tags: z.array(z.string().max(60)).max(12).default([]),
  instructions: z.string().trim().max(2000).optional(),
  setId: z.uuid().optional(),
  questions: z.array(PracticeQuestion).max(20).optional(),
  questionIds: z.array(z.string().max(160)).max(167).optional(),
});
export type PracticeConditions = z.infer<typeof PracticeInput>;
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function parseJSON<T>(value: string): T { return JSON.parse(value) as T; }

export function deriveRule(q: Question): GradingRule {
  const base: GradingRule = { type: 'none', accepted: [], normalizeWidth: false, caseSensitive: true, version: 'rules-v1' };
  if (!q.answer_verified) return base;
  if (q.question_type === '論述式') return { ...base, type: 'essay' };
  const quoted = q.correct_answer.match(/^「([^「」]+)」/u)?.[1];
  if (!quoted) throw new Error(`採点値を特定できません: ${q.id}`);
  if (q.question_type === '選択式') {
    const label = quoted.match(/^[アイウエオカキクケコ]/u)?.[0];
    const index = q.choices.findIndex(c => c.startsWith(label ?? '\0'));
    if (index < 0) throw new Error(`正答選択肢を特定できません: ${q.id}`);
    return { ...base, type: 'choice', accepted: [String(index)] };
  }
  const explicitWidth = /全角|半角/u.test(q.question_text);
  const requiredCase = /大文字/u.test(q.question_text) ? 'upper' : /小文字/u.test(q.question_text) ? 'lower' : undefined;
  return { ...base, type: 'short', accepted: [quoted], normalizeWidth: !explicitWidth,
    ...(requiredCase ? { requiredCase } : {}),
    ...(/半角/u.test(q.question_text) && /^[\x20-\x7e]+$/u.test(quoted) ? { width: 'half' as const } : {}),
    ...(/全角/u.test(q.question_text) && !/半角/u.test(q.question_text) ? { width: 'full' as const } : {}),
  };
}
export function gradeRule(rule: GradingRule, response: string | string[]): Evaluation {
  let verdict: Verdict = 'incorrect';
  if (rule.type === 'none') verdict = 'needs_review';
  else if (rule.type === 'essay') verdict = 'pending';
  else if (rule.type === 'choice') {
    const chosen = Array.isArray(response) ? [...response].sort() : [response];
    verdict = JSON.stringify(chosen) === JSON.stringify([...rule.accepted].sort()) ? 'correct' : 'incorrect';
  } else if (typeof response === 'string') {
    const normalize = (s: string) => {
      const n = s.trim().normalize(rule.normalizeWidth ? 'NFKC' : 'NFC');
      return rule.caseSensitive ? n : n.toLocaleLowerCase('en');
    };
    const value = response.trim();
    const caseOK = !rule.requiredCase || value === (rule.requiredCase === 'upper' ? value.toUpperCase() : value.toLowerCase());
    const widthOK = rule.width !== 'half' || !/[Ａ-Ｚａ-ｚ０-９]/u.test(value);
    verdict = caseOK && widthOK && rule.accepted.some(v => normalize(v) === normalize(value)) ? 'correct' : 'incorrect';
  }
  return { verdict, score: verdict === 'correct' ? 100 : verdict === 'incorrect' ? 0 : null,
    reason: verdict === 'correct' ? '正答と一致しています。' : verdict === 'incorrect' ? '正答または指定された表記条件と一致しません。' : verdict === 'pending' ? 'AI採点待ち' : '採点を確認してください。',
    strengths: [], missing: [], improvement: '', model: 'deterministic', promptVersion: 'none', rubricVersion: rule.version, gradedAt: now() };
}

const TAG_RULES: [string, RegExp][] = [
  ['情報モラル', /情報モラル|誹謗|いじめ|フィッシング|テクノストレス|個人情報|ジオタグ/u],
  ['著作権', /著作権|知的財産|商標|引用|コモンズ|産業財産/u],
  ['問題解決・発想法', /問題解決|発想法|ブレ[イー]ンストーミング|マインドマップ|KJ法|PERT|PMI/u],
  ['検索・情報収集', /検索|キーワード|情報収集/u],
  ['情報社会', /情報社会|デジタルデバイド|選挙|電子マネー|人工知能|ディープラーニング|DX|仮想現実|VR/u],
  ['情報デザイン', /デザイン|ピクトグラム|ペルソナ|プレゼンテーション|図解|アクセシビリティ|ユーザビリティ/u],
  ['コミュニケーション', /コミュニケーション|SNS|クラウドファンディング|集合知/u],
  ['2進数・数値表現', /[２2]進|[１1][６6]進|ビット|基数/u],
  ['デジタルデータ', /デジタル表現|標本化|量子化|符号化|データ量|圧縮|解像度|文字コード|Unicode|RGB|音質|高画質/u],
  ['コンピュータ・論理回路', /CPU|メモリ|OS|ソフトウェア|論理回路|AND 回路|OR 回路|NOT 回路|演算/u],
  ['アルゴリズム', /アルゴリズム|順次|分岐|反復|フローチャート/u],
  ['プログラミング', /プログラ[ミム]|Python|JavaScript|Scratch|変数|乱数|WebAPI/u],
  ['モデル化・シミュレーション', /モデル化|シミュレーション/u],
  ['ネットワーク', /ネットワーク|インターネット|IPアドレス|DNS|パケット|サーバ|クライアント|プロトコル|TCP|HTTP/u],
  ['情報セキュリティ', /セキュリティ|認証|暗号|マルウェア|ファイアウォール|フェイルセーフ|フールプルーフ/u],
  ['データベース', /データベース|関係データ|POS|SQL/u],
  ['データ分析', /データ分析|ヒストグラム|散布図|円グラフ|相関|回帰|中央値|平均値|外れ値|欠損値|量的データ|質的データ|マイニング|クロス集計/u],
];
export function deriveTags(q: Question): string[] {
  const evidence = [q.question_text, q.lesson_name, q.explanation, ...q.choices].join('\n');
  const tags = TAG_RULES.filter(([, re]) => re.test(evidence)).map(([name]) => name);
  return tags.length ? tags : ['情報の基礎'];
}
export function safeQuestion(q: Question, versionId: string, tags: string[], origin = 'school') {
  return { id: q.id, versionId, origin, mock:q.mock===true, sourceType: q.source_type, unit: q.unit_name,
    lesson: q.lesson_name, number: q.question_number, type: q.question_type,
    text: q.question_text, choices: q.choices.map((text, i) => ({ id: String(i), text })),
    images: q.image_paths.map(path => `/api/images?path=${encodeURIComponent(path)}&version=${encodeURIComponent(versionId)}`),
    sourceUrl: q.source_url, tags, gradable: q.answer_verified, codeBlocks: q.code_blocks ?? [] };
}
