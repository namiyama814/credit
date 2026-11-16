import {z} from 'zod';
// The caller converts validation errors to its public API error.
class ContentError extends Error {readonly status=400;}

export const Calculation=z.discriminatedUnion('type',[
 z.object({type:z.literal('binary_place'),position:z.number().int().min(1).max(20)}),
 z.object({type:z.literal('base_conversion'),value:z.string().regex(/^[0-9a-fA-F]{1,12}$/u),from:z.union([z.literal(2),z.literal(10),z.literal(16)]),to:z.union([z.literal(2),z.literal(10),z.literal(16)])}),
 z.object({type:z.literal('binary_addition'),left:z.string().regex(/^[01]{1,20}$/u),right:z.string().regex(/^[01]{1,20}$/u)}),
 z.object({type:z.literal('data_size'),sampleRate:z.number().int().min(1).max(1000000),bits:z.number().int().min(1).max(64),channels:z.number().int().min(1).max(8),seconds:z.number().int().min(1).max(3600)}),
]);
export const PracticeQuestion=z.object({
 position:z.number().int().min(1).max(20),unit:z.string().min(1).max(100),
 text:z.string().min(15).max(1800),type:z.enum(['選択式','記述式','論述式']),
 choices:z.array(z.string().min(1).max(300)).max(6),answer:z.string().min(1).max(1200),
 correctChoice:z.number().int().min(0).max(5).nullable(),explanation:z.string().min(10).max(2000),
 concepts:z.array(z.string().min(1).max(60)).min(1).max(5),calculation:Calculation.nullable(),
 verification:z.object({valid:z.boolean(),uniqueAnswer:z.boolean(),factuallyCorrect:z.boolean(),aligned:z.boolean(),reason:z.string().min(1).max(1200),independentAnswer:z.string().min(1).max(1200),confidence:z.number().min(0).max(1)}),
});
export function solveCalculation(c:z.infer<typeof Calculation>):string{
 if(c.type==='binary_place')return String(2**(c.position-1));
 if(c.type==='base_conversion'){
  const allowed=c.from===2?/^[01]+$/u:c.from===10?/^[0-9]+$/u:/^[0-9a-f]+$/iu;
  if(!allowed.test(c.value))throw new ContentError('基数と数値が一致しません。');
  return Number.parseInt(c.value,c.from).toString(c.to).toUpperCase();
 }
 if(c.type==='binary_addition')return (Number.parseInt(c.left,2)+Number.parseInt(c.right,2)).toString(2);
 return String(c.sampleRate*c.bits*c.channels*c.seconds/8);
}
export function validatePracticeQuestion(g:z.infer<typeof PracticeQuestion>){
 if(g.type==='選択式'&&(g.choices.length!==4||g.correctChoice===null||g.correctChoice>=g.choices.length||g.choices[g.correctChoice]!==g.answer||new Set(g.choices).size!==g.choices.length))throw new ContentError('選択肢と正答を確認してください。');
 if(g.type!=='選択式'&&(g.choices.length||g.correctChoice!==null))throw new ContentError('記述問題の形式を確認してください。');
 const v=g.verification;
 if(!v.valid||!v.uniqueAnswer||!v.factuallyCorrect||!v.aligned||v.confidence<0.85)throw new ContentError('問題を検証してから送信してください。');
 const calculated=g.calculation?solveCalculation(g.calculation):null;
 if(calculated!==null&&calculated!==g.answer.trim())throw new ContentError('検算結果が一致しません。');
 if(g.type!=='論述式'&&v.independentAnswer.trim().normalize('NFKC')!==g.answer.trim().normalize('NFKC'))throw new ContentError('検証した解答が一致しません。');
 return {...v,calculation:g.calculation,calculationResult:calculated,method:calculated===null?'client_review':'client_review_and_calculation',reviewer:'MCP client',ownerApprovalRequired:true,version:'client-verify-v1'};
}
