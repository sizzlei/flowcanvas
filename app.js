/*
 * FlowCanvas — 애플리케이션 로직 (의존성 없는 순수 JS)
 *
 * 전체 구조 (아래 순서대로 정의됨):
 *   1. view          : viewBox 기반 팬/줌, 화면 맞춤(fitView)
 *   2. 상태          : nodes[], edges[], 선택(selNodes/selEdge)
 *   3. shape geometry: 도형 크기 계산, 텍스트 줄바꿈, 노드/엣지 렌더링
 *   4. selection     : 다중 노드 + 단일 엣지 선택
 *   5. interactions  : 노드 드래그(그룹 이동), 핸들 드래그 연결, 마퀴 선택
 *   6. CRUD          : addNode/addEdge/deleteSelected/applyColor
 *   7. 자동 엣지 분리 : 같은 노드쌍의 형제/양방향 엣지를 벌려서 그림
 *   8. animation     : 흐름선 comet 펄스 재생(order 순서 + 반복)
 *   9. tags          : 흐름선 태그별 표시/숨김 필터
 *  10. PNG export    : 현재 화면을 PNG로 내보내기
 *  11. serialize     : 다이어그램 직렬화 + 저장/불러오기 (앱 고유 JSON)
 *  12. history       : 실행취소/다시실행 + localStorage 자동저장
 *  13. shortcuts     : 설정 가능한 단축키(설정은 JSON으로 영속화)
 *  14. startup       : 저장본 복원 또는 예시 시드
 *
 * 저장 키: flowcanvas.diagram(작업본), flowcanvas.settings(단축키)
 */
