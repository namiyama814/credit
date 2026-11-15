import type { Question } from '../src/server/domain';
export function fixtureQuestion(n:number,kind:Question['question_type']='選択式',verified=true):Question {
  return {id:`fixture-${n}`,source_type:n%2?'確認テスト':'レポート',unit_name:`サンプル単元${n%4+1}`,lesson_name:'架空の授業',source_url:`https://example.com/question/${n}`,question_number:`Q${n+1}`,question_type:kind,question_text:`サンプル問題${n}。${kind==='選択式'?'選択肢から選んでください。':kind==='記述式'?'答えを入力してください。':'内容を説明してください。'}`,choices:kind==='選択式'?['ア．サンプルA','イ．サンプルB']:[],correct_answer:verified?(kind==='選択式'?'「ア．サンプルA」。':kind==='記述式'?`「用語${n}」。`:'「必要な概念とその理由を説明する」。'):'未確認',explanation:verified?'サンプルの解説です。':'未確認',image_paths:[],answer_verified:verified,answer_kind:!verified?'未確認':kind==='論述式'?'解答例':'正答'};
}
export function fullFixture(){return Array.from({length:171},(_,i)=>fixtureQuestion(i,i<63?'選択式':i<138?'記述式':'論述式',i<167));}
