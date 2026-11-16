export function practiceQuestion(position=1){
 const answer=String(position+2),value=(position+2).toString(2);
 return {position,unit:'【第2回】情報を伝える',text:`2進数「${value}」を10進数に変換してください。`,type:'記述式',choices:[],answer,correctChoice:null,explanation:`右端から各桁の価値を決め、1のある桁を足すと${answer}です。`,concepts:['2進数・数値表現'],calculation:{type:'base_conversion',value,from:2,to:10},verification:{valid:true,uniqueAnswer:true,factuallyCorrect:true,aligned:true,reason:'各桁の値を足して独立に解き直しました。',independentAnswer:answer,confidence:1}};
}