(function(){
  "use strict";

  // ---------- YAML (compact, self-contained — the app stays dependency-free) ----------
  // Emits a readable YAML subset for our data and parses it back. Legacy JSON auto-detected on load.
  const Y=(function(){
    const IND="  ";
    function needQuote(s){
      if(s==="")return true;
      if(/^\s|\s$/.test(s))return true;                         // leading/trailing space
      if(/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(s))return true; // ambiguous with non-string
      if(/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s))return true;        // starts with an indicator
      if(s.indexOf(":")>=0||s.indexOf(" #")>=0||/[\n\t]/.test(s))return true;
      return false;
    }
    function qstr(s){return '"'+s.replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n").replace(/\t/g,"\\t")+'"';}
    function scalar(v){
      if(v===null||v===undefined)return "null";
      if(typeof v==="boolean")return v?"true":"false";
      if(typeof v==="number")return String(v);
      const s=String(v);return needQuote(s)?qstr(s):s;
    }
    const isMap=v=>v&&typeof v==="object"&&!Array.isArray(v);
    function dumpMap(o,ind){
      const pad=IND.repeat(ind),keys=Object.keys(o);
      if(!keys.length)return pad+"{}\n";
      let out="";
      for(const k of keys){const v=o[k];
        if(Array.isArray(v))out+= v.length? pad+k+":\n"+dumpSeq(v,ind+1) : pad+k+": []\n";
        else if(isMap(v))out+= Object.keys(v).length? pad+k+":\n"+dumpMap(v,ind+1) : pad+k+": {}\n";
        else out+=pad+k+": "+scalar(v)+"\n";}
      return out;
    }
    function dumpSeq(a,ind){
      const pad=IND.repeat(ind);let out="";
      for(const v of a){
        if(Array.isArray(v))out+= v.length? pad+"-\n"+dumpSeq(v,ind+1) : pad+"- []\n";
        else if(isMap(v))out+= Object.keys(v).length? pad+"-\n"+dumpMap(v,ind+1) : pad+"- {}\n";
        else out+=pad+"- "+scalar(v)+"\n";}
      return out;
    }
    function unq(s){return s.slice(1,-1).replace(/\\(["\\nt])/g,(m,c)=>c==="n"?"\n":c==="t"?"\t":c);}
    function scal(s){
      s=s.trim();
      if(s.length>=2&&s[0]==='"'&&s[s.length-1]==='"')return unq(s);
      if(s==="true")return true;if(s==="false")return false;if(s==="null"||s==="~")return null;
      if(/^-?\d+$/.test(s))return parseInt(s,10);
      if(/^-?\d*\.\d+$/.test(s))return parseFloat(s);
      return s;
    }
    function load(text){
      if(text==null)return null;
      const t=String(text).trim();if(!t)return null;
      if(t[0]==="{"||t[0]==="[")return JSON.parse(t);           // legacy JSON support
      const lines=String(text).replace(/\r/g,"").split("\n").filter(l=>l.trim().length&&!/^\s*#/.test(l));
      if(!lines.length)return null;
      let i=0;const lead=l=>l.match(/^ */)[0].length;
      function block(ind){const c=lines[i].slice(lead(lines[i]));
        return (c==="-"||c.slice(0,2)==="- ")?seq(ind):map(ind);}
      function map(ind){const o={};
        while(i<lines.length){const ln=lines[i],d=lead(ln);if(d!==ind)break;
          const c=ln.slice(d);if(c==="-"||c.slice(0,2)==="- ")break;
          const p=c.indexOf(":"),key=c.slice(0,p).trim(),rest=c.slice(p+1).trim();i++;
          if(rest==="")o[key]=(i<lines.length&&lead(lines[i])>ind)?block(lead(lines[i])):null;
          else if(rest==="[]")o[key]=[];else if(rest==="{}")o[key]={};else o[key]=scal(rest);}
        return o;}
      function seq(ind){const a=[];
        while(i<lines.length){const ln=lines[i],d=lead(ln);if(d!==ind)break;
          const c=ln.slice(d);if(!(c==="-"||c.slice(0,2)==="- "))break;
          const rest=c==="-"?"":c.slice(2).trim();i++;
          if(rest==="")a.push((i<lines.length&&lead(lines[i])>ind)?block(lead(lines[i])):null);
          else if(rest==="[]")a.push([]);else if(rest==="{}")a.push({});else a.push(scal(rest));}
        return a;}
      return block(lead(lines[0]));
    }
    function dump(o){return isMap(o)?dumpMap(o,0):Array.isArray(o)?dumpSeq(o,0):scalar(o)+"\n";}
    return {dump,load};
  })();

  const SVGNS="http://www.w3.org/2000/svg";
  const svg=document.getElementById("svg");
  const gNodes=document.getElementById("nodes");
  const gEdges=document.getElementById("edges");
  const tempEdge=document.getElementById("tempEdge");
  const emptyHint=document.getElementById("emptyHint");
  const canvasWrap=document.getElementById("canvasWrap");

  // ---------- view (pan / zoom via viewBox) ----------
  const view={x:0,y:0,w:1000,h:700};
  function applyView(){svg.setAttribute("viewBox",`${view.x} ${view.y} ${view.w} ${view.h}`);updateZoomLabel();}
  function updateZoomLabel(){const r=svg.getBoundingClientRect();
    const z=r.width?Math.round(r.width/view.w*100):100;
    const el=document.getElementById("zoomLevel");if(el)el.textContent=z+"%";}
  function zoomBy(factor){                     // zoom around the viewport center
    const cx=view.x+view.w/2,cy=view.y+view.h/2;
    const nw=Math.min(6000,Math.max(120,view.w*factor)),sc=nw/view.w;
    view.w=nw;view.h*=sc;view.x=cx-view.w/2;view.y=cy-view.h/2;applyView();
  }
  function resetZoom(){                        // back to 100% (1px : 1unit), keep center
    const r=svg.getBoundingClientRect();
    const cx=view.x+view.w/2,cy=view.y+view.h/2;
    view.w=r.width||1000;view.h=r.height||700;view.x=cx-view.w/2;view.y=cy-view.h/2;applyView();
  }
  function homeView(){                          // default view: 100% zoom, centered on content
    const r=svg.getBoundingClientRect();
    view.w=r.width||1000;view.h=r.height||700;
    if(nodes.length){
      let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
      nodes.forEach(n=>{minX=Math.min(minX,n.x-n.w/2);maxX=Math.max(maxX,n.x+n.w/2);
        minY=Math.min(minY,n.y-n.h/2);maxY=Math.max(maxY,n.y+n.h/2);});
      view.x=(minX+maxX)/2-view.w/2;view.y=(minY+maxY)/2-view.h/2;
    }else{view.x=0;view.y=0;}
    applyView();
  }
  function initView(){const r=svg.getBoundingClientRect();
    view.w=r.width||1000;view.h=r.height||700;view.x=0;view.y=0;applyView();}
  // bounding box of all content (nodes + subgraph boxes, which extend above nodes for the title)
  function contentBounds(){
    let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    nodes.forEach(n=>{minX=Math.min(minX,n.x-n.w/2);maxX=Math.max(maxX,n.x+n.w/2);
      minY=Math.min(minY,n.y-n.h/2);maxY=Math.max(maxY,n.y+n.h/2);});
    (typeof subgraphs!=="undefined"?subgraphs:[]).forEach(sg=>{
      if(!sg.rectEl||![...sg.nodes].some(id=>nodes.some(n=>n.id===id)))return;
      const x=+sg.rectEl.getAttribute("x"),y=+sg.rectEl.getAttribute("y"),
        w=+sg.rectEl.getAttribute("width"),h=+sg.rectEl.getAttribute("height");
      minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x+w);maxY=Math.max(maxY,y+h);
    });
    return {minX,minY,maxX,maxY};
  }
  function fitView(){
    if(!nodes.length){initView();return;}
    let {minX,minY,maxX,maxY}=contentBounds();
    const pad=70;minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;
    const bw=maxX-minX,bh=maxY-minY;
    const r=svg.getBoundingClientRect();const aspect=(r.width/r.height)||1.43;
    let w=bw,h=bh;
    if(w/h>aspect)h=w/aspect;else w=h*aspect;
    view.w=w;view.h=h;view.x=minX-(w-bw)/2;view.y=minY-(h-bh)/2;applyView();
  }
  let spaceDown=false, panning=null;

  const DEFAULT_FILL="#2f2748", DEFAULT_STROKE="#8b5cf6", DEFAULT_EDGE="#9c8fce";
  let nodes=[]; // {id,label,shape,x,y,w,h,fill,stroke,bstyle,el,shapeEl,textEl,handles[],decor[]}
  let edges=[]; // {id,from,to,label,line,head,order,tags,el,pathEl,hitEl,textEl,bgEl}
  let subgraphs=[]; // {id,title,nodes:Set,el,rectEl,titleEl}
  let nid=0, eid=0, gid=0;
  let connecting=null; // {source, }
  let edgeCurve=false;
  let bgColor="#0d0b13"; // canvas background color
  let animColor="#e879f9"; // flow-animation (pulse) color, shared by all edges
  let edgeDefaults={line:"solid",head:"arrow"}; // style applied to new edges
  const NODE_W=120, NODE_H=54;
  // layer for subgraph boxes, drawn behind edges/nodes
  const gGroups=document.createElementNS(SVGNS,"g");gGroups.setAttribute("id","groups");
  svg.insertBefore(gGroups,gEdges);

  function toast(m){const t=document.getElementById("toast");t.textContent=m;
    t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),1700);}

  // ---------- dialog (custom layer, replaces native alert/prompt/confirm) ----------
  const dialogEl=document.getElementById("dialog");
  const dialogMsg=document.getElementById("dialogMsg");
  const dialogInput=document.getElementById("dialogInput");
  const dialogOk=document.getElementById("dialogOk");
  let dialogCb=null;
  function openDialog(o){
    dialogMsg.textContent=o.message||"";
    const useInput=!!o.input;
    dialogInput.style.display=useInput?"":"none";
    if(useInput)dialogInput.value=o.value||"";
    dialogOk.textContent=o.okText||"확인";
    dialogCb=o.onOk||null;dialogEl._input=useInput;
    dialogEl.style.display="flex";
    if(useInput)setTimeout(()=>{dialogInput.focus();dialogInput.select();},0);
  }
  function closeDialog(ok){
    const cb=dialogCb,useInput=dialogEl._input,val=dialogInput.value;
    dialogCb=null;dialogEl.style.display="none";
    if(ok&&cb)cb(useInput?val:true);
  }
  function askText(message,defVal,onOk){openDialog({message,input:true,value:defVal,onOk});}
  function askConfirm(message,onOk){openDialog({message,input:false,onOk});}
  dialogOk.addEventListener("click",()=>closeDialog(true));
  document.getElementById("dialogCancel").addEventListener("click",()=>closeDialog(false));
  dialogEl.addEventListener("click",e=>{if(e.target.id==="dialog")closeDialog(false);});
  dialogInput.addEventListener("keydown",e=>{e.stopPropagation();
    if(e.key==="Enter"){e.preventDefault();closeDialog(true);}
    else if(e.key==="Escape"){e.preventDefault();closeDialog(false);}});

  // ---------- right-click context menu ----------
  const ctx=document.getElementById("ctxmenu");
  const FILL_SWATCHES=["#2f2748","#3b6db5","#2f8f6b","#b58a2f","#a8476a","#6b4ea8"];
  function closeCtx(){ctx.style.display="none";ctx.innerHTML="";}
  function ctxItem(it){
    if(it.sep){const d=document.createElement("div");d.className="sepline";return d;}
    if(it.swatches){                                    // inline color swatch row
      const row=document.createElement("div");row.className="cm-swatches";
      it.swatches.forEach(c=>{const b=document.createElement("button");b.className="swatch";
        b.style.background=c;b.title=c;
        b.addEventListener("click",e=>{e.stopPropagation();closeCtx();it.onPick(c);});row.appendChild(b);});
      return row;
    }
    const el=document.createElement("div");
    el.className="item"+(it.danger?" danger":"")+(it.sub?" has-sub":"");
    const lab=document.createElement("span");lab.textContent=it.label;el.appendChild(lab);
    if(it.sub){const a=document.createElement("span");a.className="arrow";a.textContent="▸";el.appendChild(a);
      const sub=document.createElement("div");sub.className="sub";
      it.sub.forEach(s=>sub.appendChild(ctxItem(s)));el.appendChild(sub);
    }else{el.addEventListener("click",e=>{e.stopPropagation();closeCtx();it.action&&it.action();});}
    return el;
  }
  function openCtx(x,y,items){
    ctx.innerHTML="";items.forEach(it=>ctx.appendChild(ctxItem(it)));
    ctx.style.display="block";ctx.style.left="0px";ctx.style.top="0px";
    const r=ctx.getBoundingClientRect();
    ctx.style.left=Math.max(4,Math.min(x,window.innerWidth-r.width-8))+"px";
    ctx.style.top=Math.max(4,Math.min(y,window.innerHeight-r.height-8))+"px";
  }
  window.addEventListener("mousedown",e=>{if(ctx.style.display==="block"&&!ctx.contains(e.target))closeCtx();});
  window.addEventListener("keydown",e=>{if(e.key==="Escape"&&ctx.style.display==="block")closeCtx();});
  window.addEventListener("scroll",closeCtx,true);
  // build + open the context menu at (cx,cy) for the given target element
  function showContextMenu(cx,cy,targetEl){
    closeCtx();
    const node=nodeUnder({clientX:cx,clientY:cy});
    const edgeEl=targetEl&&targetEl.closest&&targetEl.closest(".edge");
    const groupEl=targetEl&&targetEl.closest&&targetEl.closest(".subgraph");
    let items;
    if(node){
      if(!selNodes.has(node.id))selectNode(node);
      items=[
        {label:"이름 변경",action:()=>{if(selNodes.size===1){const n=nodes.find(x=>selNodes.has(x.id));
          openInline(cx,cy,n.label,v=>{n.label=v.trim()||n.label;refreshNode(n);sync();});}
          else toast("단일 노드를 선택하세요");}},
        {label:"채움 색",swatches:FILL_SWATCHES,onPick:applyColor},
        {label:"채움 색 직접…",action:()=>document.getElementById("colorPick").click()},
        {label:"테두리 색 직접…",action:()=>document.getElementById("strokePick").click()},
        {label:"테두리 스타일",sub:[
          {label:"─ 실선",action:()=>applyBstyle("solid")},
          {label:"┈ 점선",action:()=>applyBstyle("dashed")},
          {label:"━ 굵게",action:()=>applyBstyle("thick")}]},
        {label:"그룹으로 묶기",action:makeGroup},
        {sep:true},
        {label:"삭제",danger:true,action:deleteSelected}];
    }else if(edgeEl){
      const e=edges.find(x=>x.id===+edgeEl.dataset.id);if(e)selectEdge(e);
      items=[
        {label:"라벨 편집",action:()=>{if(e)openInline(cx,cy,e.label,
          v=>{e.label=v.trim();drawEdge(e);sync();});}},
        {label:"선 스타일",sub:[
          {label:"─ 실선",action:()=>applyEdgeStyle("line","solid")},
          {label:"┈ 점선",action:()=>applyEdgeStyle("line","dotted")},
          {label:"━ 굵게",action:()=>applyEdgeStyle("line","thick")}]},
        {label:"끝 모양",sub:[
          {label:"→ 화살표",action:()=>applyEdgeStyle("head","arrow")},
          {label:"— 없음",action:()=>applyEdgeStyle("head","open")},
          {label:"○ 원",action:()=>applyEdgeStyle("head","circle")},
          {label:"✕ X",action:()=>applyEdgeStyle("head","cross")},
          {label:"↔ 양방향",action:()=>applyEdgeStyle("head","bi")}]},
        {label:"애니메이션 순서…",action:()=>{if(e)askText("애니메이션 순서 (숫자, 작을수록 먼저 · 같은 숫자는 동시)",String(e.order||1),
          v=>{const num=parseInt(v,10);e.order=isNaN(num)?1:num;edges.forEach(drawEdge);sync();});}},
        {label:"태그 지정…",action:()=>{if(e)askText("태그 (쉼표로 구분)",(e.tags||[]).join(", "),
          v=>{e.tags=String(v||"").split(",").map(s=>s.trim()).filter(Boolean);sync();applyTagFilter();});}},
        {sep:true},
        {label:"삭제",danger:true,action:deleteSelected}];
    }else if(groupEl){
      const sg=subgraphs.find(x=>x.el===groupEl);
      if(sg){clearSel();[...sg.nodes].forEach(id=>{const n=nodes.find(y=>y.id===id);
        if(n){selNodes.add(id);n.el.classList.add("sel");}});}
      items=[
        {label:"이름 변경",action:()=>sg&&renameGroupSg(sg,cx,cy)},
        {label:"그룹 색",swatches:["#8b5cf6"].concat(FILL_SWATCHES),onPick:applyGroupColor},
        {label:"그룹 색 직접…",action:()=>document.getElementById("groupColorPick").click()},
        {sep:true},
        {label:"그룹 해제",action:ungroup}];
    }else{
      const p=cursorPt({clientX:cx,clientY:cy});
      const shapes=[["둥근 사각형","round"],["사각형","rect"],["스타디움","stadium"],["마름모","diamond"],
        ["원","circle"],["육각형","hexagon"],["원통(DB)","cylinder"],["서브루틴","subroutine"]];
      items=[
        {label:"노드 추가",sub:shapes.map(s=>({label:s[0],action:()=>{const n=addNode(s[1],p.x,p.y);selectNode(n);}}))},
        {label:"아이콘 패널 열기/닫기",action:toggleIconPanel},
        {label:"화면 맞춤",action:fitView},
        {label:"배경 다크/라이트",action:toggleBg}];
    }
    openCtx(cx,cy,items);
  }
  canvasWrap.addEventListener("contextmenu",ev=>{ev.preventDefault();showContextMenu(ev.clientX,ev.clientY,ev.target);});

  // ---------- shape geometry ----------
  function makeShapeEl(shape){
    if(shape==="diamond"||shape==="hexagon")return document.createElementNS(SVGNS,"polygon");
    if(shape==="circle")return document.createElementNS(SVGNS,"ellipse");
    if(shape==="cylinder")return document.createElementNS(SVGNS,"path");
    return document.createElementNS(SVGNS,"rect");
  }
  // border color/style are stored on the node and applied as attributes
  function applyStrokeAttrs(el,n){
    el.setAttribute("stroke",n.stroke||DEFAULT_STROKE);
    el.setAttribute("stroke-width",n.bstyle==="thick"?4:2);
    if(n.bstyle==="dashed")el.setAttribute("stroke-dasharray","6 4");
    else el.removeAttribute("stroke-dasharray");
  }
  // ---- text measurement + wrapping ----
  const LINE_H=18, MAX_TEXT_W=170;
  let measureCtx=null;
  try{const cv=document.createElement("canvas");measureCtx=cv.getContext("2d");}catch(e){}
  function measure(s){
    if(measureCtx){measureCtx.font="14px sans-serif";return measureCtx.measureText(s).width;}
    let w=0;for(const ch of s)w+=/[ᄀ-￿]/.test(ch)?14:7.5;return w; // fallback
  }
  function wrapLabel(label){
    const text=String(label==null?"":label);
    if(!text)return [""];
    if(measure(text)<=MAX_TEXT_W)return [text];
    const lines=[];let line="";
    const flush=()=>{if(line){lines.push(line);line="";}};
    for(const word of text.split(" ")){
      if(measure(word)>MAX_TEXT_W){ // break long word by char
        flush();let cur="";
        for(const ch of word){
          if(cur&&measure(cur+ch)>MAX_TEXT_W){lines.push(cur);cur=ch;}else cur+=ch;}
        line=cur;
      }else if(!line){line=word;}
      else if(measure(line+" "+word)<=MAX_TEXT_W){line+=" "+word;}
      else{lines.push(line);line=word;}
    }
    flush();
    return lines.length?lines:[""];
  }
  function sizeFor(n,lines){
    let maxLW=0;lines.forEach(l=>maxLW=Math.max(maxLW,measure(l)));
    let w=Math.min(214,Math.max(NODE_W,Math.ceil(maxLW)+34));
    let h=Math.max(NODE_H,16+lines.length*LINE_H);
    if(n.shape==="circle"){const d=Math.max(w,h,NODE_H+22);return {w:d,h:d};}
    if(n.shape==="diamond"){return {w:w+30,h:h+18};}
    if(n.shape==="hexagon"){return {w:w+30,h};}
    if(n.shape==="cylinder"){return {w,h:h+18};}
    if(n.shape==="subroutine"){return {w:w+18,h};}
    return {w,h};
  }
  function renderText(n,lines){
    const t=n.textEl;while(t.firstChild)t.removeChild(t.firstChild);
    const startY=-(lines.length-1)*LINE_H/2;
    lines.forEach((ln,i)=>{
      const ts=document.createElementNS(SVGNS,"tspan");
      ts.setAttribute("x",0);ts.setAttribute("y",startY+i*LINE_H);
      ts.textContent=ln;t.appendChild(ts);});
  }
  const XLINK="http://www.w3.org/1999/xlink";
  const IMG_SIZE=72;
  // pick a readable label color for a given background/fill (dark text on light, light text on dark)
  function contrastText(hex){
    if(!hex||hex[0]!=="#")return "#f2ecff";
    return luminance(hex)>0.6 ? "#1b1526" : "#f2ecff";
  }
  function drawShape(n){
    if(n.shape==="image"){                       // image node: invisible rect (select/drag) + <image> + label below
      const w=IMG_SIZE,h=IMG_SIZE;n.w=w;n.h=h;const s=n.shapeEl,hw=w/2,hh=h/2;
      s.setAttribute("x",-hw);s.setAttribute("y",-hh);s.setAttribute("width",w);s.setAttribute("height",h);
      s.setAttribute("rx",10);s.setAttribute("ry",10);s.setAttribute("fill","transparent");
      s.setAttribute("stroke","transparent");     // selection CSS overrides this with !important
      if(n.imgEl){n.imgEl.setAttribute("x",-hw+2);n.imgEl.setAttribute("y",-hh+2);
        n.imgEl.setAttribute("width",w-4);n.imgEl.setAttribute("height",h-4);
        n.imgEl.setAttribute("preserveAspectRatio","xMidYMid meet");
        n.imgEl.setAttributeNS(XLINK,"href",n.img||"");n.imgEl.setAttribute("href",n.img||"");}
      const t=n.textEl;while(t.firstChild)t.removeChild(t.firstChild);
      t.style.fill=contrastText(bgColor);       // inline style beats the CSS rule; label follows bg
      if(n.label){const ts=document.createElementNS(SVGNS,"tspan");
        ts.setAttribute("x",0);ts.setAttribute("y",hh+15);ts.textContent=n.label;t.appendChild(ts);}
      const pos=[[0,-hh],[hw,0],[0,hh],[-hw,0]];
      n.handles.forEach((hd,i)=>{hd.setAttribute("cx",pos[i][0]);hd.setAttribute("cy",pos[i][1]);hd.setAttribute("r",6);});
      return;
    }
    const lines=wrapLabel(n.label);
    const {w,h}=sizeFor(n,lines);n.w=w;n.h=h;const s=n.shapeEl;
    const hw=w/2,hh=h/2;
    if(n.shape==="diamond"){
      s.setAttribute("points",`0,${-hh} ${hw},0 0,${hh} ${-hw},0`);
    }else if(n.shape==="hexagon"){
      const nx=Math.min(hw-6,22);
      s.setAttribute("points",`${-hw+nx},${-hh} ${hw-nx},${-hh} ${hw},0 ${hw-nx},${hh} ${-hw+nx},${hh} ${-hw},0`);
    }else if(n.shape==="circle"){
      s.setAttribute("cx",0);s.setAttribute("cy",0);s.setAttribute("rx",hw);s.setAttribute("ry",hh);
    }else if(n.shape==="cylinder"){
      const ey=Math.min(12,Math.max(6,h*0.16));
      s.setAttribute("d",`M ${-hw},${-hh+ey} L ${-hw},${hh-ey} A ${hw} ${ey} 0 0 0 ${hw},${hh-ey} `
        +`L ${hw},${-hh+ey} A ${hw} ${ey} 0 0 0 ${-hw},${-hh+ey} Z`);
    }else{ // rect / round / stadium / subroutine
      s.setAttribute("x",-hw);s.setAttribute("y",-hh);
      s.setAttribute("width",w);s.setAttribute("height",h);
      const rad=(n.shape==="rect"||n.shape==="subroutine")?0:(n.shape==="stadium"?hh:12);
      s.setAttribute("rx",rad);s.setAttribute("ry",rad);
    }
    s.setAttribute("fill",n.fill||DEFAULT_FILL);
    n.textEl.style.fill=contrastText(n.fill||DEFAULT_FILL);   // inline style beats CSS; follow the shape fill
    applyStrokeAttrs(s,n);
    // decorative sub-elements
    if(n.decor&&n.decor.length){
      const col=n.stroke||DEFAULT_STROKE;
      if(n.shape==="subroutine"){
        const ins=6;
        n.decor[0].setAttribute("x1",-hw+ins);n.decor[0].setAttribute("y1",-hh);
        n.decor[0].setAttribute("x2",-hw+ins);n.decor[0].setAttribute("y2",hh);
        n.decor[1].setAttribute("x1",hw-ins);n.decor[1].setAttribute("y1",-hh);
        n.decor[1].setAttribute("x2",hw-ins);n.decor[1].setAttribute("y2",hh);
        n.decor.forEach(d=>{d.setAttribute("stroke",col);d.setAttribute("stroke-width",2);});
      }else if(n.shape==="cylinder"){
        const ey=Math.min(12,Math.max(6,h*0.16));
        const e=n.decor[0];
        e.setAttribute("cx",0);e.setAttribute("cy",-hh+ey);e.setAttribute("rx",hw);e.setAttribute("ry",ey);
        e.setAttribute("stroke",col);e.setAttribute("stroke-width",2);
      }
    }
    renderText(n,lines);
    const pos=[[0,-hh],[hw,0],[0,hh],[-hw,0]];
    n.handles.forEach((hd,i)=>{hd.setAttribute("cx",pos[i][0]);hd.setAttribute("cy",pos[i][1]);hd.setAttribute("r",6);});
  }
  function renderNode(n){
    const g=document.createElementNS(SVGNS,"g");
    g.setAttribute("class","node");g.dataset.id=n.id;
    const s=makeShapeEl(n.shape);s.setAttribute("class","shape");
    const t=document.createElementNS(SVGNS,"text");t.setAttribute("class","lbl-t");
    g.appendChild(s);
    if(n.shape==="image"){const im=document.createElementNS(SVGNS,"image");
      im.setAttribute("class","nimg");g.appendChild(im);n.imgEl=im;}
    // decor: subroutine gets 2 side lines, cylinder gets a top rim ellipse
    n.decor=[];
    if(n.shape==="subroutine"){for(let i=0;i<2;i++){const l=document.createElementNS(SVGNS,"line");
      l.setAttribute("class","decor");g.appendChild(l);n.decor.push(l);}}
    else if(n.shape==="cylinder"){const e=document.createElementNS(SVGNS,"ellipse");
      e.setAttribute("class","decor");g.appendChild(e);n.decor.push(e);}
    g.appendChild(t);
    n.handles=[];
    for(let i=0;i<4;i++){const c=document.createElementNS(SVGNS,"circle");
      c.setAttribute("class","handle");c.dataset.dir=i;g.appendChild(c);n.handles.push(c);}
    gNodes.appendChild(g);
    n.el=g;n.shapeEl=s;n.textEl=t;
    drawShape(n);position(n);wireNode(n);
  }
  function position(n){n.el.setAttribute("transform",`translate(${n.x},${n.y})`);}
  function refreshNode(n){drawShape(n);
    edges.forEach(e=>{if(e.from===n.id||e.to===n.id)drawEdge(e);});}

  // point on the node's actual outline in the direction of (tx,ty) — used for the temp connect line
  function edgePoint(n,tx,ty){
    const dx=tx-n.x,dy=ty-n.y;if(!dx&&!dy)return{x:n.x,y:n.y};
    const hw=n.w/2,hh=n.h/2;let sc;
    if(n.shape==="circle"){                       // ellipse boundary
      sc=1/Math.hypot(dx/hw,dy/hh);
    }else if(n.shape==="diamond"){                // rhombus boundary
      sc=1/(Math.abs(dx)/hw+Math.abs(dy)/hh);
    }else{                                        // rectangle-like box boundary
      sc=1/Math.max(Math.abs(dx)/hw,Math.abs(dy)/hh);
    }
    return{x:n.x+dx*sc,y:n.y+dy*sc};
  }
  // the 4 connection anchors (where the handle dots sit): top/right/bottom/left.
  // edges attach to the anchor nearest the other end, so arrows land on the visible dot.
  function anchorPoint(n,tx,ty){
    const hw=n.w/2,hh=n.h/2;
    const cand=[[n.x,n.y-hh],[n.x+hw,n.y],[n.x,n.y+hh],[n.x-hw,n.y]];
    let best=cand[0],bd=Infinity;
    for(const c of cand){const d=(c[0]-tx)*(c[0]-tx)+(c[1]-ty)*(c[1]-ty);if(d<bd){bd=d;best=c;}}
    return {x:best[0],y:best[1]};
  }
  // all edges connecting the same unordered node pair, in a stable order (by id)
  function edgeSiblings(e){return edges.filter(x=>(x.from===e.from&&x.to===e.to)||(x.from===e.to&&x.to===e.from))
    .sort((p,q)=>p.id-q.id);}
  function drawEdge(e){
    const a=nodes.find(n=>n.id===e.from),b=nodes.find(n=>n.id===e.to);if(!a||!b)return;
    const p1=anchorPoint(a,b.x,b.y),p2=anchorPoint(b,a.x,a.y);
    // auto-separate parallel/bidirectional edges: bow siblings apart so lines+labels don't overlap
    const sibs=edgeSiblings(e),tot=sibs.length,idx=sibs.indexOf(e);
    const bow=tot>1?(idx-(tot-1)/2)*26:0;
    let mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2,d;
    if(bow!==0){
      // perpendicular measured on a canonical axis (low id → high id) so opposite edges split cleanly
      const lo=Math.min(e.from,e.to),hi=Math.max(e.from,e.to);
      const A=nodes.find(n=>n.id===lo),B=nodes.find(n=>n.id===hi);
      const dx=B.x-A.x,dy=B.y-A.y,len=Math.hypot(dx,dy)||1;
      const px=-dy/len,py=dx/len;
      const cx=mx+px*bow*2,cy=my+py*bow*2;
      d=`M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`;
      mx=0.25*p1.x+0.5*cx+0.25*p2.x; my=0.25*p1.y+0.5*cy+0.25*p2.y;
    }else if(edgeCurve){
      const dx=p2.x-p1.x,dy=p2.y-p1.y,len=Math.hypot(dx,dy)||1;
      const off=Math.min(70,len*0.22);
      const cx=mx-dy/len*off, cy=my+dx/len*off;
      d=`M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`;
      mx=0.25*p1.x+0.5*cx+0.25*p2.x; my=0.25*p1.y+0.5*cy+0.25*p2.y;
    }else{
      d=`M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    }
    e.pathEl.setAttribute("d",d);e.hitEl.setAttribute("d",d);
    styleEdge(e);
    if(e.pulseEl)e.pulseEl.setAttribute("d",d);
    if(e.label){
      const cy=my-8, h=20, tw=measure(e.label)*0.86, bw=tw+18;   // padded, rounded label chip
      e.textEl.setAttribute("x",mx);e.textEl.setAttribute("y",cy);
      e.textEl.setAttribute("dominant-baseline","central");e.textEl.textContent=e.label;
      e.bgEl.setAttribute("x",mx-bw/2);e.bgEl.setAttribute("y",cy-h/2);
      e.bgEl.setAttribute("width",bw);e.bgEl.setAttribute("height",h);
      e.bgEl.setAttribute("rx",8);e.bgEl.setAttribute("ry",8);
      e.bgEl.style.display="";e.textEl.style.display="";
    }else{e.bgEl.style.display="none";e.textEl.style.display="none";}
    drawOrderBadge(e);
  }
  // numbered badge near the edge start — kept positioned but hidden (CSS opacity);
  // only flashed briefly (then fades out) when the order is (re)assigned
  function drawOrderBadge(e){
    let pt={x:0,y:0};
    try{const L=e.pathEl.getTotalLength();pt=e.pathEl.getPointAtLength(L*0.22);}catch(_){}
    e.badgeEl.setAttribute("cx",pt.x);e.badgeEl.setAttribute("cy",pt.y);e.badgeEl.setAttribute("r",9);
    e.badgeTx.setAttribute("x",pt.x);e.badgeTx.setAttribute("y",pt.y);e.badgeTx.textContent=String(e.order||1);
  }
  // toggle order-number badges on all edges (top-bar toggle)
  function toggleOrderBadges(){
    const on=document.getElementById("app").classList.toggle("show-order");
    const b=document.getElementById("orderBtn");if(b)b.classList.toggle("on",on);
  }
  function renderEdge(e){
    const g=document.createElementNS(SVGNS,"g");g.setAttribute("class","edge");g.dataset.id=e.id;
    const path=document.createElementNS(SVGNS,"path");path.setAttribute("class","line");
    const hit=document.createElementNS(SVGNS,"path");hit.setAttribute("class","hit");
    const bg=document.createElementNS(SVGNS,"rect");bg.setAttribute("fill","#120f1c");bg.setAttribute("rx",3);
    const text=document.createElementNS(SVGNS,"text");
    const badge=document.createElementNS(SVGNS,"circle");badge.setAttribute("class","order-badge");
    const badgeTx=document.createElementNS(SVGNS,"text");badgeTx.setAttribute("class","order-badge-t");
    g.appendChild(path);g.appendChild(bg);g.appendChild(text);g.appendChild(badge);g.appendChild(badgeTx);g.appendChild(hit);
    gEdges.appendChild(g);
    e.el=g;e.pathEl=path;e.hitEl=hit;e.textEl=text;e.bgEl=bg;e.badgeEl=badge;e.badgeTx=badgeTx;
    hit.addEventListener("click",ev=>{ev.stopPropagation();selectEdge(e);});
    hit.addEventListener("dblclick",ev=>{ev.stopPropagation();
      openInline(ev.clientX,ev.clientY,e.label,v=>{e.label=v.trim();drawEdge(e);sync();});});
    drawEdge(e);
  }

  // ---------- selection (multi-node + single edge) ----------
  const selNodes=new Set();   // currently selected node ids
  let selEdge=null;           // currently selected edge id (mutually exclusive with nodes)
  function clearSel(){
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);if(n)n.el.classList.remove("sel");});
    selNodes.clear();
    if(selEdge!=null){const e=edges.find(x=>x.id===selEdge);if(e)e.el.classList.remove("sel");}
    selEdge=null;
  }
  // additive=true keeps the existing node selection (used by marquee/shift)
  function selectNode(n,additive){
    if(!additive)clearSel();
    else if(selEdge!=null){const e=edges.find(x=>x.id===selEdge);if(e)e.el.classList.remove("sel");selEdge=null;}
    selNodes.add(n.id);n.el.classList.add("sel");
    // keep hidden pickers in sync so the right-click "직접…" opens with the node's current color
    document.getElementById("colorPick").value=rgbToHex(n.fill||DEFAULT_FILL);
    document.getElementById("strokePick").value=rgbToHex(n.stroke||DEFAULT_STROKE);
  }
  function selectEdge(e){clearSel();selEdge=e.id;e.el.classList.add("sel");}
  function rgbToHex(c){return c&&c.startsWith("#")?c:"#2f2748";}

  // ---------- pointer helpers ----------
  function cursorPt(ev){const pt=svg.createSVGPoint();pt.x=ev.clientX;pt.y=ev.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());}
  function nodeUnder(ev){
    const el=document.elementFromPoint(ev.clientX,ev.clientY);
    if(!el)return null;const g=el.closest?.(".node");if(!g)return null;
    return nodes.find(n=>n.id===+g.dataset.id)||null;
  }

  // ---------- node interactions ----------
  function wireNode(n){
    let dragging=false,moved=false,start=null,group=null;
    // body drag = move (moves the whole current selection together)
    n.shapeEl.addEventListener("mousedown",ev=>{
      if(ev.button!==0||spaceDown)return; // left button only; space = pan
      ev.stopPropagation();
      if(!selNodes.has(n.id))selectNode(n); // clicking an unselected node selects it alone
      const p=cursorPt(ev);start={x:p.x,y:p.y};
      group=[...selNodes].map(id=>{const nn=nodes.find(x=>x.id===id);return {n:nn,x0:nn.x,y0:nn.y};});
      dragging=true;moved=false;n.el.style.cursor="grabbing";
    });
    n.textEl.addEventListener("mousedown",ev=>{n.shapeEl.dispatchEvent(new MouseEvent("mousedown",ev));});
    window.addEventListener("mousemove",ev=>{
      if(!dragging)return;const p=cursorPt(ev);
      const dx=p.x-start.x,dy=p.y-start.y;
      if(Math.abs(dx)+Math.abs(dy)>1)moved=true;
      group.forEach(g=>{g.n.x=g.x0+dx;g.n.y=g.y0+dy;position(g.n);});
      edges.forEach(drawEdge);renderGroups();
    });
    window.addEventListener("mouseup",()=>{if(dragging){dragging=false;n.el.style.cursor="grab";if(moved)sync();}});
    n.el.addEventListener("dblclick",ev=>{ev.stopPropagation();
      openInline(ev.clientX,ev.clientY,n.label,v=>{
        n.label=v.trim()||n.label;refreshNode(n);sync();});});
    // handles = drag to connect
    n.handles.forEach(hd=>{
      hd.addEventListener("mousedown",ev=>{if(ev.button!==0)return;ev.stopPropagation();startConnect(n,ev);});
    });
  }

  function startConnect(source,ev){
    connecting={source};
    tempEdge.style.display="";
    const p=cursorPt(ev);
    const sp=edgePoint(source,p.x,p.y);
    tempEdge.setAttribute("d",`M ${sp.x} ${sp.y} L ${p.x} ${p.y}`);
    window.addEventListener("mousemove",onConnectMove);
    window.addEventListener("mouseup",onConnectUp);
  }
  let lastTarget=null;
  function onConnectMove(ev){
    if(!connecting)return;const p=cursorPt(ev);
    const sp=edgePoint(connecting.source,p.x,p.y);
    tempEdge.setAttribute("d",`M ${sp.x} ${sp.y} L ${p.x} ${p.y}`);
    const t=nodeUnder(ev);
    if(lastTarget&&lastTarget!==t)lastTarget.el.classList.remove("droptarget");
    if(t&&t.id!==connecting.source.id){t.el.classList.add("droptarget");lastTarget=t;}
    else lastTarget=null;
  }
  function onConnectUp(ev){
    window.removeEventListener("mousemove",onConnectMove);
    window.removeEventListener("mouseup",onConnectUp);
    tempEdge.style.display="none";
    if(lastTarget)lastTarget.el.classList.remove("droptarget");
    const t=nodeUnder(ev);
    if(connecting&&t&&t.id!==connecting.source.id){
      addEdge(connecting.source.id,t.id,"");
    }
    connecting=null;lastTarget=null;
  }

  // ---------- CRUD ----------
  function addNode(shape,x,y,label){
    const n={id:++nid,label:label||("노드"+nid),shape:shape||"round",
      fill:DEFAULT_FILL,stroke:DEFAULT_STROKE,bstyle:"solid",
      x:x??(160+Math.random()*300),y:y??(120+Math.random()*240),w:NODE_W,h:NODE_H,handles:[]};
    nodes.push(n);renderNode(n);updateEmpty();sync();return n;
  }
  // image node: an <image> icon with an optional label beneath (used for pasted images / imported AWS icons)
  function addImageNode(img,x,y,label){
    const n={id:++nid,label:label||"",shape:"image",img:img,
      fill:DEFAULT_FILL,stroke:DEFAULT_STROKE,bstyle:"solid",
      x:x??(view.x+view.w/2),y:y??(view.y+view.h/2),w:IMG_SIZE,h:IMG_SIZE,handles:[]};
    nodes.push(n);renderNode(n);updateEmpty();sync();return n;
  }
  function addEdge(from,to,label,style){
    if(edges.some(e=>e.from===from&&e.to===to)){toast("이미 연결됨");return;}
    const e={id:++eid,from,to,label:label||"",order:1,tags:[],
      line:(style&&style.line)||edgeDefaults.line,head:(style&&style.head)||edgeDefaults.head};
    edges.push(e);renderEdge(e);
    edgeSiblings(e).forEach(drawEdge);              // re-bow existing sibling so both separate
    sync();
  }
  function deleteSelected(){
    stopAnim();
    if(selEdge!=null){                               // delete the selected edge
      const e=edges.find(x=>x.id===selEdge);
      if(e){e.el.remove();edges=edges.filter(x=>x.id!==e.id);}
      selEdge=null;edges.forEach(drawEdge);updateEmpty();sync();return;
    }
    if(!selNodes.size){toast("삭제할 대상을 선택하세요");return;}
    const ids=new Set(selNodes);                     // delete all selected nodes + their edges
    edges.filter(e=>ids.has(e.from)||ids.has(e.to)).forEach(e=>e.el.remove());
    edges=edges.filter(e=>!ids.has(e.from)&&!ids.has(e.to));
    nodes.filter(n=>ids.has(n.id)).forEach(n=>n.el.remove());
    nodes=nodes.filter(n=>!ids.has(n.id));
    subgraphs.forEach(sg=>ids.forEach(id=>sg.nodes.delete(id)));
    selNodes.clear();edges.forEach(drawEdge);updateEmpty();renderGroups();sync();
  }
  function applyColor(hex){                           // recolor every selected node's fill
    if(!selNodes.size){toast("색을 바꿀 노드를 먼저 선택하세요");return;}
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);
      if(n){n.fill=hex;n.shapeEl.setAttribute("fill",hex);}});
    sync();
  }
  function applyStroke(hex){                          // recolor every selected node's border
    if(!selNodes.size){toast("테두리를 바꿀 노드를 먼저 선택하세요");return;}
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);if(n){n.stroke=hex;drawShape(n);}});
    sync();
  }
  function applyBstyle(style){                        // border style: solid/dashed/thick
    if(!selNodes.size){toast("테두리를 바꿀 노드를 먼저 선택하세요");return;}
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);if(n){n.bstyle=style;drawShape(n);}});
    sync();
  }
  // apply line/head to the selected edge (and remember as default for new edges)
  function applyEdgeStyle(part,val){
    edgeDefaults[part]=val;
    if(selEdge!=null){const e=edges.find(x=>x.id===selEdge);if(e){e[part]=val;drawEdge(e);sync();}}
  }
  // global animation (pulse) color — applies to every edge's flow animation
  function applyAnimColor(hex){animColor=hex;
    if(animState)edges.forEach(e=>{if(e.pulseGrad)
      for(let k=0;k<e.pulseGrad.childNodes.length;k++)e.pulseGrad.childNodes[k].setAttribute("stop-color",animColor);});
    sync();}

  // ---------- subgraphs ----------
  function renderGroups(){
    // drop groups that lost all members
    subgraphs=subgraphs.filter(sg=>{
      const mem=[...sg.nodes].filter(id=>nodes.some(n=>n.id===id));
      if(!mem.length){sg.el.remove();return false;}return true;});
    subgraphs.forEach(sg=>{
      const mem=[...sg.nodes].map(id=>nodes.find(n=>n.id===id)).filter(Boolean);
      let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
      mem.forEach(n=>{minX=Math.min(minX,n.x-n.w/2);maxX=Math.max(maxX,n.x+n.w/2);
        minY=Math.min(minY,n.y-n.h/2);maxY=Math.max(maxY,n.y+n.h/2);});
      const pad=22,titleH=24;
      sg.rectEl.setAttribute("x",minX-pad);sg.rectEl.setAttribute("y",minY-pad-titleH);
      sg.rectEl.setAttribute("width",maxX-minX+pad*2);
      sg.rectEl.setAttribute("height",maxY-minY+pad*2+titleH);
      sg.rectEl.setAttribute("rx",12);
      const col=sg.color||"#8b5cf6";                 // per-group color (customizable)
      sg.rectEl.setAttribute("fill",col);sg.rectEl.setAttribute("fill-opacity","0.07");
      sg.rectEl.setAttribute("stroke",col);
      sg.rectEl.setAttribute("stroke-width","1.4");sg.rectEl.setAttribute("stroke-dasharray","6 4");
      sg.titleEl.setAttribute("fill",col);
      sg.titleEl.setAttribute("x",minX-pad+12);sg.titleEl.setAttribute("y",minY-pad-titleH+16);
      sg.titleEl.textContent=sg.title;
    });
  }
  function makeGroup(){
    if(!selNodes.size){toast("묶을 노드를 먼저 선택하세요");return;}
    const ids=[...selNodes];
    subgraphs.forEach(sg=>ids.forEach(id=>sg.nodes.delete(id))); // a node lives in one group
    rebuildGroup({id:++gid,title:"그룹 "+gid,nodes:ids,color:"#8b5cf6"});
    renderGroups();sync();toast("그룹으로 묶음");
  }
  function ungroup(){
    if(!selNodes.size){toast("해제할 그룹의 노드를 선택하세요");return;}
    let removed=0;
    subgraphs=subgraphs.filter(sg=>{
      const hit=[...selNodes].some(id=>sg.nodes.has(id));
      if(hit){sg.el.remove();removed++;return false;}return true;});
    if(removed){sync();toast("그룹 해제");}else toast("선택 항목이 속한 그룹이 없습니다");
  }
  // groups that contain any currently selected node
  function selectedGroups(){return subgraphs.filter(sg=>[...selNodes].some(id=>sg.nodes.has(id)));}
  function applyGroupColor(hex){
    const gs=selectedGroups();
    if(!gs.length){toast("색을 바꿀 그룹의 노드를 선택하세요");return;}
    gs.forEach(sg=>sg.color=hex);renderGroups();sync();
  }
  function updateEmpty(){emptyHint.style.display=nodes.length?"none":"";}

  // ---------- persistence trigger ----------
  // (was Mermaid code generation; the app is now a standalone editor with its own JSON format)
  // called after any change to refresh the tag bar and record history/autosave
  function sync(){
    if(typeof renderTagBar==="function"){if(activeTag)applyTagFilter();else renderTagBar();}
    commit();
  }

  // ---------- edge styling + markers ----------
  // set stroke width/dash + start/end markers from e.line and e.head
  function styleEdge(e){
    const p=e.pathEl;
    p.style.stroke=DEFAULT_EDGE;
    p.style.strokeWidth=(e.line==="thick"?4:2);
    p.style.strokeDasharray=(e.line==="dotted"?"5 4":"");
    const endMap={arrow:"arrow",open:"",circle:"circleEnd",cross:"crossEnd",bi:"arrow"};
    const endId=(e.head in endMap)?endMap[e.head]:"arrow";
    if(endId)p.setAttribute("marker-end","url(#"+endId+")");else p.removeAttribute("marker-end");
    if(e.head==="bi")p.setAttribute("marker-start","url(#arrow)");else p.removeAttribute("marker-start");
  }
  function buildDefs(){
    const defs=document.createElementNS(SVGNS,"defs");
    const COL=DEFAULT_EDGE;
    const mk=(id,refX,orient,child)=>{
      const m=document.createElementNS(SVGNS,"marker");
      m.setAttribute("id",id);m.setAttribute("viewBox","0 0 10 10");
      m.setAttribute("refX",refX);m.setAttribute("refY","5");
      m.setAttribute("markerWidth","8");m.setAttribute("markerHeight","8");
      m.setAttribute("orient",orient);child.forEach(c=>m.appendChild(c));defs.appendChild(m);
    };
    const path=(d,fill,stroke)=>{const p=document.createElementNS(SVGNS,"path");p.setAttribute("d",d);
      if(fill)p.setAttribute("fill",fill);else p.setAttribute("fill","none");
      if(stroke){p.setAttribute("stroke",stroke);p.setAttribute("stroke-width","1.6");}return p;};
    // triangular arrow (used for both ends via auto-start-reverse)
    mk("arrow","9","auto-start-reverse",[path("M 0 0 L 10 5 L 0 10 z",COL)]);
    // hollow circle terminator (--o)
    const circ=document.createElementNS(SVGNS,"circle");
    circ.setAttribute("cx","5");circ.setAttribute("cy","5");circ.setAttribute("r","4");
    circ.setAttribute("fill",COL);
    mk("circleEnd","5","auto",[circ]);
    // cross terminator (--x)
    mk("crossEnd","5","auto",[path("M 1 1 L 9 9",null,COL),path("M 9 1 L 1 9",null,COL)]);
    return defs;
  }
  svg.insertBefore(buildDefs(),svg.firstChild);

  // ---------- PNG export ----------
  function exportPNG(){
    if(!nodes.length){toast("먼저 노드를 추가하세요");return;}
    askFilename("flowcanvas-diagram","png",fn=>doExportPNG(fn));
  }
  function doExportPNG(fn){
    const b=contentBounds();let{minX,minY,maxX,maxY}=b;
    const pad=40;minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;
    const w=Math.ceil(maxX-minX),h=Math.ceil(maxY-minY),scale=2;
    const clone=document.createElementNS(SVGNS,"svg");
    clone.setAttribute("xmlns",SVGNS);clone.setAttribute("width",w);clone.setAttribute("height",h);
    clone.setAttribute("viewBox",`${minX} ${minY} ${w} ${h}`);
    const bg=document.createElementNS(SVGNS,"rect");
    bg.setAttribute("x",minX);bg.setAttribute("y",minY);bg.setAttribute("width",w);bg.setAttribute("height",h);
    bg.setAttribute("fill",bgColor);clone.appendChild(bg);
    clone.appendChild(buildDefs());
    clone.appendChild(gGroups.cloneNode(true));
    clone.appendChild(gEdges.cloneNode(true));
    clone.appendChild(gNodes.cloneNode(true));
    inlineStyles(clone);
    const svgStr=new XMLSerializer().serializeToString(clone);
    const img=new Image();
    img.onload=function(){
      const canvas=document.createElement("canvas");canvas.width=w*scale;canvas.height=h*scale;
      const ctx=canvas.getContext("2d");ctx.setTransform(scale,0,0,scale,0,0);ctx.drawImage(img,0,0);
      canvas.toBlob(function(b){download(b,fn);toast("PNG 저장 완료: "+fn);},"image/png");
    };
    img.onerror=function(){toast("내보내기 실패");};
    img.src="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svgStr)));
  }
  function inlineStyles(root){
    // node shape/decor already carry fill+stroke+dash as attributes → keep them, just fill gaps
    root.querySelectorAll(".node .shape").forEach(el=>{
      if(!el.getAttribute("fill"))el.setAttribute("fill",DEFAULT_FILL);
      if(!el.getAttribute("stroke"))el.setAttribute("stroke",DEFAULT_STROKE);});
    root.querySelectorAll(".node text").forEach(el=>{
      if(!el.getAttribute("fill"))el.setAttribute("fill","#f2ecff"); // keep per-node contrast color
      el.setAttribute("font-size","14");
      el.setAttribute("text-anchor","middle");el.setAttribute("dominant-baseline","middle");
      el.setAttribute("font-family","sans-serif");});
    root.querySelectorAll(".handle").forEach(el=>el.remove());
    // edge lines carry color/width/dash as inline styles (preserved in clone)
    root.querySelectorAll(".edge path.line").forEach(el=>{
      if(!el.style.stroke)el.style.stroke="#9c8fce";el.setAttribute("fill","none");});
    root.querySelectorAll(".edge .hit").forEach(el=>el.remove());
    root.querySelectorAll(".edge text").forEach(el=>{
      el.setAttribute("fill","#eceaf3");el.setAttribute("font-size","12");el.setAttribute("font-weight","600");
      el.setAttribute("text-anchor","middle");el.setAttribute("font-family","sans-serif");});
    // subgraph rect fill/stroke are already attributes (per-group color); just add font attrs for the title
    root.querySelectorAll(".subgraph text").forEach(el=>{
      el.setAttribute("font-size","13");el.setAttribute("font-weight","600");
      el.setAttribute("font-family","sans-serif");});
    root.querySelectorAll(".sel").forEach(el=>el.classList.remove("sel"));
    // UI-only overlays (animation pulse, order badges) don't belong in the export
    root.querySelectorAll(".pulse,.order-badge,.order-badge-t").forEach(el=>el.remove());
  }

  // ---------- inline label editor (tooltip box) ----------
  const inlineEl=document.getElementById("inlineEditor");
  const inlineInput=document.getElementById("inlineInput");
  let inlineCommit=null;
  function openInline(clientX,clientY,value,commit){
    const r=canvasWrap.getBoundingClientRect();
    inlineEl.style.left=(clientX-r.left)+"px";
    inlineEl.style.top=(clientY-r.top-30)+"px";
    inlineEl.style.display="block";
    inlineInput.value=value||"";
    inlineCommit=commit;
    setTimeout(()=>{inlineInput.focus();inlineInput.select();},0);
  }
  function closeInline(save){
    if(save&&inlineCommit)inlineCommit(inlineInput.value);
    inlineCommit=null;inlineEl.style.display="none";
  }
  document.getElementById("inlineOk").addEventListener("click",()=>closeInline(true));
  inlineInput.addEventListener("keydown",ev=>{
    ev.stopPropagation();
    if(ev.key==="Enter"){ev.preventDefault();closeInline(true);}
    else if(ev.key==="Escape"){ev.preventDefault();closeInline(false);}
  });
  inlineInput.addEventListener("blur",()=>{if(inlineCommit)closeInline(true);});

  // ---------- pan (Space + drag) & zoom (wheel) ----------
  svg.addEventListener("mousedown",ev=>{
    if(!spaceDown||ev.button!==0)return;
    ev.preventDefault();ev.stopPropagation();
    canvasWrap.classList.add("panning");
    panning={sx:ev.clientX,sy:ev.clientY,vx:view.x,vy:view.y};
  },true);
  window.addEventListener("mousemove",ev=>{
    if(!panning)return;
    const r=svg.getBoundingClientRect();
    const kx=view.w/r.width, ky=view.h/r.height;
    view.x=panning.vx-(ev.clientX-panning.sx)*kx;
    view.y=panning.vy-(ev.clientY-panning.sy)*ky;
    applyView();
  });
  window.addEventListener("mouseup",()=>{if(panning){panning=null;canvasWrap.classList.remove("panning");}});
  canvasWrap.addEventListener("wheel",ev=>{
    ev.preventDefault();
    const p=cursorPt(ev);
    // gentle, proportional zoom (less sensitive on trackpads); clamp per-event step
    const dy=Math.max(-60,Math.min(60,ev.deltaY));
    const factor=Math.min(1.12,Math.max(0.89,Math.pow(1.0011,dy)));
    const nw=Math.min(6000,Math.max(200,view.w*factor));
    const scale=nw/view.w;
    const r=svg.getBoundingClientRect();
    const rx=(ev.clientX-r.left)/r.width, ry=(ev.clientY-r.top)/r.height;
    view.w=nw;view.h=view.h*scale;
    view.x=p.x-rx*view.w;view.y=p.y-ry*view.h;
    applyView();
  },{passive:false});

  // ---------- touch support (tablets) ----------
  // One finger → forwarded to mouse events (node/handle/marquee/group drag).
  // Two fingers → pan the canvas. Prevents the page from scrolling during a drag.
  (function touchBridge(){
    let gesture=null,lpTimer=null,t0=null;
    const avg=t=>({x:(t[0].clientX+t[1].clientX)/2,y:(t[0].clientY+t[1].clientY)/2});
    const dist=t=>Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY);
    const fwd=(type,pt,target)=>{
      const el=target||document.elementFromPoint(pt.clientX,pt.clientY)||canvasWrap;
      el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,
        clientX:pt.clientX,clientY:pt.clientY,button:0}));
    };
    const cancelLP=()=>{if(lpTimer){clearTimeout(lpTimer);lpTimer=null;}};
    canvasWrap.addEventListener("touchstart",e=>{
      cancelLP();
      if(e.touches.length===2){                       // two fingers → pinch-zoom + pan
        e.preventDefault();t0=null;
        gesture={mid:avg(e.touches),dist:dist(e.touches),
          vx:view.x,vy:view.y,vw:view.w,vh:view.h,r:svg.getBoundingClientRect()};
        return;
      }
      if(e.touches.length!==1)return;
      e.preventDefault();                             // stop scroll + suppress emulated mouse events
      const t=e.touches[0],target=e.target;
      fwd("mousedown",t,target);
      t0={x:t.clientX,y:t.clientY,target,time:Date.now(),moved:false};
      lpTimer=setTimeout(()=>{lpTimer=null;fwd("mouseup",t,window); // end armed drag, then open menu
        if(t0)t0.menu=true;showContextMenu(t.clientX,t.clientY,target);},520);
    },{passive:false});
    canvasWrap.addEventListener("touchmove",e=>{
      if(gesture&&e.touches.length===2){e.preventDefault();
        const a=avg(e.touches),d=dist(e.touches)||1,r=gesture.r;
        let nw=Math.min(6000,Math.max(120,gesture.vw*(gesture.dist/d)));
        const nh=gesture.vh*(nw/gesture.vw);
        const fx=gesture.vx+(gesture.mid.x-r.left)/r.width*gesture.vw;   // focal point (diagram coords)
        const fy=gesture.vy+(gesture.mid.y-r.top)/r.height*gesture.vh;
        view.w=nw;view.h=nh;
        view.x=fx-(a.x-r.left)/r.width*nw;
        view.y=fy-(a.y-r.top)/r.height*nh;applyView();return;}
      if(e.touches.length!==1||!t0)return;
      const t=e.touches[0];
      if(Math.abs(t.clientX-t0.x)+Math.abs(t.clientY-t0.y)>8){t0.moved=true;cancelLP();}
      e.preventDefault();fwd("mousemove",t,window);
    },{passive:false});
    canvasWrap.addEventListener("touchend",e=>{
      cancelLP();
      if(gesture&&e.touches.length<2)gesture=null;
      if(t0&&!t0.menu&&e.changedTouches.length){
        const c=e.changedTouches[0];fwd("mouseup",c,window);
        if(!t0.moved&&Date.now()-t0.time<500)fwd("click",c,t0.target); // tap → click (selects edges etc.)
      }
      t0=null;
    },{passive:false});
  })();

  // ---------- palette drag → drop to place node ----------
  let paletteDrag=null;
  document.querySelectorAll(".shape-btn").forEach(btn=>{
    btn.addEventListener("mousedown",ev=>{
      if(ev.button!==0)return;
      ev.preventDefault();
      const ghost=document.createElement("div");
      ghost.className="drag-ghost";
      ghost.innerHTML=btn.querySelector("svg").outerHTML;
      document.body.appendChild(ghost);
      paletteDrag={shape:btn.dataset.shape,ghost,moved:false,sx:ev.clientX,sy:ev.clientY};
      moveGhost(ev.clientX,ev.clientY);
    });
  });
  function moveGhost(x,y){if(paletteDrag){paletteDrag.ghost.style.left=(x-35)+"px";
    paletteDrag.ghost.style.top=(y-22)+"px";}}
  window.addEventListener("mousemove",ev=>{
    if(!paletteDrag)return;
    if(Math.abs(ev.clientX-paletteDrag.sx)+Math.abs(ev.clientY-paletteDrag.sy)>3)paletteDrag.moved=true;
    moveGhost(ev.clientX,ev.clientY);
  });
  window.addEventListener("mouseup",ev=>{
    if(!paletteDrag)return;
    const pd=paletteDrag;paletteDrag=null;pd.ghost.remove();
    const r=canvasWrap.getBoundingClientRect();
    const inside=ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom;
    let x,y;
    if(inside){const p=cursorPt(ev);x=p.x;y=p.y;}
    else{const p={x:view.x+view.w/2,y:view.y+view.h/2};x=p.x;y=p.y;}
    const n=addNode(pd.shape,x,y);selectNode(n);
  });

  // ---------- serialize / load ----------
  function clearScene(){stopAnim();nodes.forEach(n=>n.el.remove());edges.forEach(e=>e.el.remove());
    subgraphs.forEach(sg=>sg.el.remove());
    nodes=[];edges=[];subgraphs=[];selNodes.clear();selEdge=null;}
  function serialize(){return {v:3,edgeCurve,bgColor,animColor,nid,eid,gid,
    nodes:nodes.map(n=>{const o={id:n.id,label:n.label,shape:n.shape,x:Math.round(n.x),y:Math.round(n.y),
      fill:n.fill,stroke:n.stroke,bstyle:n.bstyle};if(n.shape==="image")o.img=n.img;return o;}),
    edges:edges.map(e=>({id:e.id,from:e.from,to:e.to,label:e.label,line:e.line,head:e.head,
      order:e.order||1,tags:(e.tags||[]).slice()})),
    groups:subgraphs.map(sg=>({id:sg.id,title:sg.title,nodes:[...sg.nodes],color:sg.color}))};}
  function loadState(s){
    clearScene();activeTag=null;
    nid=s.nid||0;eid=s.eid||0;gid=s.gid||0;
    edgeCurve=!!s.edgeCurve;updateCurveBtn();
    applyBg(s.bgColor||"#0d0b13");
    animColor=s.animColor||"#e879f9";const ap=document.getElementById("animPick");if(ap)ap.value=animColor;
    (s.nodes||[]).forEach(d=>{const n={id:d.id,label:d.label,shape:d.shape,img:d.img,
      fill:d.fill||DEFAULT_FILL,stroke:d.stroke||DEFAULT_STROKE,bstyle:d.bstyle||"solid",
      x:d.x,y:d.y,w:NODE_W,h:NODE_H,handles:[]};nodes.push(n);renderNode(n);});
    (s.edges||[]).forEach(d=>{const e={id:d.id,from:d.from,to:d.to,label:d.label||"",
      line:d.line||"solid",head:d.head||"arrow",
      order:d.order||1,tags:d.tags||[]};edges.push(e);renderEdge(e);});
    (s.groups||[]).forEach(d=>rebuildGroup(d));
    nid=Math.max(nid,0,...nodes.map(n=>n.id));
    eid=Math.max(eid,0,...edges.map(e=>e.id));
    gid=Math.max(gid,0,...subgraphs.map(sg=>sg.id));
    updateEmpty();renderGroups();sync();
  }
  // recreate a subgraph from serialized data
  function rebuildGroup(d){
    const sg={id:d.id,title:d.title||("그룹 "+d.id),nodes:new Set(d.nodes||[]),color:d.color||"#8b5cf6"};
    const g=document.createElementNS(SVGNS,"g");g.setAttribute("class","subgraph");
    const rect=document.createElementNS(SVGNS,"rect");
    const title=document.createElementNS(SVGNS,"text");
    g.appendChild(rect);g.appendChild(title);gGroups.appendChild(g);
    sg.el=g;sg.rectEl=rect;sg.titleEl=title;
    wireGroup(sg);
    subgraphs.push(sg);
  }
  function renameGroupSg(sg,x,y){
    openInline(x,y,sg.title,v=>{sg.title=String(v==null?"":v).trim()||sg.title;renderGroups();sync();});
  }
  // drag the group box to move all member nodes; double-click to rename
  function wireGroup(sg){
    let dragging=false,start=null,grp=null;
    sg.el.addEventListener("dblclick",ev=>{ev.stopPropagation();
      renameGroupSg(sg,ev.clientX,ev.clientY);});
    sg.el.addEventListener("mousedown",ev=>{
      if(ev.button!==0)return;                   // left button only (right = context menu)
      if(spaceDown)return;                       // space = pan
      ev.stopPropagation();
      clearSel();                                 // select members so color/delete apply too
      [...sg.nodes].forEach(id=>{const n=nodes.find(x=>x.id===id);
        if(n){selNodes.add(n.id);n.el.classList.add("sel");}});
      const gp=document.getElementById("groupColorPick");if(gp)gp.value=sg.color||"#8b5cf6";
      const p=cursorPt(ev);start={x:p.x,y:p.y};
      grp=[...sg.nodes].map(id=>nodes.find(n=>n.id===id)).filter(Boolean).map(n=>({n,x0:n.x,y0:n.y}));
      dragging=true;sg.el.style.cursor="grabbing";
    });
    window.addEventListener("mousemove",ev=>{
      if(!dragging)return;const p=cursorPt(ev);const dx=p.x-start.x,dy=p.y-start.y;
      grp.forEach(g=>{g.n.x=g.x0+dx;g.n.y=g.y0+dy;position(g.n);});
      edges.forEach(drawEdge);renderGroups();
    });
    window.addEventListener("mouseup",()=>{if(dragging){dragging=false;sg.el.style.cursor="grab";sync();}});
  }

  // ---------- history (undo / redo) + autosave ----------
  const LS_DIAGRAM="flowcanvas.diagram";
  let undoStack=[],redoStack=[],lastCommitted=null,restoring=false;
  function snapshot(){return Y.dump(serialize());}
  function autosave(){try{localStorage.setItem(LS_DIAGRAM,lastCommitted||snapshot());}catch(e){}}
  function commit(){
    if(restoring)return;
    const s=snapshot();
    if(s===lastCommitted)return;
    if(lastCommitted!==null){undoStack.push(lastCommitted);if(undoStack.length>200)undoStack.shift();}
    lastCommitted=s;redoStack=[];autosave();updateUndoBtns();
  }
  function restoreFrom(s){restoring=true;loadState(Y.load(s));restoring=false;
    lastCommitted=s;autosave();updateUndoBtns();}
  function undo(){if(!undoStack.length){toast("실행취소할 작업이 없습니다");return;}
    redoStack.push(lastCommitted);restoreFrom(undoStack.pop());toast("실행취소");}
  function redo(){if(!redoStack.length){toast("다시실행할 작업이 없습니다");return;}
    undoStack.push(lastCommitted);restoreFrom(redoStack.pop());toast("다시실행");}
  function updateUndoBtns(){
    const u=document.getElementById("undoBtn"),r=document.getElementById("redoBtn");
    if(u)u.style.opacity=undoStack.length?"1":".4";
    if(r)r.style.opacity=redoStack.length?"1":".4";}

  // ---------- background color ----------
  function mixColor(hex,amt,toward){ // blend hex toward 255 (white) or 0 (black) by amt(0..1)
    const n=parseInt(hex.slice(1),16);let r=(n>>16)&255,g=(n>>8)&255,b=n&255;
    r=Math.round(r+(toward-r)*amt);g=Math.round(g+(toward-g)*amt);b=Math.round(b+(toward-b)*amt);
    return "#"+((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1);
  }
  function luminance(hex){const n=parseInt(hex.slice(1),16);
    return (0.299*((n>>16)&255)+0.587*((n>>8)&255)+0.114*(n&255))/255;}
  const BG_DARK="#0d0b13", BG_LIGHT="#ffffff";
  const MOON_SVG='<svg viewBox="0 0 24 24" width="13" height="13"><path d="M15 2.5a9 9 0 1 0 6.9 12.3A7 7 0 0 1 15 2.5z" fill="#111"/></svg>';
  const SUN_SVG='<svg viewBox="0 0 24 24" width="14" height="14" stroke="#111" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4" fill="#111" stroke="none"/><line x1="12" y1="2" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22"/><line x1="2" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="6.6" y2="6.6"/><line x1="17.4" y1="17.4" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="6.6" y2="17.4"/><line x1="17.4" y1="6.6" x2="19.1" y2="4.9"/></svg>';
  function applyBg(hex){
    bgColor=hex;
    const dark=luminance(hex)<0.5;
    const dot=mixColor(hex,dark?0.20:0.16,dark?255:0); // contrasting grid dots
    canvasWrap.style.background=
      "radial-gradient(circle at 1px 1px, "+dot+" 1px, transparent 0) 0 0/22px 22px, "+hex;
    const b=document.getElementById("bgBtn");
    if(b){b.classList.toggle("light",!dark);const k=b.querySelector(".tt-knob");if(k)k.innerHTML=dark?MOON_SVG:SUN_SVG;}
    // image-node labels sit on the canvas, so re-tint them for the new background
    if(typeof nodes!=="undefined")nodes.forEach(n=>{if(n.shape==="image"&&n.textEl)drawShape(n);});
  }
  function toggleBg(){applyBg(luminance(bgColor)<0.5?BG_LIGHT:BG_DARK);sync();}

  // ---------- curve toggle ----------
  function updateCurveBtn(){const b=document.getElementById("curveBtn");if(b)b.classList.toggle("on",edgeCurve);}
  function toggleCurve(){edgeCurve=!edgeCurve;updateCurveBtn();edges.forEach(drawEdge);sync();
    toast(edgeCurve?"곡선 화살표":"직선 화살표");}

  // ---------- flow animation ----------
  // A "comet" pulse grows from the source and travels along each edge toward its arrow.
  // Edges are grouped by `order`: same order animate together, different orders play in sequence.
  let animState=null, animLoop=false;
  const ANIM_STEP=1100;                        // ms per order-group
  function ensurePulse(e){
    if(!e.pulseEl){
      const gid="pg"+e.id;
      const grad=document.createElementNS(SVGNS,"linearGradient");
      grad.setAttribute("id",gid);grad.setAttribute("gradientUnits","userSpaceOnUse");
      const mk=(off,op)=>{const s=document.createElementNS(SVGNS,"stop");
        s.setAttribute("offset",off);s.setAttribute("stop-opacity",op);return s;};
      // transparent tail → bright head, so the streak fades out behind itself
      grad.appendChild(mk("0","0"));grad.appendChild(mk("0.5","0.55"));grad.appendChild(mk("1","1"));
      e.el.appendChild(grad);e.pulseGrad=grad;
      const p=document.createElementNS(SVGNS,"path");p.setAttribute("class","pulse");
      p.setAttribute("d",e.pathEl.getAttribute("d"));p.style.stroke="url(#"+gid+")";
      e.el.appendChild(p);e.pulseEl=p;
    }
    return e.pulseEl;
  }
  function clearPulses(){edges.forEach(e=>{
    if(e.pulseEl){e.pulseEl.remove();e.pulseEl=null;}
    if(e.pulseGrad){e.pulseGrad.remove();e.pulseGrad=null;}});}
  function drawPulse(e,u){                      // u in [0,1] over this edge's step
    const path=e.pathEl,L=path.getTotalLength()||1,SEG=Math.max(30,L*0.5);
    const ease=u<0.5?2*u*u:1-Math.pow(-2*u+2,2)/2;        // easeInOutQuad for smoother travel
    const full=ease*(L+SEG),head=Math.min(L,full);let tail=Math.max(0,full-SEG);tail=Math.min(tail,L);
    const p=ensurePulse(e);p.setAttribute("d",path.getAttribute("d"));
    p.style.strokeDasharray="0 "+tail+" "+(head-tail)+" "+(L+SEG);
    p.style.filter="drop-shadow(0 0 6px "+animColor+")";
    // orient the gradient along the visible segment (tail → head) and tint to the current color
    let a=path.getPointAtLength(tail),b=path.getPointAtLength(head);
    if(a.x===b.x&&a.y===b.y)b=path.getPointAtLength(Math.min(L,head+0.5));
    const g=e.pulseGrad;
    g.setAttribute("x1",a.x);g.setAttribute("y1",a.y);g.setAttribute("x2",b.x);g.setAttribute("y2",b.y);
    for(let k=0;k<g.childNodes.length;k++)g.childNodes[k].setAttribute("stop-color",animColor);
  }
  function setPlayBtn(on){const b=document.getElementById("playBtn");
    if(b){b.classList.toggle("on",on);b.textContent=on?"⏹ 정지":"▶ 재생";}}
  function stopAnim(){if(animState){cancelAnimationFrame(animState.raf);animState=null;}clearPulses();setPlayBtn(false);}
  function playAnim(){
    stopAnim();
    const live=edges.filter(e=>e.el.style.display!=="none");   // ignore tag-hidden edges
    if(!live.length){toast("재생할 흐름선이 없습니다");return;}
    const orders=[...new Set(live.map(e=>e.order||1))].sort((a,b)=>a-b);
    const total=orders.length*ANIM_STEP,t0=performance.now();let cur=-1;
    animState={raf:0};
    function frame(now){
      let el=now-t0;
      if(animLoop)el%=total; else if(el>=total){stopAnim();return;}
      const gi=Math.min(orders.length-1,Math.floor(el/ANIM_STEP));
      if(gi!==cur){clearPulses();cur=gi;}
      const u=(el-gi*ANIM_STEP)/ANIM_STEP;
      live.filter(e=>(e.order||1)===orders[gi]).forEach(e=>drawPulse(e,u));
      animState.raf=requestAnimationFrame(frame);
    }
    setPlayBtn(true);animState.raf=requestAnimationFrame(frame);
  }
  function togglePlay(){if(animState)stopAnim();else playAnim();}
  function toggleLoop(){animLoop=!animLoop;
    const b=document.getElementById("loopBtn");if(b)b.classList.toggle("on",animLoop);
    toast(animLoop?"반복 재생 켜짐":"반복 재생 꺼짐");}

  // ---------- edge tags (show / hide flow lines by tag) ----------
  let activeTag=null;
  function allTags(){return [...new Set(edges.flatMap(e=>e.tags||[]))].sort((a,b)=>a.localeCompare(b));}
  function applyTagFilter(){
    edges.forEach(e=>{const ok=!activeTag||(e.tags&&e.tags.includes(activeTag));
      e.el.style.display=ok?"":"none";});
    renderTagBar();
  }
  function renderTagBar(){
    const bar=document.getElementById("tagBar");if(!bar)return;
    const tags=allTags();
    if(activeTag&&!tags.includes(activeTag))activeTag=null;
    if(!tags.length){bar.style.display="none";bar.innerHTML="";return;}
    bar.style.display="flex";bar.innerHTML="";
    const mk=(label,tag)=>{const b=document.createElement("button");
      b.className="tag-btn"+(((tag===null&&!activeTag)||activeTag===tag)?" on":"");
      b.textContent=label;
      b.addEventListener("click",()=>{activeTag=(tag===null)?null:(activeTag===tag?null:tag);
        stopAnim();applyTagFilter();});
      return b;};
    bar.appendChild(mk("전체",null));
    tags.forEach(t=>bar.appendChild(mk(t,t)));
  }

  // ---------- image input: paste / drop anywhere on the canvas ----------
  function fileToNode(file,x,y){
    if(!file||(file.type.indexOf("image")!==0&&!/\.svg$/i.test(file.name)))return;
    const rd=new FileReader();rd.onload=()=>{const n=addImageNode(rd.result,x,y,file.name?file.name.replace(/\.[^.]+$/,""):"");selectNode(n);};
    rd.readAsDataURL(file);
  }
  document.addEventListener("paste",ev=>{
    if(isTyping(ev.target))return;
    const items=(ev.clipboardData&&ev.clipboardData.items)||[];
    for(const it of items){if(it.type&&it.type.indexOf("image")===0){
      const f=it.getAsFile();if(f){ev.preventDefault();fileToNode(f);}return;}}
  });
  canvasWrap.addEventListener("dragover",ev=>{
    if(ev.dataTransfer&&Array.from(ev.dataTransfer.types||[]).includes("Files"))ev.preventDefault();});
  canvasWrap.addEventListener("drop",ev=>{
    const files=ev.dataTransfer&&ev.dataTransfer.files;if(!files||!files.length)return;
    const img=Array.from(files).find(f=>f.type.indexOf("image")===0||/\.svg$/i.test(f.name));
    if(!img)return;ev.preventDefault();const p=cursorPt(ev);fileToNode(img,p.x,p.y);});

  // ---------- icon library (built-in pack + imported SVG/PNG — e.g. official AWS icons) ----------
  const LS_ICONS="flowcanvas.icons";
  let iconList=[];      // user-imported {name, uri} (persisted in localStorage)
  let builtinIcons=[];  // shipped with the app via aws-icons.js (window.FLOWCANVAS_ICONS)
  const MY_CAT="내 아이콘";
  function toDataURI(svg){return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));}
  // ---- Korean search keywords (icon names are English, so index Korean aliases too) ----
  const CAT_KO={
    "Analytics":"분석 데이터","App-Integration":"통합 메시징 연동","Artificial-Intelligence":"인공지능 AI 머신러닝",
    "Blockchain":"블록체인","Business-Applications":"비즈니스 업무","Cloud-Financial-Management":"비용 요금 재무 예산",
    "Compute":"컴퓨팅 서버 연산","Containers":"컨테이너 쿠버네티스","Customer-Enablement":"고객 지원",
    "Database":"데이터베이스 디비","Developer-Tools":"개발 도구 개발자","End-User-Computing":"데스크톱 가상데스크톱",
    "Front-End-Web-Mobile":"프론트엔드 웹 모바일","Games":"게임","General-Icons":"일반",
    "Internet-of-Things":"사물인터넷 아이오티","Management-Governance":"관리 거버넌스 운영 모니터링",
    "Media-Services":"미디어 영상","Migration-Modernization":"마이그레이션 이전 현대화",
    "Networking-Content-Delivery":"네트워크 네트워킹 콘텐츠전송","Quantum-Technologies":"양자","Satellite":"위성",
    "Security-Identity-Compliance":"보안 인증 권한 규정 준수","Storage":"스토리지 저장 저장소",
    "_Groups":"그룹 영역 경계","_Categories":"카테고리"};
  const SVC_KO=[
    [/EC2|Elastic Compute/i,"가상서버 인스턴스 컴퓨팅"],[/Lambda/i,"람다 서버리스 함수"],
    [/Simple Storage|\bS3\b/i,"에스쓰리 스토리지 버킷 저장소"],[/Aurora/i,"오로라 데이터베이스"],
    [/RDS|Relational Database/i,"관계형 데이터베이스"],[/DynamoDB/i,"다이나모디비 NoSQL"],
    [/ElastiCache/i,"캐시 캐싱"],[/Redshift/i,"레드시프트 데이터웨어하우스"],
    [/Virtual Private Cloud|VPC/i,"가상 네트워크 브이피씨"],[/CloudFront/i,"클라우드프론트 콘텐츠전송 CDN"],
    [/Route.?53/i,"라우트53 도메인 DNS"],[/API Gateway/i,"에이피아이 게이트웨이"],
    [/Load Balanc/i,"로드밸런서 부하분산"],[/Simple Notification|SNS/i,"알림 푸시"],
    [/Simple Queue|SQS/i,"큐 대기열 메시지"],[/Simple Email|SES/i,"이메일 메일"],
    [/Identity and Access|IAM/i,"권한 인증 계정 아이엠"],[/Cognito/i,"인증 로그인 사용자풀"],
    [/Key Management|KMS/i,"키 암호화"],[/Secrets Manager/i,"시크릿 비밀"],[/WAF/i,"웹방화벽 방화벽"],
    [/Shield/i,"디도스 보호"],[/GuardDuty/i,"위협탐지"],[/CloudWatch/i,"모니터링 로그 지표"],
    [/CloudTrail/i,"감사 로그"],[/CloudFormation/i,"인프라 스택"],[/Elastic Kubernetes|EKS/i,"쿠버네티스 컨테이너"],
    [/Elastic Container Service|ECS/i,"컨테이너"],[/Fargate/i,"서버리스 컨테이너"],
    [/Container Registry|ECR/i,"컨테이너 레지스트리"],[/SageMaker/i,"머신러닝 세이지메이커"],
    [/Bedrock/i,"생성형 인공지능"],[/Step Functions/i,"워크플로 상태머신"],[/EventBridge/i,"이벤트"],
    [/Kinesis/i,"스트리밍 실시간"],[/Glue/i,"이티엘 데이터"],[/Athena/i,"쿼리 분석"],
    [/EMR/i,"빅데이터 하둡 스파크"],[/QuickSight/i,"시각화 대시보드"],[/Beanstalk/i,"배포"],
    [/CodePipeline|CodeBuild|CodeDeploy|CodeCommit|CodeCatalyst/i,"배포 파이프라인 시아이 시디"],
    [/Amplify/i,"프론트엔드 배포"],[/Elastic File System|EFS/i,"파일 스토리지"],
    [/Elastic Block Store|EBS/i,"블록 스토리지 볼륨 디스크"],[/Glacier/i,"아카이브 백업"],
    [/Backup/i,"백업"],[/Snowball|Snow/i,"데이터전송"],[/Direct Connect/i,"전용선"],
    [/Transit Gateway/i,"전송 게이트웨이"],[/Systems Manager/i,"시스템관리"],
    [/Organizations/i,"조직 계정관리"],[/Cost Explorer|Budgets|Billing/i,"비용 예산 요금"]];
  function kwFor(name,cat){
    const base=cat.indexOf("Res-")===0?cat.slice(4):cat;
    let s=name+" "+base.replace(/-/g," ")+" "+(CAT_KO[base]||"");
    for(const kv of SVC_KO){if(kv[0].test(name))s+=" "+kv[1];}
    return s.toLowerCase();
  }
  function loadBuiltinIcons(){
    const arr=(window.FLOWCANVAS_ICONS||[]);
    builtinIcons=arr.map(e=>{const cat=e.cat||"기타";
      return {name:e.name,cat,uri:e.uri||toDataURI(e.svg),builtin:true,_kw:kwFor(e.name,cat)};});
  }
  function loadIcons(){try{const j=Y.load(localStorage.getItem(LS_ICONS));if(Array.isArray(j))iconList=j;}catch(e){}}
  // human-readable category label
  function catLabel(cat){
    if(cat===MY_CAT)return "★ 내 아이콘";
    if(cat==="_Groups")return "그룹 (Group)";
    if(cat==="_Categories")return "카테고리 타일";
    if(cat==="General-Icons"||cat==="Res-General-Icons")return "일반";
    if(cat.indexOf("Res-")===0)return "리소스 · "+cat.slice(4).replace(/-/g," ");
    return cat.replace(/-/g," ");
  }
  // sort key: 내 아이콘 → 서비스 → 리소스 → 그룹/카테고리
  function catRank(cat){
    if(cat===MY_CAT)return 0;
    if(cat==="_Groups"||cat==="_Categories")return 3;
    if(cat.indexOf("Res-")===0)return 2;
    return 1;
  }
  function allIcons(){return builtinIcons.concat(iconList.map(x=>({name:x.name,uri:x.uri,cat:MY_CAT,ref:x,_kw:(x.name+" "+MY_CAT).toLowerCase()})));}
  function saveIcons(){try{localStorage.setItem(LS_ICONS,Y.dump(iconList));}
    catch(e){toast("아이콘 저장 공간이 부족합니다");}}
  function importIcons(files){
    const arr=Array.from(files||[]);let pending=arr.length,added=0;
    if(!pending)return;
    arr.forEach(f=>{
      if(f.type.indexOf("image")!==0&&!/\.svg$/i.test(f.name)){if(--pending<=0)finish();return;}
      const rd=new FileReader();
      rd.onload=()=>{iconList.push({name:f.name.replace(/\.[^.]+$/,""),uri:rd.result});added++;
        if(--pending<=0)finish();};
      rd.onerror=()=>{if(--pending<=0)finish();};
      rd.readAsDataURL(f);
    });
    function finish(){saveIcons();populateIconCats();
      const sel=document.getElementById("iconCat");if(sel&&iconList.length)sel.value=MY_CAT;   // jump to my icons
      renderIconGrid();toast(added+"개 아이콘 추가됨");}
  }
  // fill the category dropdown (내 아이콘 first, then services, resources, groups)
  function populateIconCats(){
    const sel=document.getElementById("iconCat");if(!sel)return;
    const prev=sel.value;
    const cats=[...new Set(allIcons().map(ic=>ic.cat))]
      .sort((a,b)=>catRank(a)-catRank(b)||catLabel(a).localeCompare(catLabel(b)));
    sel.innerHTML="";
    cats.forEach(c=>{const o=document.createElement("option");o.value=c;o.textContent=catLabel(c);sel.appendChild(o);});
    if(cats.includes(prev))sel.value=prev;
    else if(cats.includes(MY_CAT))sel.value=MY_CAT;
  }
  function renderIconGrid(){
    const grid=document.getElementById("iconGrid");if(!grid)return;
    const q=(document.getElementById("iconSearch").value||"").trim().toLowerCase();
    const sel=document.getElementById("iconCat");
    const catSel=sel?sel.value:"";
    const all=allIcons();
    // with a query → search across everything; otherwise show the selected category
    const list=q ? all.filter(ic=>(ic._kw||ic.name.toLowerCase()).includes(q))
                 : all.filter(ic=>ic.cat===catSel);
    grid.innerHTML="";
    if(sel)sel.style.opacity=q?".5":"1";                 // dim the category picker while searching
    if(!list.length){grid.innerHTML='<div class="icon-empty">'+(q?"검색 결과가 없습니다.":"이 분류에 아이콘이 없습니다.")+'</div>';return;}
    const frag=document.createDocumentFragment();
    list.slice(0,400).forEach(ic=>{
      const cell=document.createElement("button");cell.className="icon-cell";cell.title=ic.name;
      const im=document.createElement("img");im.src=ic.uri;im.alt=ic.name;im.draggable=false;im.loading="lazy";
      const cap=document.createElement("span");cap.textContent=ic.name;
      cell.appendChild(im);cell.appendChild(cap);
      cell.addEventListener("mousedown",ev=>{if(ev.button!==0)return;ev.preventDefault();startIconDrag(ic,ev);});
      if(ic.cat===MY_CAT)cell.addEventListener("contextmenu",ev=>{ev.preventDefault();
        iconList=iconList.filter(x=>x!==ic.ref);saveIcons();populateIconCats();renderIconGrid();});
      frag.appendChild(cell);
    });
    grid.appendChild(frag);
    if(list.length>400){const m=document.createElement("div");m.className="icon-empty";
      m.textContent=list.length+"개 중 400개 표시 — 검색으로 좁혀보세요.";grid.appendChild(m);}
  }
  // drag an icon from the panel onto the canvas (click without moving = drop at viewport center)
  let iconDrag=null;
  function moveIconGhost(x,y){if(iconDrag){iconDrag.ghost.style.left=(x-24)+"px";iconDrag.ghost.style.top=(y-24)+"px";}}
  function startIconDrag(ic,ev){
    const ghost=document.createElement("img");ghost.src=ic.uri;ghost.className="drag-ghost-img";
    document.body.appendChild(ghost);
    iconDrag={ic,ghost,sx:ev.clientX,sy:ev.clientY,moved:false};
    moveIconGhost(ev.clientX,ev.clientY);
  }
  window.addEventListener("mousemove",ev=>{
    if(!iconDrag)return;
    if(Math.abs(ev.clientX-iconDrag.sx)+Math.abs(ev.clientY-iconDrag.sy)>3)iconDrag.moved=true;
    moveIconGhost(ev.clientX,ev.clientY);
  });
  window.addEventListener("mouseup",ev=>{
    if(!iconDrag)return;const d=iconDrag;iconDrag=null;d.ghost.remove();
    const r=canvasWrap.getBoundingClientRect();
    const inside=ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom;
    let x,y;
    if(inside){const p=cursorPt(ev);x=p.x;y=p.y;}else{x=view.x+view.w/2;y=view.y+view.h/2;}
    const n=addImageNode(d.ic.uri,x,y,d.ic.name);selectNode(n);
  });
  function toggleIconPanel(){document.getElementById("app").classList.toggle("icons-hidden");saveSettings();}

  // ---------- user guide (renders bundled GUIDE.md markdown into a modal) ----------
  function mdToHtml(md){
    const esc=s=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const inline=t=>esc(t)
      .replace(/`([^`]+)`/g,"<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    const lines=String(md||"").replace(/\r/g,"").split("\n");
    let html="",i=0,ul=false,ol=false;
    const closeLists=()=>{if(ul){html+="</ul>";ul=false;}if(ol){html+="</ol>";ol=false;}};
    while(i<lines.length){
      const ln=lines[i];let m;
      if(/^```/.test(ln)){closeLists();i++;let code="";
        while(i<lines.length&&!/^```/.test(lines[i])){code+=lines[i]+"\n";i++;}i++;
        html+="<pre><code>"+esc(code)+"</code></pre>";continue;}
      if(/^\s*$/.test(ln)){closeLists();i++;continue;}
      if(m=ln.match(/^(#{1,4})\s+(.*)$/)){closeLists();const lv=m[1].length;
        const id=m[2].replace(/[*`]/g,"").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1")
          .trim().toLowerCase().replace(/[^\w가-힣 -]/g,"").replace(/\s+/g,"-");
        html+="<h"+lv+' id="'+id+'">'+inline(m[2])+"</h"+lv+">";i++;continue;}
      if(/^---+$/.test(ln.trim())){closeLists();html+="<hr>";i++;continue;}
      if(/^\s*>\s?/.test(ln)){closeLists();html+="<blockquote>"+inline(ln.replace(/^\s*>\s?/,""))+"</blockquote>";i++;continue;}
      if(m=ln.match(/^\s*[-*]\s+(.*)$/)){if(!ul){closeLists();html+="<ul>";ul=true;}html+="<li>"+inline(m[1])+"</li>";i++;continue;}
      if(m=ln.match(/^\s*\d+\.\s+(.*)$/)){if(!ol){closeLists();html+="<ol>";ol=true;}html+="<li>"+inline(m[1])+"</li>";i++;continue;}
      closeLists();html+="<p>"+inline(ln)+"</p>";i++;
    }
    closeLists();return html;
  }
  let guideRendered=false;
  function openGuide(){
    const body=document.getElementById("guideBody");
    if(body&&!guideRendered){body.innerHTML=mdToHtml(window.FLOWCANVAS_GUIDE||"# 가이드를 불러올 수 없습니다");guideRendered=true;}
    document.getElementById("guideModal").style.display="flex";
  }
  function closeGuide(){document.getElementById("guideModal").style.display="none";}

  // ---------- save / load files ----------
  // ask for a file name via the dialog; extension is fixed (appended), cb receives "name.ext"
  function askFilename(defName,ext,cb){
    askText("파일 이름을 입력하세요 (."+ext+" 는 자동으로 붙습니다):",defName,val=>{
      const name=String(val==null?"":val).trim()
        .replace(/[\\/:*?"<>|]/g,"_")                             // strip illegal chars
        .replace(new RegExp("\\."+ext+"$","i"),"");               // drop a typed-in extension
      cb((name||defName)+"."+ext);
    });
  }
  function download(blob,filename){
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);
    a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }
  function saveFile(){
    askFilename("flowcanvas-diagram","yaml",fn=>{
      download(new Blob([Y.dump(serialize())],{type:"text/yaml"}),fn);
      toast("저장 완료: "+fn);});}
  function openFile(){document.getElementById("fileInput").click();}
  function handleFile(file){
    const rd=new FileReader();
    rd.onload=()=>{try{const s=Y.load(rd.result);loadState(s);fitView();toast("불러오기 완료");}
      catch(e){toast("파일을 읽을 수 없습니다");}};
    rd.readAsText(file);}

  // ---------- shortcuts / settings ----------
  const LS_SETTINGS="flowcanvas.settings";
  const ACTIONS=[
    {id:"delete",label:"삭제"},{id:"undo",label:"실행취소"},{id:"redo",label:"다시실행"},
    {id:"curve",label:"곡선/직선 전환"},{id:"fit",label:"화면 맞춤"},
    {id:"save",label:"저장"},{id:"open",label:"불러오기"},{id:"deselect",label:"선택 해제"}];
  const DEFAULT_KEYS={delete:["Delete","Backspace"],undo:["Mod+Z"],redo:["Mod+Shift+Z","Mod+Y"],
    curve:["Mod+E"],fit:["F"],save:["Mod+S"],open:["Mod+O"],deselect:["Escape"]};
  let keys=JSON.parse(JSON.stringify(DEFAULT_KEYS));
  let capturing=null;
  function isMac(){return /Mac|iPhone|iPad/.test((navigator.platform||"")+(navigator.userAgent||""));}
  let iconsHidden=false;   // left icon panel collapsed state (persisted)
  function loadSettings(){try{const j=Y.load(localStorage.getItem(LS_SETTINGS));
    if(j&&j.shortcuts){for(const a in DEFAULT_KEYS)keys[a]=j.shortcuts[a]||DEFAULT_KEYS[a];}
    if(j&&typeof j.iconsHidden==="boolean")iconsHidden=j.iconsHidden;}catch(e){}}
  function saveSettings(){try{const hidden=document.getElementById("app").classList.contains("icons-hidden");
    localStorage.setItem(LS_SETTINGS,Y.dump({shortcuts:keys,iconsHidden:hidden}));}catch(e){}}
  function comboFromEvent(ev){
    const parts=[];
    if(ev.metaKey||ev.ctrlKey)parts.push("Mod");
    if(ev.shiftKey)parts.push("Shift");
    if(ev.altKey)parts.push("Alt");
    let k=ev.key;
    if(k===" ")k="Space";else if(k.length===1)k=k.toUpperCase();
    parts.push(k);return parts.join("+");}
  function actionForCombo(combo){for(const a in keys){if((keys[a]||[]).includes(combo))return a;}return null;}
  function runAction(a){({delete:deleteSelected,undo,redo,curve:toggleCurve,fit:fitView,
    save:saveFile,open:openFile,deselect:clearSel}[a]||(()=>{}))();}
  function prettyCombo(c){if(!c)return "—";return c.replace("Mod",isMac()?"⌘":"Ctrl")
    .replace("Space","스페이스").split("+").join(" + ");}
  function renderKeyList(){
    const box=document.getElementById("keyList");box.innerHTML="";
    ACTIONS.forEach(a=>{
      const row=document.createElement("div");row.className="key-row";
      const lbl=document.createElement("span");lbl.textContent=a.label;
      const btn=document.createElement("button");
      btn.className="key-btn"+(capturing===a.id?" capturing":"");
      btn.textContent=capturing===a.id?"키를 누르세요…":prettyCombo((keys[a.id]||[])[0]);
      btn.addEventListener("click",()=>{capturing=a.id;renderKeyList();});
      row.appendChild(lbl);row.appendChild(btn);box.appendChild(row);});}
  function openSettings(){capturing=null;renderKeyList();document.getElementById("settingsModal").style.display="flex";}
  function closeSettings(){capturing=null;document.getElementById("settingsModal").style.display="none";}

  // ---------- toolbar wiring ----------
  document.getElementById("undoBtn").addEventListener("click",undo);
  document.getElementById("redoBtn").addEventListener("click",redo);
  document.getElementById("curveBtn").addEventListener("click",toggleCurve);
  // file menu: 저장/열기/PNG/설정/초기화 collapsed into one dropdown button
  function clearAll(){if(!nodes.length)return;
    askConfirm("모든 노드와 연결을 삭제할까요?",()=>{
      clearScene();nid=0;eid=0;gid=0;updateEmpty();sync();});}
  function showFileMenu(){
    const btn=document.getElementById("fileMenuBtn");const r=btn.getBoundingClientRect();
    openCtx(r.left,r.bottom+4,[
      {label:"💾 저장",action:saveFile},
      {label:"📂 열기",action:openFile},
      {label:"🖼 PNG 내보내기",action:exportPNG},
      {sep:true},
      {label:"⚙ 단축키 설정",action:openSettings},
      {sep:true},
      {label:"전체 초기화",danger:true,action:clearAll}]);
  }
  document.getElementById("fileMenuBtn").addEventListener("click",e=>{e.stopPropagation();showFileMenu();});
  document.getElementById("fileInput").addEventListener("change",e=>{
    if(e.target.files[0])handleFile(e.target.files[0]);e.target.value="";});
  document.getElementById("keyClose").addEventListener("click",closeSettings);
  document.getElementById("keyReset").addEventListener("click",()=>{
    keys=JSON.parse(JSON.stringify(DEFAULT_KEYS));saveSettings();renderKeyList();toast("기본값으로 복원");});
  document.getElementById("settingsModal").addEventListener("click",e=>{
    if(e.target.id==="settingsModal")closeSettings();});
  // hidden color pickers (triggered from the right-click menu)
  document.getElementById("colorPick").addEventListener("input",e=>applyColor(e.target.value));
  document.getElementById("strokePick").addEventListener("input",e=>applyStroke(e.target.value));
  document.getElementById("groupColorPick").addEventListener("input",e=>applyGroupColor(e.target.value));
  document.getElementById("bgBtn").addEventListener("click",toggleBg);
  document.getElementById("delBtn").addEventListener("click",deleteSelected);
  document.getElementById("fitBtn").addEventListener("click",fitView);
  document.getElementById("zoomIn").addEventListener("click",()=>zoomBy(0.8));
  document.getElementById("zoomOut").addEventListener("click",()=>zoomBy(1.25));
  document.getElementById("zoomLevel").addEventListener("click",resetZoom);
  document.getElementById("guideBtn").addEventListener("click",openGuide);
  document.getElementById("guideClose").addEventListener("click",closeGuide);
  document.getElementById("guideModal").addEventListener("click",e=>{if(e.target.id==="guideModal")closeGuide();});
  document.getElementById("playBtn").addEventListener("click",togglePlay);
  document.getElementById("loopBtn").addEventListener("click",toggleLoop);
  document.getElementById("orderBtn").addEventListener("click",toggleOrderBadges);
  document.getElementById("animPick").addEventListener("input",e=>applyAnimColor(e.target.value));
  document.getElementById("iconCollapse").addEventListener("click",toggleIconPanel);
  document.getElementById("iconShow").addEventListener("click",toggleIconPanel);
  document.getElementById("iconImport").addEventListener("click",()=>document.getElementById("iconInput").click());
  document.getElementById("iconInput").addEventListener("change",e=>{importIcons(e.target.files);e.target.value="";});
  document.getElementById("iconSearch").addEventListener("input",renderIconGrid);
  document.getElementById("iconCat").addEventListener("change",renderIconGrid);

  // ---------- marquee: drag on empty canvas to box-select nodes ----------
  let marquee=null,marqueeEl=null;
  svg.addEventListener("mousedown",ev=>{
    if(ev.button!==0||spaceDown)return;                   // left button only; space = pan
    if(ev.target!==svg&&ev.target.tagName!=="svg")return; // only on empty canvas
    clearSel();
    const s=cursorPt(ev);marquee={x0:s.x,y0:s.y,box:null};
    marqueeEl=document.createElementNS(SVGNS,"rect");marqueeEl.setAttribute("class","marquee");
    svg.appendChild(marqueeEl);
    window.addEventListener("mousemove",onMarqueeMove);
    window.addEventListener("mouseup",onMarqueeUp);
  });
  function onMarqueeMove(ev){
    if(!marquee)return;const p=cursorPt(ev);
    const x=Math.min(p.x,marquee.x0),y=Math.min(p.y,marquee.y0);
    const w=Math.abs(p.x-marquee.x0),h=Math.abs(p.y-marquee.y0);
    marquee.box={x,y,w,h};
    marqueeEl.setAttribute("x",x);marqueeEl.setAttribute("y",y);
    marqueeEl.setAttribute("width",w);marqueeEl.setAttribute("height",h);
  }
  function onMarqueeUp(){
    window.removeEventListener("mousemove",onMarqueeMove);
    window.removeEventListener("mouseup",onMarqueeUp);
    const b=marquee&&marquee.box;
    if(b&&(b.w>3||b.h>3)){                                // ignore tiny drags (treated as click)
      nodes.forEach(n=>{
        if(n.x+n.w/2>=b.x&&n.x-n.w/2<=b.x+b.w&&n.y+n.h/2>=b.y&&n.y-n.h/2<=b.y+b.h){
          selNodes.add(n.id);n.el.classList.add("sel");}});
      if(selNodes.size)toast(selNodes.size+"개 선택됨");
    }
    if(marqueeEl){marqueeEl.remove();marqueeEl=null;}marquee=null;
  }
  // ---------- Enter = edit the selected object's name/label ----------
  // diagram coords -> client(screen) coords, so the inline editor lands on the target
  function diagramToClient(x,y){const m=svg.getScreenCTM();
    return {x:m.a*x+m.c*y+m.e, y:m.b*x+m.d*y+m.f};}
  // open the inline editor for whatever is currently selected (node / edge / group)
  function editSelected(){
    if(inlineEl.style.display==="block")return;         // already editing
    if(selEdge!=null){                                  // edge → edit its label
      const e=edges.find(x=>x.id===selEdge);if(!e)return;
      const a=nodes.find(n=>n.id===e.from),b=nodes.find(n=>n.id===e.to);if(!a||!b)return;
      const p=diagramToClient((a.x+b.x)/2,(a.y+b.y)/2);
      openInline(p.x,p.y,e.label,v=>{e.label=v.trim();drawEdge(e);sync();});return;
    }
    if(selNodes.size===1){                              // single node → edit its name
      const n=nodes.find(x=>selNodes.has(x.id));if(!n)return;
      const p=diagramToClient(n.x,n.y);
      openInline(p.x,p.y,n.label,v=>{n.label=v.trim()||n.label;refreshNode(n);sync();});return;
    }
    if(selNodes.size>1){                                // selection equals a group's members → rename group
      const sg=subgraphs.find(g=>g.nodes.size===selNodes.size&&[...g.nodes].every(id=>selNodes.has(id)));
      if(sg&&sg.rectEl){
        const p=diagramToClient(+sg.rectEl.getAttribute("x")+12,+sg.rectEl.getAttribute("y")+16);
        renameGroupSg(sg,p.x,p.y);return;
      }
      toast("이름을 변경할 대상 하나만 선택하세요");
    }
  }
  function isTyping(t){return t&&(t.tagName==="INPUT"||t.tagName==="SELECT"||t.tagName==="TEXTAREA");}
  window.addEventListener("keydown",ev=>{
    // a dialog is open → only Esc (cancel) is handled here; input has its own handler
    if(dialogEl.style.display==="flex"){if(ev.key==="Escape")closeDialog(false);return;}
    // capturing a new shortcut in settings
    if(capturing){
      if(ev.key==="Escape"){capturing=null;renderKeyList();ev.preventDefault();return;}
      if(["Meta","Control","Shift","Alt"].includes(ev.key))return;
      keys[capturing]=[comboFromEvent(ev)];capturing=null;saveSettings();renderKeyList();
      ev.preventDefault();return;}
    // space = pan (fixed)
    if(ev.key===" "&&!isTyping(ev.target)){
      if(!spaceDown){spaceDown=true;canvasWrap.classList.add("pan-ready");}
      ev.preventDefault();return;}
    if(isTyping(ev.target))return;
    // Enter (no modifiers) = edit the selected object's name/label
    if(ev.key==="Enter"&&!ev.metaKey&&!ev.ctrlKey&&!ev.altKey){
      ev.preventDefault();editSelected();return;}
    const action=actionForCombo(comboFromEvent(ev));
    if(action){ev.preventDefault();runAction(action);}});
  window.addEventListener("keyup",ev=>{
    if(ev.key===" "){spaceDown=false;panning=null;
      canvasWrap.classList.remove("pan-ready","panning");}});
  window.addEventListener("blur",()=>{spaceDown=false;panning=null;
    canvasWrap.classList.remove("pan-ready","panning");});

  // ---------- init view + keep aspect on resize ----------
  initView();
  window.addEventListener("resize",()=>{
    const r=svg.getBoundingClientRect();
    if(r.width)view.h=view.w*(r.height/r.width);
    applyView();
  });

  // ---------- demo seed ----------
  function seedDefault(){
    const a=addNode("stadium",260,110,"시작");
    const b=addNode("diamond",260,250,"입력 확인");
    const c=addNode("rect",130,390,"처리");
    const d=addNode("stadium",400,390,"종료");
    addEdge(a.id,b.id,"");addEdge(b.id,c.id,"예");addEdge(b.id,d.id,"아니오");addEdge(c.id,d.id,"");
  }

  // ---------- startup: load settings + saved diagram (survives restart) ----------
  loadSettings();
  loadBuiltinIcons();
  loadIcons();
  if(iconsHidden)document.getElementById("app").classList.add("icons-hidden");
  populateIconCats();renderIconGrid();
  (function start(){
    let saved=null;try{saved=Y.load(localStorage.getItem(LS_DIAGRAM));}catch(e){}
    restoring=true;
    if(saved&&saved.nodes&&saved.nodes.length)loadState(saved);
    else seedDefault();
    restoring=false;
    clearSel();
    applyBg(bgColor);
    lastCommitted=snapshot();
    updateUndoBtns();
    sync();
    homeView();   // default zoom fixed at 100%
  })();
})();
