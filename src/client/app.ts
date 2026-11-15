import type { analytics, roundProgress, nextExercise, getResult, listQuestions, history, practiceResults } from '../server/service';

type Analysis=Awaited<ReturnType<typeof analytics>>;
type Progress=Awaited<ReturnType<typeof roundProgress>>;
type Exercise=Awaited<ReturnType<typeof nextExercise>>;
type Result=Awaited<ReturnType<typeof getResult>>;
type QuestionList=Awaited<ReturnType<typeof listQuestions>>;
type History=Awaited<ReturnType<typeof history>>;
type Practice=Awaited<ReturnType<typeof practiceResults>>;
type SafeQuestion=Result['question'];
type Child=Node|string|null|undefined|false;
const root=document.querySelector<HTMLElement>('#app')!;
const page=document.body.dataset.page!;
let csrf='',userId='';
const params=new URLSearchParams(location.search);
const verdicts:Record<string,string>={correct:'正解',incorrect:'不正解',pending:'採点待ち',needs_review:'要確認',unanswered:'未回答'};
const states:Record<string,string>={unseen:'未回答',insufficient:'評価不足',needs_review:'要確認',stable:'安定',review:'要復習',developing:'定着途中'};
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
const pct=(n:number|null|undefined)=>n===null||n===undefined?'—':`${Math.round(n*100)}%`;
const date=(s:string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(s));
const section=(title:string,...children:Child[])=>el('section',{class:'section'},el('h2',{},title),...children);
const stat=(label:string,value:string)=>el('div',{},el('span',{class:'stat-label'},label),el('strong',{class:'stat-number'},value));
function table(headers:string[],rows:Child[][]){return el('div',{class:'table-wrap'},el('table',{},el('thead',{},el('tr',{},...headers.map(h=>el('th',{scope:'col'},h)))),el('tbody',{},...rows.map(row=>el('tr',{},...row.map(v=>el('td',{},v)))))));}
function select(label:string,options:[string,string][],value='',onChange?:()=>unknown){
  const s=el('select',{'aria-label':label},...options.map(([v,t])=>el('option',{value:v,selected:v===value},t)));
  if(onChange)s.addEventListener('change',()=>{Promise.resolve(onChange()).catch(e=>flash(String(e)));});return {node:el('label',{},label,s),input:s};
}
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
function topicsView(a:Analysis){return el('div',{},...a.topics.slice(0,5).map(t=>el('div',{class:'row'},el('div',{},el('strong',{},t.tag),el('p',{class:'muted'},`${t.scored}回答　${t.confidence==='insufficient'?'評価不足':'観測済み'}`)),el('div',{},el('strong',{},pct(t.accuracy)),el('p',{class:'muted'},`不正解 ${t.incorrect}回`)))));}
async function dashboard(){
  const d=await api<{progress:Progress;analysis:Analysis;totals:{total:number;gradable:number};examDate:string}>('/dashboard');
  const p=d.progress,days=Math.max(0,Math.ceil((Date.parse('2027-01-21T00:00:00+09:00')-Date.now())/86400000));
  const title=p.current?.status==='cleared'?'全問クリア':p.current?`${p.current.number}周目`:'学習を始める';
  const resume=button(p.current?.status==='cleared'?'もう一度全問を解く':p.current?'学習を再開':'1周目を始める',async()=>{await api('/rounds/start',{restart:p.current?.status==='cleared'});location.assign('/exercise/');},true);
  if(!d.totals.total)resume.disabled=true;
  render(el('p',{class:'eyebrow'},`2027年1月21日　試験まで${days}日`),el('h1',{},title),el('div',{class:'stats'},stat('残り問題',String(p.current?p.counts.unanswered:d.totals.gradable)),stat('周回の正答率',pct(p.counts.correct+p.counts.incorrect?p.counts.correct/(p.counts.correct+p.counts.incorrect):null)),stat('累計回答',String(d.analysis.summary.answered))),el('div',{class:'actions'},resume,link('問題を見る','/questions/')),
    !d.totals.total&&el('p',{class:'message'},'設定から教材をインポートしてください。'),
    (p.counts.pending>0||p.counts.needs_review>0)&&el('div',{class:'message'},el('p',{},`採点待ち ${p.counts.pending}問　要確認 ${p.counts.needs_review}問`),link('回答を確認','/history/?unresolved=1')),
    d.analysis.topics.length>0&&section('復習する概念',topicsView(d.analysis)),section('成績',table(['初回正答率','累計正答率','採点対象'],[[pct(d.analysis.summary.firstAccuracy),pct(d.analysis.summary.accuracy),`${d.totals.gradable}問`]])));
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
    render(el('h1',{},progress?.current?.status==='cleared'?'全問クリア':progress&&(progress.counts.pending||progress.counts.needs_review)?'採点を確認':'回答が完了しました'),progress&&el('p',{},`採点待ち ${progress.counts.pending}問　要確認 ${progress.counts.needs_review}問`),el('div',{class:'actions'},link('履歴を見る','/history/',true),link('学習に戻る','/')));return;
  }
  const q=data.question;
  if(!q.gradable){render(el('h1',{},'振り返り'),questionBody(q),el('p',{class:'message'},'正答未確認のため採点対象外です。'),link('問題一覧へ','/questions/'));return;}
  const context=data.contextId!,key=`info1:${userId}:${data.contextType}:${context}:${q.id}`,draftKey=`${key}:draft`,pendingKey=`${key}:pending`;
  let response:string|string[]=data.draft?.response as string|string[]??(q.type==='選択式'?[]:''),elapsed=data.draft?.elapsedMs??0;
  const saved=localStorage.getItem(draftKey);if(saved){try{const local=JSON.parse(saved);if(local.versionId===q.versionId){response=local.response;elapsed=Math.max(elapsed,local.elapsedMs??0);}}catch{localStorage.removeItem(draftKey);}}
  let pending:{id:string;response:string|string[];durationMs:number}|null=null;
  try{pending=JSON.parse(localStorage.getItem(pendingKey)??'null');}catch{localStorage.removeItem(pendingKey);}
  if(pending)response=pending.response;
  const saveLabel=el('span',{class:'muted',role:'status'},''),inputArea=el('div',{}),controls:HTMLButtonElement[]=[];
  let textarea:HTMLInputElement|HTMLTextAreaElement|undefined,lastTick=performance.now(),timer:ReturnType<typeof setTimeout>|undefined,submitting=false;
  const tick=()=>{const t=performance.now();if(document.visibilityState==='visible'&&!submitting)elapsed+=Math.max(0,t-lastTick);lastTick=t;};
  const interval=setInterval(tick,1000);
  const localSave=()=>{tick();localStorage.setItem(draftKey,JSON.stringify({response,elapsedMs:Math.round(elapsed),versionId:q.versionId}));};
  const save=async()=>{localSave();try{await api('/draft',{contextType:data.contextType,contextId:context,questionId:q.id,versionId:q.versionId,response,elapsedMs:Math.round(elapsed)},'PUT');saveLabel.textContent='保存済み';}catch{saveLabel.textContent='端末に保存済み';}};
  const change=()=>{localSave();saveLabel.textContent='保存中';clearTimeout(timer);timer=setTimeout(()=>void save(),600);};
  if(q.type==='選択式'){
    const list=el('div',{class:'choice-list',role:'group','aria-label':'選択肢'});
    for(const choice of q.choices){const b=el('button',{type:'button',class:'choice','aria-pressed':Array.isArray(response)&&response.includes(choice.id)?'true':'false'},el('span',{class:'choice-indicator','aria-hidden':'true'}),el('span',{},choice.text));
      b.disabled=!!pending;b.addEventListener('click',()=>{response=[choice.id];for(const other of controls)other.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');change();});controls.push(b);append(list,b);}
    append(inputArea,list);
  }else{
    const field=textField(q.type==='論述式'?'回答':'回答を入力',typeof response==='string'?response:'',q.type==='論述式');textarea=field.input;textarea.disabled=!!pending;textarea.addEventListener('input',()=>{response=textarea!.value;change();});append(inputArea,field.node);
  }
  const submit=button(pending?'送信を再試行':'回答を確定',async()=>{
    if(submitting)return;if(Array.isArray(response)?!response.length:!response.trim())throw new Error('回答を入力してください。');
    tick();submitting=true;clearTimeout(timer);
    pending??={id:crypto.randomUUID(),response,durationMs:Math.round(elapsed)};
    localStorage.setItem(pendingKey,JSON.stringify(pending));
    controls.forEach(b=>b.disabled=true);if(textarea)textarea.disabled=true;
    submit.textContent='保存中';
    try{
      const result=await api<Result>('/answers',{...pending,contextType:data.contextType,contextId:context,questionId:q.id,versionId:q.versionId});
      localStorage.removeItem(draftKey);localStorage.removeItem(pendingKey);clearInterval(interval);
      const nextURL=data.contextType==='review'?'/questions/':data.contextType==='round'?'/exercise/':`/exercise/?type=practice&id=${encodeURIComponent(context)}`;
      location.assign(`/result/?id=${encodeURIComponent(result.attempt.id)}&next=${encodeURIComponent(nextURL)}`);
    }finally{submitting=false;submit.textContent='送信を再試行';}
  },true);
  const pause=button('一時中断',async()=>{await save();location.assign('/');});
  const onPageHide=()=>{if(!submitting)localSave();};window.addEventListener('pagehide',onPageHide);
  disposeExercise=()=>{clearInterval(interval);clearTimeout(timer);window.removeEventListener('pagehide',onPageHide);};
  render(el('div',{class:'exercise-meta'},el('span',{},`${q.origin==='ai'?'AI独自問題':q.sourceType}　${q.number}`),el('span',{},q.type)),el('p',{class:'eyebrow spaced'},q.unit),questionBody(q),inputArea,el('div',{class:'exercise-footer'},el('div',{class:'actions'},submit,pause),saveLabel),el('details',{},el('summary',{},'出典・回答履歴'),link('出典を開く',q.sourceUrl),el('p',{},link('この問題の履歴',`/history/?questionId=${encodeURIComponent(q.id)}`))));
}
async function resultPage(){
  const attemptId=params.get('id');if(!attemptId)throw new Error('回答を選択してください。');
  const r=await api<Result>(`/results/${encodeURIComponent(attemptId)}`),evaluation=r.attempt.evaluation_data as {reason:string;strengths:string[];missing:string[];improvement:string;model:string;promptVersion:string;gradedAt:string};
  const next=params.get('next'),nextURL=next?.startsWith('/')&&!next.startsWith('//')?next:'/exercise/';
  const manual=button('採点を修正',()=>{
    const reason=textField('修正理由'),choice=select('判定',[['correct','正解'],['incorrect','不正解']]);
    const dialog=el('dialog',{},el('h2',{},'採点を修正'),choice.node,reason.node,el('div',{class:'actions'},button('修正を保存',async()=>{await api(`/results/${attemptId}/correct`,{verdict:choice.input.value,reason:reason.input.value});dialog.close();dialog.remove();await resultPage();},true),button('閉じる',()=>{dialog.close();dialog.remove();})));
    append(document.body,dialog);dialog.showModal();
  },false,true);
  render(el('p',{class:'eyebrow'},r.question.number),el('h1',{class:'result-label'},verdicts[r.attempt.verdict]),el('p',{class:'muted'},`${r.question.type}　${Math.round(r.attempt.duration_ms/1000)}秒${r.attempt.score!==null?`　${r.attempt.score}点`:''}`),questionBody(r.question),section('あなたの回答',formatText(Array.isArray(r.attempt.response)?r.question.choices.filter(c=>(r.attempt.response as string[]).includes(c.id)).map(c=>c.text).join('\n'):String(r.attempt.response))),
    (r.attempt.verdict==='pending'||r.attempt.verdict==='needs_review')&&el('p',{class:'message'},r.attempt.verdict==='pending'?'採点待ちです。別の問題へ進めます。':'採点結果を確認してください。'),
    section(String(r.answerKind),formatText(r.correctAnswer)),section('解説',formatText(r.explanation)),
    r.attempt.method!=='rule'&&section('参考評価',formatText(evaluation.reason),evaluation.strengths?.length?el('div',{},el('h3',{},'理解できている点'),...evaluation.strengths.map(s=>el('p',{},s))):null,evaluation.missing?.length?el('div',{},el('h3',{},'確認する点'),...evaluation.missing.map(s=>el('p',{},s))):null,evaluation.improvement?el('div',{},el('h3',{},'改善例'),formatText(evaluation.improvement)):null),
    el('div',{class:'actions'},link('次の問題へ',nextURL,true),r.attempt.verdict==='pending'&&button('採点結果を更新',resultPage)),
    el('details',{},el('summary',{},'採点履歴・出典'),table(['日時','判定','方法'],r.evaluations.map(e=>[date(String(e.created_at)),verdicts[String(e.verdict)],String(e.method)])),el('p',{class:'muted'},`${evaluation.model}　${evaluation.promptVersion}`),el('div',{class:'actions'},manual,r.question.type==='論述式'&&button('AIで再評価',async()=>{await api(`/results/${attemptId}/regrade`,{});await resultPage();},false,true)),link('出典を開く',r.question.sourceUrl)));
}
async function questionsPage(){
  const initial=await api<QuestionList>('/questions?limit=100'),more=initial.nextCursor?await api<QuestionList>(`/questions?limit=100&cursor=${initial.nextCursor}`):null;
  const all=[...initial.items,...(more?.items??[])],units=[...new Set(all.map(q=>q.unit))],tags=[...new Set(all.flatMap(q=>q.tags))].sort();
  const unit=select('単元',[['','すべて'],...units.map((u):[string,string]=>[u,u])]),type=select('形式',[['','すべて'],['選択式','選択式'],['記述式','記述式'],['論述式','論述式']]),state=select('学習状況',[['','すべて'],...Object.entries(states)]),tag=select('概念',[['','すべて'],...tags.map((t):[string,string]=>[t,t])]),origin=select('教材',[['school','学校教材'],['ai','AI独自問題']]);
  const list=el('div',{}),count=el('p',{class:'muted'});
  const update=()=>{const qs=all.filter(q=>(!unit.input.value||q.unit===unit.input.value)&&(!type.input.value||q.type===type.input.value)&&(!state.input.value||(q.mastery?.state??'unseen')===state.input.value)&&(!tag.input.value||q.tags.includes(tag.input.value))&&q.origin===origin.input.value);count.textContent=`${qs.length}問`;list.replaceChildren(...qs.map(q=>el('article',{class:'question-summary'},el('div',{class:'spread'},el('span',{class:'status'},`${q.type}　${states[q.mastery?.state??'unseen']}`),el('span',{class:'muted'},q.number)),el('h2',{},q.text),el('div',{},...q.tags.map(t=>el('span',{class:'tag'},t))),el('div',{class:'actions'},link(q.gradable?'復習する':'振り返りを見る',`/exercise/?type=review&question=${encodeURIComponent(q.id)}`),link('履歴',`/history/?questionId=${encodeURIComponent(q.id)}`)))));};
  for(const s of [unit,type,state,tag,origin])s.input.addEventListener('change',update);
  render(el('h1',{},'問題'),el('div',{class:'filters'},unit.node,type.node,state.node,tag.node,origin.node),count,list);update();
}
async function historyPage(){
  const state=select('判定',[['','すべて'],...Object.entries(verdicts).filter(([k])=>k!=='unanswered')],params.get('unresolved')?'needs_review':'');
  const container=el('div',{});let cursor:string|undefined;
  const load=async(isAppend=false)=>{const query=new URLSearchParams({limit:'30'});if(params.get('questionId'))query.set('questionId',params.get('questionId')!);if(state.input.value)query.set('verdict',state.input.value);if(isAppend&&cursor)query.set('cursor',cursor);const data=await api<History>(`/history?${query}`);const rows=data.items.map(a=>[link(date(a.created_at),`/result/?id=${a.id}`),String((a as unknown as {unit:string}).unit),verdicts[a.verdict],`${Math.round(a.duration_ms/1000)}秒`]);const t=table(['日時','単元','判定','時間'],rows);if(!isAppend)container.replaceChildren();container.querySelector('.load-more')?.remove();append(container,t);cursor=data.nextCursor??undefined;if(cursor){const b=button('続きを表示',()=>load(true));b.classList.add('load-more');append(container,b);}};
  state.input.addEventListener('change',()=>void load().catch(e=>flash(e.message)));render(el('h1',{},'回答履歴'),state.node,container);await load();
}
async function analyticsPage(){
  const a=await api<Analysis>('/analytics'),p=await api<Progress>('/rounds');
  const units=table(['単元','正答率','回答数','平均時間'],a.units.map(u=>[u.unit,pct(u.accuracy),String(u.scored),`${Math.round(u.averageDurationMs/1000)}秒`]));
  const concepts=table(['概念','正答率','回答数','判定材料'],a.topics.map(t=>[t.tag,pct(t.accuracy),String(t.scored),t.confidence==='insufficient'?'評価不足':`${t.incorrect}回の誤答`]));
  const trend=el('div',{},...a.days.slice(-14).map(d=>el('div',{class:'spaced'},el('div',{class:'spread'},el('span',{},d.day),el('span',{},`${d.answered}回答　${pct(d.accuracy)}`)),el('div',{class:'bar-track','aria-label':`${d.day}の正答率 ${pct(d.accuracy)}`},el('div',{class:'bar-fill',style:`width:${Math.round((d.accuracy??0)*100)}%`})))));
  render(el('h1',{},'学習分析'),el('div',{class:'stats'},stat('初回正答率',pct(a.summary.firstAccuracy)),stat('累計正答率',pct(a.summary.accuracy)),stat('累計回答',String(a.summary.answered))),section('単元',units),section('概念',concepts),section('周回',table(['周回','状態','正答率'],p.rounds.map(r=>{const s=a.rounds.find(s=>s.roundId===r.id);return [link(`${r.cycle}巡 ${r.number}周目`,`/history/`),r.status==='active'?'進行中':r.status==='cleared'?'全問クリア':'完了',pct(s?.accuracy)];}))),section('学習量と正答率',trend),section('理解度の推移',table(['日付','評価不足','要確認','要復習','定着途中','安定'],a.masteryTimeline.slice(-14).map(d=>[d.day,String(d.insufficient),String(d.needs_review),String(d.review),String(d.developing),String(d.stable)]))),section('問題の理解度',table(['問題','状態','連続正解','平均時間','最終回答'],a.questions.sort((x,y)=>y.priority-x.priority).slice(0,30).map(q=>[link(q.questionId,`/history/?questionId=${encodeURIComponent(q.questionId)}`),states[q.state],String(q.streak),`${Math.round(q.averageDurationMs/1000)}秒`,date(q.lastAnsweredAt)]))));
}
async function practicePage(){
  const setId=params.get('id');
  if(setId){
    const r=await api<Practice>(`/practice/${setId}`),s=r.set as Practice['set']&{name:string;mode:string};
    const details=el('div',{},...r.items.map(i=>el('article',{class:'question-summary'},questionBody(i.question),i.correctAnswer?el('div',{},el('h3',{},'参考解答'),formatText(String(i.correctAnswer)),el('h3',{},'解説'),formatText(String(i.explanation))):null,el('p',{class:'muted'},i.attempt_id?verdicts[i.verdict]:s.status==='draft'?'検証済み・採用前':'未回答'),s.status==='draft'?button('この問題を除外',async()=>{await api(`/practice/${setId}/items/${encodeURIComponent(i.question_id)}`,{},'DELETE');await practicePage();},false,true):null)));
    render(el('p',{class:'eyebrow'},'AI問題集・復習'),el('h1',{},s.name),el('p',{},`${r.items.length}問　${s.status==='ready'?'演習できます':s.status==='generating'?'生成・検証中':s.status==='failed'?'生成を確認してください':'問題と参考解答を確認'}`),...r.jobs.filter(j=>j.last_error).map(j=>el('p',{class:'message'},String(j.last_error))),el('div',{class:'actions'},s.status==='ready'?link('演習を始める',`/exercise/?type=practice&id=${setId}`,true):s.status==='draft'?button('確認した問題を採用',async()=>{await api(`/practice/${setId}/adopt`,{});await practicePage();},true):s.status==='failed'?button('再生成',async()=>{await api(`/practice/${setId}/retry`,{});await practicePage();},true):button('状態を更新',practicePage),link('問題集へ戻る','/practice/')),details);return;
  }
  const sets=await api<{id:string;name:string;status:string;created_at:string;origin:string}[]>('/practice');
  const mode=select('モード',[['weakness','苦手克服'],['application','応用'],['comprehensive','総合'],['mock','模擬試験']]),origin=select('問題',[['ai','AI独自問題'],['school','学校教材から選ぶ']]),name=textField('問題集名'),count=select('問題数',[['10','10問'],['20','20問'],['5','5問']]),tags=textField('概念（任意・読点で区切る）');
  mode.input.addEventListener('change',()=>{if(mode.input.value==='mock')count.input.value='20';});
  const create=button('問題集を作る',async()=>{const r=await api<{id:string}>('/practice',{name:name.input.value.trim()||mode.input.selectedOptions[0].text,mode:mode.input.value,origin:origin.input.value,count:Number(count.input.value),tags:tags.input.value.split(/[、,]/u).map(s=>s.trim()).filter(Boolean)});location.assign(`/practice/?id=${r.id}`);},true);
  render(el('h1',{},'問題集'),el('div',{class:'filters'},mode.node,origin.node,count.node),name.node,tags.node,el('div',{class:'actions'},create),section('保存した問題集',el('div',{},...sets.map(s=>el('div',{class:'row'},el('div',{},link(s.name,`/practice/?id=${s.id}`),el('p',{class:'muted'},`${s.origin==='ai'?'AI独自問題':'学校教材'}　${date(s.created_at)}`)),el('span',{class:'status'},s.status==='ready'?'演習可':s.status==='draft'?'確認待ち':s.status==='generating'?'生成中':'要確認'))))));
}
async function importFiles(files:FileList){
  const all=Array.from(files),jsonFile=all.find(f=>f.name==='questions.json');if(!jsonFile)throw new Error('questions.jsonを含むフォルダを選択してください。');
  const raw:unknown=JSON.parse(await jsonFile.text());if(!Array.isArray(raw)||!raw.length)throw new Error('問題データの配列を選択してください。');
  const expectedImages=new Set(raw.flatMap(q=>Array.isArray(q.image_paths)?q.image_paths:[]));
  const missing=[...expectedImages].filter(path=>!all.some(f=>f.webkitRelativePath.endsWith('/'+String(path))));
  if(missing.length)throw new Error('不足画像: '+missing.join(', '));
  const progress=el('p',{class:'message',role:'status'},'インポート中');append(root,progress);
  for(const path of expectedImages){const file=all.find(f=>f.webkitRelativePath.endsWith('/'+String(path)))!;const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);await api('/import/image',{path,base64:btoa(binary),mime:'image/png'});}
  for(let i=0;i<raw.length;i++){await api(`/import/question?position=${i}`,raw[i]);progress.textContent=`問題 ${i+1} / ${raw.length}問`;}
  await api('/import/finish',{total:raw.length,gradable:raw.filter(q=>q.answer_verified).length,images:expectedImages.size});await settingsPage();
}
async function settingsPage(){
  const s=await api<{counts:{total:number;gradable:number};usage:{reserved_neurons:number;calls:number}|null;jobs:{id:string;status:string;last_error:string|null}[];aiModel:string;dailyNeurons:number;mcpURL:string;scopes:string[]}>('/settings');
  const importer=el('input',{type:'file',webkitdirectory:true,multiple:true,'aria-label':'教材フォルダ'});importer.addEventListener('change',()=>{if(importer.files?.length)void importFiles(importer.files).catch(e=>flash(e.message));});
  const restore=el('input',{type:'file',accept:'.json','aria-label':'バックアップファイル'});restore.addEventListener('change',()=>{const file=restore.files?.[0];if(!file)return;const dialog=el('dialog',{},el('h2',{},'バックアップを復元'),el('p',{},'履歴が空のデータベースにだけ復元できます。'),el('div',{class:'actions'},button('復元する',async()=>{await api('/restore',JSON.parse(await file.text()));dialog.close();dialog.remove();flash('復元しました。');},true),button('閉じる',()=>{dialog.close();dialog.remove();})));append(document.body,dialog);dialog.showModal();});
  render(el('h1',{},'設定'),section('教材',el('p',{},`${s.counts.total}問　採点対象${s.counts.gradable??0}問`),el('label',{},'教材フォルダを取り込む',importer)),section('AI',el('p',{class:'muted'},s.aiModel),el('p',{},`無料枠の目安 ${s.usage?.reserved_neurons??0} / ${s.dailyNeurons} Neurons`),el('p',{class:'muted'},'毎日9時に目安をリセット。学校の正式な採点ではありません。'),...s.jobs.map(j=>el('p',{class:'message'},j.last_error??(j.status==='running'?'処理中':'待機中'))),el('div',{class:'actions'},button('保留中の処理を確認',async()=>{await api('/jobs/run',{});await settingsPage();}))),section('MCP接続',el('p',{class:'prose'},s.mcpURL),el('p',{class:'muted'},'接続時に閲覧・正答確認・問題集作成の権限を選択します。')),section('バックアップ',el('div',{class:'actions'},link('バックアップを保存','/api/backup',true)),el('label',{},'バックアップを復元',restore)),section('アカウント',button('ログアウト',async()=>{await api('/logout',{});location.assign('/login/');})));
}
async function login(){
  render(el('p',{class:'eyebrow'},'個人学習'),el('h1',{},'情報Ⅰ'),el('div',{class:'actions'},link('GitHubでログイン','/auth/github',true)),location.hostname==='127.0.0.1'&&params.get('demo')==='1'?button('テスト用データで開く',async()=>{const r=await fetch('/auth/test',{method:'POST'});if(!r.ok)throw new Error('テストモードで起動してください。');location.assign('/');}):null);
}
async function main(){
  if(page==='login'){await login();return;}
  const session=await api<{userId:string;csrf:string}>('/me');csrf=session.csrf;userId=session.userId;
  const routes:Record<string,()=>Promise<void>>={dashboard,exercise,result:resultPage,questions:questionsPage,history:historyPage,analytics:analyticsPage,practice:practicePage,settings:settingsPage};
  await (routes[page]??dashboard)();
}
void main().catch(error=>{document.querySelector('.loading')?.remove();flash(error instanceof Error?error.message:'読み込みに失敗しました。');});
