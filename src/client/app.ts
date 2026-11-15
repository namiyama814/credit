import type { nextExercise, getResult } from '../server/service';

type Exercise=Awaited<ReturnType<typeof nextExercise>>;
type Result=Awaited<ReturnType<typeof getResult>>;
type SafeQuestion=Result['question'];
type Child=Node|string|null|undefined|false;
const root=document.querySelector<HTMLElement>('#app')!;
const page=document.body.dataset.page!;
let csrf='',userId='';
const params=new URLSearchParams(location.search);
const verdicts:Record<string,string>={correct:'正解',incorrect:'不正解',pending:'採点待ち',needs_review:'要確認',unanswered:'未回答'};
function el<K extends keyof HTMLElementTagNameMap>(tag:K,attrs:Record<string,string|number|boolean>={},...children:Child[]):HTMLElementTagNameMap[K]{
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)){if(value===false)continue;if(key==='class')node.className=String(value);else node.setAttribute(key,value===true?'':String(value));}
  for(const child of children){if(child!==null&&child!==undefined&&child!==false)append(node,child);}
  return node;
}
function append(node:Node,...children:Child[]){for(const child of children){if(child!==null&&child!==undefined&&child!==false)node.appendChild(typeof child==='string'?document.createTextNode(child):child);}}
function render(...children:Child[]){root.replaceChildren(...children.filter((c):c is Node|string=>c!==null&&c!==undefined&&c!==false));}
function flash(message:string){document.querySelector('#notice')?.remove();const n=el('p',{id:'notice',class:'message error',role:'alert'},message);root.insertBefore(n,root.firstChild);n.scrollIntoView({block:'nearest'});}
async function api<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
  const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{} )},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(response.status===401){location.assign('/login/');throw new Error('ログインしてください。');}
  const data=await response.json() as T & {error?:string};if(!response.ok)throw new Error(data.error??'処理を完了できませんでした。');return data as T;
}
function button(label:string,fn:()=>unknown|Promise<unknown>,primary=false,small=false){
  const b=el('button',{type:'button',class:[primary?'primary':'',small?'small-button':''].filter(Boolean).join(' ')},label);
  b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(error){flash(error instanceof Error?error.message:'処理を完了できませんでした。');}finally{b.disabled=false;}});return b;
}
const link=(label:string,href:string,primary=false)=>el('a',{href,class:primary?'button primary':''},label);
const section=(title:string,...children:Child[])=>el('section',{class:'section'},el('h2',{},title),...children);
function textField(label:string,value='',multiline=false){const i=multiline?el('textarea',{'aria-label':label}):el('input',{type:'text','aria-label':label});i.value=value;return {node:el('label',{class:'field'},label,i),input:i};}
function formatText(text:string){
  const node=el('div',{class:'prose'});
  // A small, non-HTML TeX renderer for the imported formula. All glyphs keep
  // Noto Sans JP; no foreign math fonts or unsanitized HTML are introduced.
  const normalized=text.replace(/\\\(/gu,'').replace(/\\\)/gu,'').replace(/\\times/gu,'×');
  const parts=normalized.split(/(\^\{[^{}]+\})/gu);
  for(const part of parts){const m=part.match(/^\^\{([^{}]+)\}$/u);append(node,m?el('sup',{},m[1]):part);}return node;
}
function questionBody(q:SafeQuestion){
  const n=el('div',{class:'question'}),codes=Array.isArray(q.codeBlocks)?q.codeBlocks.filter((v):v is string=>typeof v==='string'):[];
  let remaining=q.text;
  for(const code of codes){const i=remaining.indexOf(code);if(i<0)continue;append(n,formatText(remaining.slice(0,i)),el('pre',{},el('code',{},code)));remaining=remaining.slice(i+code.length);}
  append(n,formatText(remaining));
  if(q.images.length)append(n,el('div',{class:'question-images'},...q.images.map((src,i)=>el('img',{src,alt:`問題の図表 ${i+1}`,loading:'eager'}))));
  return n;
}
async function dashboard(){
  render(el('div',{class:'home-actions'},button('始める',async()=>{const p=await api<{current?:{status:string}}>('/rounds');await api('/rounds/start',{restart:p.current?.status==='cleared'});location.assign('/exercise/');},true),button('問題集を見る',()=>location.assign('/practice/'))));
}
let disposeExercise:(()=>void)|undefined;
async function exercise(){
  disposeExercise?.();
  const type=params.get('type')??'round',contextId=params.get('id');
  let data:Exercise;
  if(type==='review'){
    const qid=params.get('question');if(!qid)throw new Error('問題を選択してください。');
    const q=await api<SafeQuestion>(`/questions/${encodeURIComponent(qid)}`);
    data={question:q,contextType:'review',contextId:'review',draft:null};
  }else data=await api<Exercise>(`/exercise?type=${encodeURIComponent(type)}${contextId?`&id=${encodeURIComponent(contextId)}`:''}`);
  if(!data.question){
    const progress='progress' in data?data.progress:undefined;
    render(el('h1',{},progress?.current?.status==='cleared'?'全問クリア':progress&&(progress.counts.pending||progress.counts.needs_review)?'採点を確認':'回答が完了しました'),progress&&el('p',{},`採点待ち ${progress.counts.pending}問　要確認 ${progress.counts.needs_review}問`),el('div',{class:'actions'},link(type==='practice'?'問題集へ':'戻る',type==='practice'?'/practice/':'/',true)));return;
  }
  const q=data.question;
  if(!q.gradable){render(el('h1',{},'振り返り'),questionBody(q),el('p',{class:'message'},'正答未確認のため採点対象外です。'),link('問題一覧へ','/questions/'));return;}
  const context=data.contextId!,key=`info1:${userId}:${data.contextType}:${context}:${q.id}`,draftKey=`${key}:draft`,pendingKey=`${key}:pending`;
  let response:string|string[]=data.draft?.response as string|string[]??(q.type==='選択式'?[]:''),elapsed=data.draft?.elapsedMs??0;
  const saved=localStorage.getItem(draftKey);if(saved){try{const local=JSON.parse(saved);if(local.versionId===q.versionId){response=local.response;elapsed=Math.max(elapsed,local.elapsedMs??0);}}catch{localStorage.removeItem(draftKey);}}
  let pending:{id:string;response:string|string[];durationMs:number}|null=null;
  try{pending=JSON.parse(localStorage.getItem(pendingKey)??'null');}catch{localStorage.removeItem(pendingKey);}
  if(pending)response=pending.response;
  const inputArea=el('div',{}),controls:HTMLButtonElement[]=[];
  let textarea:HTMLInputElement|HTMLTextAreaElement|undefined,lastTick=performance.now(),timer:ReturnType<typeof setTimeout>|undefined,submitting=false;
  const tick=()=>{const t=performance.now();if(document.visibilityState==='visible'&&!submitting)elapsed+=Math.max(0,t-lastTick);lastTick=t;};
  const interval=setInterval(tick,1000);
  const localSave=()=>{tick();localStorage.setItem(draftKey,JSON.stringify({response,elapsedMs:Math.round(elapsed),versionId:q.versionId}));};
  const save=async()=>{localSave();try{await api('/draft',{contextType:data.contextType,contextId:context,questionId:q.id,versionId:q.versionId,response,elapsedMs:Math.round(elapsed)},'PUT');}catch{/* The local draft remains available. */}};
  const change=()=>{localSave();clearTimeout(timer);timer=setTimeout(()=>void save(),600);};
  if(q.type==='選択式'){
    const list=el('div',{class:'choice-list',role:'group','aria-label':'選択肢'});
    for(const choice of q.choices){const b=el('button',{type:'button',class:'choice','aria-pressed':Array.isArray(response)&&response.includes(choice.id)?'true':'false'},el('span',{class:'choice-indicator','aria-hidden':'true'}),el('span',{},choice.text));
      b.disabled=!!pending;b.addEventListener('click',()=>{response=[choice.id];for(const other of controls)other.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');change();});controls.push(b);append(list,b);}
    append(inputArea,list);
  }else{
    const field=textField(q.type==='論述式'?'回答':'回答を入力',typeof response==='string'?response:'',q.type==='論述式');textarea=field.input;textarea.disabled=!!pending;textarea.addEventListener('input',()=>{response=textarea!.value;change();});append(inputArea,field.node);
  }
  const submit=button('送信',async()=>{
    if(submitting)return;if(Array.isArray(response)?!response.length:!response.trim())throw new Error('回答を入力してください。');
    tick();submitting=true;clearTimeout(timer);
    pending??={id:crypto.randomUUID(),response,durationMs:Math.round(elapsed)};
    localStorage.setItem(pendingKey,JSON.stringify(pending));
    controls.forEach(b=>b.disabled=true);if(textarea)textarea.disabled=true;
    try{
      const result=await api<Result>('/answers',{...pending,contextType:data.contextType,contextId:context,questionId:q.id,versionId:q.versionId});
      localStorage.removeItem(draftKey);localStorage.removeItem(pendingKey);clearInterval(interval);
      const nextURL=data.contextType==='review'?'/questions/':data.contextType==='round'?'/exercise/':`/exercise/?type=practice&id=${encodeURIComponent(context)}`;
      location.assign(`/result/?id=${encodeURIComponent(result.attempt.id)}&next=${encodeURIComponent(nextURL)}`);
    }finally{submitting=false;}
  },true);
  const onPageHide=()=>{if(!submitting)localSave();};window.addEventListener('pagehide',onPageHide);
  disposeExercise=()=>{clearInterval(interval);clearTimeout(timer);window.removeEventListener('pagehide',onPageHide);};
  render(questionBody(q),inputArea,el('div',{class:'exercise-footer'},submit));
}
async function resultPage(){
  const attemptId=params.get('id');if(!attemptId)throw new Error('回答を選択してください。');
  const r=await api<Result>(`/results/${encodeURIComponent(attemptId)}`),evaluation=r.attempt.evaluation_data as {reason:string;improvement:string};
  const next=params.get('next'),nextURL=next?.startsWith('/')&&!next.startsWith('//')?next:'/exercise/';
  render(el('h1',{class:'result-label'},verdicts[r.attempt.verdict]),
    section('あなたの回答',formatText(Array.isArray(r.attempt.response)?r.question.choices.filter(c=>(r.attempt.response as string[]).includes(c.id)).map(c=>c.text).join('\n'):String(r.attempt.response))),
    section(String(r.answerKind),formatText(r.correctAnswer)),r.explanation&&section('解説',formatText(r.explanation)),
    r.attempt.method!=='rule'&&evaluation.reason&&section('参考評価',formatText(evaluation.reason),evaluation.improvement&&formatText(evaluation.improvement)),
    el('div',{class:'actions'},link('次の問題へ',nextURL,true),r.attempt.verdict==='pending'&&button('採点結果を更新',resultPage)));
}
async function practicePage(){
  const setId=params.get('id');if(setId){location.replace(`/exercise/?type=practice&id=${encodeURIComponent(setId)}`);return;}
  const sets=await api<{id:string;name:string;status:string}[]>('/practice');
  const ready=sets.filter(s=>s.status==='ready');
  render(ready.length?el('div',{class:'collection-list'},...ready.map(s=>link(s.name,`/exercise/?type=practice&id=${encodeURIComponent(s.id)}`,true))):el('div',{class:'practice-empty'},el('p',{},'問題集がありません')));
}
async function main(){
  const session=await api<{userId:string;csrf:string}>('/me');csrf=session.csrf;userId=session.userId;
  const routes:Record<string,()=>Promise<void>>={dashboard,exercise,result:resultPage,practice:practicePage};
  await (routes[page]??dashboard)();
}
void main().catch(error=>{document.querySelector('.loading')?.remove();flash(error instanceof Error?error.message:'読み込みに失敗しました。');});
