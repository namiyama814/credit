import type { practiceResults } from './service';

// Verification prose and independent/calculated answers are answer-bearing data.
// An allowlist is deliberately avoided: omit the entire verification object
// when answers are not authorized, including any future nested fields.
export function practiceVisibility(data:Awaited<ReturnType<typeof practiceResults>>,includeAnswers:boolean){
  if(includeAnswers)return data;
  return {...data,items:data.items.map(({verification,correctAnswer,explanation,...item})=>item)};
}
