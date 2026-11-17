import {formatText} from './math';
import { icon } from './icons';
import type { nextExercise, getResult, practiceResults } from '../server/service';

type Exercise=Awaited<ReturnType<typeof nextExercise>>;
type RoundProgress=Awaited<ReturnType<typeof import('../server/service').roundProgress>>;
type Result=Awaited<ReturnType<typeof getResult>>;
type SafeQuestion=Result['question'];
type Child=Node|string|null|undefined|false;
const root=document.querySelector<HTMLElement>('#app')!;
const page=document.body.dataset.page!;
let csrf='',userId='',canManage=false;
let practiceRefresh:ReturnType<typeof setTimeout>|undefined;
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
class APIError extends Error { constructor(public status:number,message:string){super(message);} }
const localRead=(key:string)=>{try{return localStorage.getItem(key);}catch{return null;}};
const localWrite=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* Server drafts remain available when browser storage is full or blocked. */}};
const localRemove=(key:string)=>{try{localStorage.removeItem(key);}catch{/* Storage may be blocked. */}};
function nextStudyURL(value:string|null){
  if(!value||!value.startsWith('/')||/[\\\u0000-\u0020\u007f]/u.test(value))return '/exercise/';
  try {
    const url=new URL(value,location.origin);
    return url.origin===location.origin&&['/','/exercise/','/practice/'].includes(url.pathname)?url.pathname+url.search:'/exercise/';
  } catch { return '/exercise/'; }
}
async function api<T>(path:string,body?:unknown,method=body===undefined?'GET':'POST'):Promise<T>{
  const response=await fetch(`/api${path}`,{method,credentials:'same-origin',headers:{...(body!==undefined?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{} )},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(response.status===401){location.assign('/login/');throw new Error('ログインしてください。');}
  let data:T & {error?:string};
  try {data=await response.json() as T & {error?:string};}catch{if(!response.ok)throw new APIError(response.status,'処理を完了できませんでした。');throw new Error('応答を確認できませんでした。再試行してください。');}
  if(!response.ok)throw new APIError(response.status,data.error??'処理を完了できませんでした。');return data as T;
}
function button(label:string,fn:()=>unknown|Promise<unknown>,primary=false,small=false){
  const b=el('button',{type:'button',class:[primary?'primary':'',small?'small-button':''].filter(Boolean).join(' ')},label);
  b.addEventListener('click',async()=>{b.disabled=true;try{await fn();}catch(error){flash(error instanceof Error?error.message:'処理を完了できませんでした。');}finally{b.disabled=false;}});return b;
}
const link=(label:string,href:string,primary=false)=>el('a',{href,class:primary?'button primary':''},label);
function textField(label:string,value='',multiline=false){const i=multiline?el('textarea',{'aria-label':label,placeholder:label}):el('input',{type:'text','aria-label':label,placeholder:label});i.maxLength=5000;i.value=value;return {node:el('div',{class:'field'},i),input:i};}
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
    const unresolved=type==='round'&&progress ? (await api<RoundProgress>(`/rounds${data.contextId?`?id=${encodeURIComponent(data.contextId)}`:''}`)).items.filter(i=>i.verdict==='pending'||i.verdict==='needs_review') : [];
    render(el('div',{class:'completion-content'},el('h1',{},progress?.current?.status==='cleared'?'全問クリア':progress&&(progress.counts.pending||progress.counts.needs_review)?'採点を確認':'回答が完了しました'),progress&&(type!=='practice'||!!(progress.counts.pending||progress.counts.needs_review))&&el('p',{},`採点待ち ${progress.counts.pending}問　要確認 ${progress.counts.needs_review}問`),el('div',{class:'actions completion-actions'},progress&&progress.current?.status!=='cleared'&&button('採点結果を更新',exercise,true),link(type==='practice'?'問題集へ':'戻る',type==='practice'?'/practice/':'/',type!=='practice')), el('div',{class:'completion-reviews'},...unresolved.map((item,i)=>link(`回答${i+1}の採点を確認`,`/result/?id=${encodeURIComponent(item.attempt_id!)}&next=${encodeURIComponent('/exercise/')}`,false)) )));return;
  }
  const q=data.question;
  if(!q.gradable){render(el('h1',{},'振り返り'),questionBody(q),el('p',{class:'message'},'正答未確認のため採点対象外です。'),link('問題一覧へ','/questions/'));return;}
  const context=data.contextId!,key=`info1:${userId}:${data.contextType}:${context}:${q.id}`,draftKey=`${key}:draft`,pendingKey=`${key}:pending`;
  let response:string|string[]=data.draft?.response as string|string[]??(q.type==='選択式'?[]:''),elapsed=data.draft?.elapsedMs??0;
  let editedAt=Date.parse(data.draft?.updatedAt??'')||0;
  const saved=localRead(draftKey);if(saved){try{const local=JSON.parse(saved);if(local.versionId===q.versionId&&(!data.draft||Number(local.editedAt)>editedAt)){response=local.response;elapsed=Math.max(elapsed,local.elapsedMs??0);editedAt=Number(local.editedAt)||0;}}catch{localRemove(draftKey);}}
  let pending:{id:string;response:string|string[];durationMs:number;versionId?:string}|null=null;
  try{pending=JSON.parse(localRead(pendingKey)??'null');if(pending?.versionId&&pending.versionId!==q.versionId){pending=null;localRemove(pendingKey);}}catch{localRemove(pendingKey);}
  if(pending)response=pending.response;
  const inputArea=el('div',{}),controls:HTMLButtonElement[]=[];
  let textarea:HTMLInputElement|HTMLTextAreaElement|undefined,lastTick=performance.now(),timer:ReturnType<typeof setTimeout>|undefined,submitting=false,submitted=false;
  const tick=()=>{const t=performance.now();if(document.visibilityState==='visible'&&!submitting)elapsed=Math.min(86400000,elapsed+Math.max(0,t-lastTick));lastTick=t;};
  const interval=setInterval(tick,1000);
  const localSave=()=>{tick();localWrite(draftKey,JSON.stringify({response,elapsedMs:Math.round(elapsed),versionId:q.versionId,editedAt}));};
  const save=async()=>{localSave();try{await api('/draft',{contextType:data.contextType,contextId:context,questionId:q.id,versionId:q.versionId,response,elapsedMs:Math.round(elapsed)},'PUT');}catch{/* The local draft remains available. */}};
  const change=()=>{editedAt=Date.now();localSave();clearTimeout(timer);timer=setTimeout(()=>void save(),600);};
  if(q.type==='選択式'){
    const list=el('div',{class:'choice-list',role:'group','aria-label':'選択肢'});
    for(const choice of q.choices){const b=el('button',{type:'button',class:'choice','aria-pressed':Array.isArray(response)&&response.includes(choice.id)?'true':'false'},icon('radio','choice-indicator'),formatText(choice.text));
      b.disabled=!!pending;b.addEventListener('click',()=>{response=[choice.id];for(const other of controls)other.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');change();});controls.push(b);append(list,b);}
    append(inputArea,list);
  }else{
    const field=textField('回答を入力',typeof response==='string'?response:'',q.type==='論述式');textarea=field.input;textarea.disabled=!!pending;textarea.addEventListener('input',()=>{response=textarea!.value;change();});append(inputArea,field.node);
  }
  const submit=button('送信',async()=>{
    if(submitting)return;if(Array.isArray(response)?!response.length:!response.trim())throw new Error('回答を入力してください。');
    if(typeof response==='string'&&response.length>5000)throw new Error('回答は5000文字以内で入力してください。');
    tick();submitting=true;clearTimeout(timer);
    pending??={id:crypto.randomUUID(),response,durationMs:Math.min(86400000,Math.round(elapsed)),versionId:q.versionId};
    localWrite(pendingKey,JSON.stringify(pending));
    controls.forEach(b=>b.disabled=true);if(textarea)textarea.disabled=true;
    try{
      const result=await api<Result>('/answers',{...pending,contextType:data.contextType,contextId:context,questionId:q.id,versionId:q.versionId});
      submitted=true;localRemove(draftKey);localRemove(pendingKey);clearInterval(interval);
      const nextURL=data.contextType==='review'?'/questions/':data.contextType==='round'?'/exercise/':`/exercise/?type=practice&id=${encodeURIComponent(context)}`;
      location.assign(`/result/?id=${encodeURIComponent(result.attempt.id)}&next=${encodeURIComponent(nextURL)}`);
    }catch(error){
      if(error instanceof APIError&&error.status>=400&&error.status<500&&error.status!==429){
        pending=null;localRemove(pendingKey);controls.forEach(b=>b.disabled=false);if(textarea)textarea.disabled=false;
        if(error.status===409){localRemove(draftKey);await exercise();}
      }
      throw error;
    }finally{submitting=false;}
  },true);
  const onPageHide=()=>{if(!submitting&&!submitted)localSave();};window.addEventListener('pagehide',onPageHide);
  disposeExercise=()=>{clearInterval(interval);clearTimeout(timer);window.removeEventListener('pagehide',onPageHide);};
  render(el('div',{class:'exercise-content'},questionBody(q),inputArea,el('div',{class:'exercise-footer'},submit)));
}
async function resultPage(){
  const attemptId=params.get('id');if(!attemptId)throw new Error('回答を選択してください。');
  const r=await api<Result>(`/results/${encodeURIComponent(attemptId)}`),evaluation=r.attempt.evaluation_data as {reason:string;improvement:string};
  const nextURL=nextStudyURL(params.get('next'));
  const response=Array.isArray(r.attempt.response)?r.question.choices.filter(c=>(r.attempt.response as string[]).includes(c.id)).map(c=>c.text).join('\n'):String(r.attempt.response);
  const answerBlock=(label:string,value:string)=>el('section',{class:'result-answer'},el('h2',{},label),formatText(value));
  const symbol=r.attempt.verdict==='correct'?'correct':r.attempt.verdict==='incorrect'?'incorrect':r.attempt.verdict==='pending'?'pending':'review';
  const needsReview=r.attempt.verdict==='needs_review';
  const reason=textField('採点の修正理由');reason.input.maxLength=1000;
  const correct=async(verdict:'correct'|'incorrect')=>{if(!reason.input.value.trim())throw new Error('採点の修正理由を入力してください。');await api(`/results/${encodeURIComponent(attemptId)}/correct`,{verdict,reason:reason.input.value.trim()});location.assign(nextURL);};
  render(el('div',{class:'result-content'},el('div',{class:'result-status'},icon(symbol,'result-symbol'),el('h1',{class:'result-label'},verdicts[r.attempt.verdict])),
    el('div',{class:'result-answers'},answerBlock('あなたの回答',response),answerBlock(String(r.answerKind),r.correctAnswer)),
    r.explanation&&el('section',{class:'result-explanation'},el('h2',{},'解説'),formatText(r.explanation)),
    r.attempt.method!=='rule'&&evaluation.reason&&el('section',{class:'result-explanation'},el('h2',{},'参考評価'),formatText(evaluation.reason),evaluation.improvement&&formatText(evaluation.improvement)),
    needsReview&&el('section',{class:'result-explanation'},el('h2',{},'採点を確認'),canManage?el('div',{},reason.node,el('div',{class:'actions'},button('正解として確定',()=>correct('correct')),button('不正解として確定',()=>correct('incorrect'))),r.question.type==='論述式'&&button('AIで再採点',async()=>{await api(`/results/${encodeURIComponent(attemptId)}/regrade`,{});await resultPage();})):link('本人認証して採点を確認',`/auth/github?next=${encodeURIComponent(location.pathname+location.search)}`)),
    el('div',{class:'result-footer'},r.attempt.verdict==='pending'&&button('採点結果を更新',resultPage),link('次の問題へ',nextURL,true))));

}
type Practice=Awaited<ReturnType<typeof practiceResults>>;
const practiceStatus:Record<string,string>={generating:'生成中',draft:'採用待ち',ready:'利用可能',failed:'生成失敗'};
function practiceState(status:string,jobs:{kind:string;status:string|null;phase:string|null;last_error?:string|null}[]){
  const job=jobs.find(j=>j.kind==='generate');
  if(status==='generating'){
    if(job?.status==='deferred')return '生成保留';
    if(job?.status==='failed')return '生成失敗';
    if(job?.status==='pending'&&job.last_error)return '再試行待ち';
    if(job?.phase==='verifying')return '検証待ち';
  }
  return practiceStatus[status]??status;
}
async function practicePage(){
  clearTimeout(practiceRefresh);
  const setId=params.get('id');
  if(setId){
    const p=await api<Practice>(`/practice/${encodeURIComponent(setId)}`);
    if(p.set.status==='ready'){location.replace(`/exercise/?type=practice&id=${encodeURIComponent(setId)}`);return;}
    const job=p.jobs.find(j=>j.kind==='generate');
    const retry=p.set.status==='failed';
    render(link('問題集へ','/practice/'),el('h1',{},p.set.name),
      el('p',{role:'status'},practiceState(p.set.status,p.jobs)),
      el('p',{},`検証済み ${p.progress.verified} / ${p.progress.total}問`),
      p.set.status==='generating'&&el('p',{},'ChatGPTで残りの問題を作成'),
      !!job?.last_error&&el('p',{},String(job.last_error)),
      job?.status==='deferred'&&el('p',{},`再開予定 ${new Date(String(job.next_at)).toLocaleString('ja-JP')}`),
      button('状態を更新',practicePage),
      canManage&&retry&&button('作成待ちに戻す',async()=>{await api(`/practice/${encodeURIComponent(setId)}/retry`,{});await practicePage();}),
      ...p.items.map((item,i)=>el('section',{class:'practice-question'},el('h2',{},`問${i+1}`),formatText(item.question.text),
        ...item.question.choices.map(c=>formatText(c.text)),
        'correctAnswer' in item&&item.correctAnswer?formatText(`参考解答 ${item.correctAnswer}`):null,
        'explanation' in item&&item.explanation?formatText(String(item.explanation)):null,
        el('p',{},'検証済み'))),
      p.set.status==='draft'&&(canManage?button('内容を確認して採用',async()=>{await api(`/practice/${encodeURIComponent(setId)}/adopt`,{});await practicePage();},true):el('p',{},'ChatGPTで内容を確認して採用')),);
    if(p.set.status==='generating')practiceRefresh=setTimeout(()=>void practicePage().catch(e=>flash(e.message)),10000);
    return;
  }
  const sets=await api<{id:string;name:string;status:string;generated:number;total:number;phase:string|null;job_status:string|null}[]>('/practice');
  render(sets.length?el('ul',{class:'collection-list',role:'list'},...sets.map(s=>el('li',{},
    el('a',{class:'collection-item',...(s.status==='ready'?{'aria-label':s.name}:{}),href:s.status==='ready'?`/exercise/?type=practice&id=${encodeURIComponent(s.id)}`:`/practice/?id=${encodeURIComponent(s.id)}`},
      el('span',{},s.name,el('small',{class:'practice-state'},s.status==='ready'?'利用可能':`${practiceState(s.status,[{kind:'generate',status:s.job_status,phase:s.phase}])}　検証済み ${s.generated} / ${s.total}問`)),icon('chevron','collection-chevron'))))):el('div',{class:'practice-empty'},el('p',{},'問題集がありません')));
  if(sets.some(s=>s.status==='generating'))practiceRefresh=setTimeout(()=>void practicePage().catch(e=>flash(e.message)),10000);
}
async function main(){
  const session=await api<{userId:string;csrf:string;canManage?:boolean}>('/me');csrf=session.csrf;userId=session.userId;canManage=session.canManage===true;
  const routes:Record<string,()=>Promise<void>>={dashboard,exercise,result:resultPage,practice:practicePage};
  await (routes[page]??dashboard)();
}
void main().catch(error=>{document.querySelector('.loading')?.remove();flash(error instanceof Error?error.message:'読み込みに失敗しました。');});
