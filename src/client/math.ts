import renderMathInElement from 'katex/contrib/auto-render';

// Construct text nodes first; only KaTeX creates markup, with trusted commands disabled.
export function formatText(text:string){
  const node=document.createElement('div');node.className='prose';node.textContent=text;
  renderMathInElement(node,{
    delimiters:[
      {left:'$$',right:'$$',display:true},
      {left:'\\[',right:'\\]',display:true},
      {left:'\\(',right:'\\)',display:false},
      {left:'$',right:'$',display:false},
    ],
    trust:false,throwOnError:false,errorColor:'#252525',strict:'ignore',maxExpand:100,maxSize:20,
    macros:{},
  });
  // Preserve the older, delimiter-free superscript notation in imported material.
  const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);const plain:Text[]=[];
  while(walker.nextNode()){
    const t=walker.currentNode as Text;
    if(!t.parentElement?.closest('.katex,pre,code')&&/\^\{[^{}]+\}|\\times/u.test(t.data))plain.push(t);
  }
  for(const t of plain){
    const fragment=document.createDocumentFragment();
    for(const part of t.data.replace(/\\times/gu,'×').split(/(\^\{[^{}]+\})/gu)){
      const match=part.match(/^\^\{([^{}]+)\}$/u);
      if(match){const sup=document.createElement('sup');sup.textContent=match[1];fragment.append(sup);}else fragment.append(part);
    }
    t.replaceWith(fragment);
  }
  return node;
}
