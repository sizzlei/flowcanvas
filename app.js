/*
 * FlowMaid — 애플리케이션 로직 (의존성 없는 순수 JS)
 *
 * 전체 구조 (아래 순서대로 정의됨):
 *   1. view          : viewBox 기반 팬/줌, 화면 맞춤(fitView)
 *   2. 상태          : nodes[], edges[], 선택(selNodes/selEdge)
 *   3. shape geometry: 도형 크기 계산, 텍스트 줄바꿈, 노드/엣지 렌더링
 *   4. selection     : 다중 노드 + 단일 엣지 선택
 *   5. interactions  : 노드 드래그(그룹 이동), 핸들 드래그 연결, 마퀴 선택
 *   6. CRUD          : addNode/addEdge/deleteSelected/applyColor
 *   7. mermaid code  : 편집 상태 → Mermaid 코드 생성(genCode)
 *   8. PNG export    : 현재 화면을 PNG로 내보내기
 *   9. serialize     : 다이어그램 직렬화 + 저장/불러오기
 *  10. history       : 실행취소/다시실행 + localStorage 자동저장
 *  11. shortcuts     : 설정 가능한 단축키(설정은 JSON으로 영속화)
 *  12. startup       : 저장본 복원 또는 예시 시드
 *
 * 저장 키: flowmaid.diagram(작업본), flowmaid.settings(단축키)
 */
(function(){
  "use strict";
  const SVGNS="http://www.w3.org/2000/svg";
  const svg=document.getElementById("svg");
  const gNodes=document.getElementById("nodes");
  const gEdges=document.getElementById("edges");
  const tempEdge=document.getElementById("tempEdge");
  const emptyHint=document.getElementById("emptyHint");
  const codeEl=document.getElementById("code");
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
  function fitView(){
    if(!nodes.length){initView();return;}
    let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    nodes.forEach(n=>{minX=Math.min(minX,n.x-n.w/2);maxX=Math.max(maxX,n.x+n.w/2);
      minY=Math.min(minY,n.y-n.h/2);maxY=Math.max(maxY,n.y+n.h/2);});
    const pad=70;minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;
    const bw=maxX-minX,bh=maxY-minY;
    const r=svg.getBoundingClientRect();const aspect=(r.width/r.height)||1.43;
    let w=bw,h=bh;
    if(w/h>aspect)h=w/aspect;else w=h*aspect;
    view.w=w;view.h=h;view.x=minX-(w-bw)/2;view.y=minY-(h-bh)/2;applyView();
  }
  let spaceDown=false, panning=null;

  const DEFAULT_FILL="#2f2748", DEFAULT_STROKE="#8b5cf6";
  let nodes=[]; // {id,label,shape,x,y,w,h,fill,stroke,bstyle,el,shapeEl,textEl,handles[],decor[]}
  let edges=[]; // {id,from,to,label,line,head,el,pathEl,hitEl,textEl,bgEl}
  let subgraphs=[]; // {id,title,nodes:Set,el,rectEl,titleEl}
  let nid=0, eid=0, gid=0;
  let connecting=null; // {source, }
  let edgeCurve=false;
  let bgColor="#0d0b13"; // canvas background color
  let edgeDefaults={line:"solid",head:"arrow"}; // style applied to new edges
  const NODE_W=120, NODE_H=54;
  const dirEl=document.getElementById("dir");
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
  canvasWrap.addEventListener("contextmenu",ev=>{
    ev.preventDefault();closeCtx();
    const node=nodeUnder(ev);
    const edgeEl=ev.target.closest&&ev.target.closest(".edge");
    const groupEl=ev.target.closest&&ev.target.closest(".subgraph");
    let items;
    if(node){
      if(!selNodes.has(node.id))selectNode(node);
      items=[
        {label:"이름 변경",action:()=>{if(selNodes.size===1){const n=nodes.find(x=>selNodes.has(x.id));
          openInline(ev.clientX,ev.clientY,n.label,v=>{n.label=v.trim()||n.label;refreshNode(n);genCode();});}
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
        {label:"라벨 편집",action:()=>{if(e)openInline(ev.clientX,ev.clientY,e.label,
          v=>{e.label=v.trim();drawEdge(e);genCode();});}},
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
        {sep:true},
        {label:"삭제",danger:true,action:deleteSelected}];
    }else if(groupEl){
      const sg=subgraphs.find(x=>x.el===groupEl);
      if(sg){clearSel();[...sg.nodes].forEach(id=>{const n=nodes.find(y=>y.id===id);
        if(n){selNodes.add(id);n.el.classList.add("sel");}});}
      items=[
        {label:"이름 변경",action:()=>sg&&renameGroupSg(sg,ev.clientX,ev.clientY)},
        {label:"그룹 색",swatches:["#8b5cf6"].concat(FILL_SWATCHES),onPick:applyGroupColor},
        {label:"그룹 색 직접…",action:()=>document.getElementById("groupColorPick").click()},
        {sep:true},
        {label:"그룹 해제",action:ungroup}];
    }else{
      const p=cursorPt(ev);
      const shapes=[["둥근 사각형","round"],["사각형","rect"],["스타디움","stadium"],["마름모","diamond"],
        ["원","circle"],["육각형","hexagon"],["원통(DB)","cylinder"],["서브루틴","subroutine"]];
      items=[
        {label:"노드 추가",sub:shapes.map(s=>({label:s[0],action:()=>{const n=addNode(s[1],p.x,p.y);selectNode(n);}}))},
        {label:"화면 맞춤",action:fitView},
        {label:"배경색 직접…",action:()=>document.getElementById("bgPick").click()}];
    }
    openCtx(ev.clientX,ev.clientY,items);
  });

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
  function drawShape(n){
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
  function drawEdge(e){
    const a=nodes.find(n=>n.id===e.from),b=nodes.find(n=>n.id===e.to);if(!a||!b)return;
    const p1=anchorPoint(a,b.x,b.y),p2=anchorPoint(b,a.x,a.y);
    let mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2,d;
    if(edgeCurve){
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
    if(e.label){
      e.textEl.setAttribute("x",mx);e.textEl.setAttribute("y",my-6);e.textEl.textContent=e.label;
      e.bgEl.setAttribute("x",mx-e.label.length*3.7-4);e.bgEl.setAttribute("y",my-18);
      e.bgEl.setAttribute("width",e.label.length*7.4+8);e.bgEl.setAttribute("height",16);
      e.bgEl.style.display="";e.textEl.style.display="";
    }else{e.bgEl.style.display="none";e.textEl.style.display="none";}
  }
  function renderEdge(e){
    const g=document.createElementNS(SVGNS,"g");g.setAttribute("class","edge");g.dataset.id=e.id;
    const path=document.createElementNS(SVGNS,"path");path.setAttribute("class","line");
    const hit=document.createElementNS(SVGNS,"path");hit.setAttribute("class","hit");
    const bg=document.createElementNS(SVGNS,"rect");bg.setAttribute("fill","#120f1c");bg.setAttribute("rx",3);
    const text=document.createElementNS(SVGNS,"text");
    g.appendChild(path);g.appendChild(bg);g.appendChild(text);g.appendChild(hit);
    gEdges.appendChild(g);
    e.el=g;e.pathEl=path;e.hitEl=hit;e.textEl=text;e.bgEl=bg;
    hit.addEventListener("click",ev=>{ev.stopPropagation();selectEdge(e);});
    hit.addEventListener("dblclick",ev=>{ev.stopPropagation();
      openInline(ev.clientX,ev.clientY,e.label,v=>{e.label=v.trim();drawEdge(e);genCode();});});
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
    document.getElementById("colorPick").value=rgbToHex(n.fill||DEFAULT_FILL);
    document.getElementById("strokePick").value=rgbToHex(n.stroke||DEFAULT_STROKE);
    document.getElementById("strokeStyle").value=n.bstyle||"solid";
  }
  function selectEdge(e){clearSel();selEdge=e.id;e.el.classList.add("sel");
    document.getElementById("edgeLine").value=e.line||"solid";
    document.getElementById("edgeHead").value=e.head||"arrow";}
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
    window.addEventListener("mouseup",()=>{if(dragging){dragging=false;n.el.style.cursor="grab";if(moved)genCode();}});
    n.el.addEventListener("dblclick",ev=>{ev.stopPropagation();
      openInline(ev.clientX,ev.clientY,n.label,v=>{
        n.label=v.trim()||n.label;refreshNode(n);genCode();});});
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
    nodes.push(n);renderNode(n);updateEmpty();genCode();return n;
  }
  function addEdge(from,to,label,style){
    if(edges.some(e=>e.from===from&&e.to===to)){toast("이미 연결됨");return;}
    const e={id:++eid,from,to,label:label||"",
      line:(style&&style.line)||edgeDefaults.line,head:(style&&style.head)||edgeDefaults.head};
    edges.push(e);renderEdge(e);genCode();
  }
  function deleteSelected(){
    if(selEdge!=null){                               // delete the selected edge
      const e=edges.find(x=>x.id===selEdge);
      if(e){e.el.remove();edges=edges.filter(x=>x.id!==e.id);}
      selEdge=null;updateEmpty();genCode();return;
    }
    if(!selNodes.size){toast("삭제할 대상을 선택하세요");return;}
    const ids=new Set(selNodes);                     // delete all selected nodes + their edges
    edges.filter(e=>ids.has(e.from)||ids.has(e.to)).forEach(e=>e.el.remove());
    edges=edges.filter(e=>!ids.has(e.from)&&!ids.has(e.to));
    nodes.filter(n=>ids.has(n.id)).forEach(n=>n.el.remove());
    nodes=nodes.filter(n=>!ids.has(n.id));
    subgraphs.forEach(sg=>ids.forEach(id=>sg.nodes.delete(id)));
    selNodes.clear();updateEmpty();renderGroups();genCode();
  }
  function applyColor(hex){                           // recolor every selected node's fill
    if(!selNodes.size){toast("색을 바꿀 노드를 먼저 선택하세요");return;}
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);
      if(n){n.fill=hex;n.shapeEl.setAttribute("fill",hex);}});
    genCode();
  }
  function applyStroke(hex){                          // recolor every selected node's border
    if(!selNodes.size){toast("테두리를 바꿀 노드를 먼저 선택하세요");return;}
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);if(n){n.stroke=hex;drawShape(n);}});
    genCode();
  }
  function applyBstyle(style){                        // border style: solid/dashed/thick
    if(!selNodes.size){toast("테두리를 바꿀 노드를 먼저 선택하세요");return;}
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);if(n){n.bstyle=style;drawShape(n);}});
    genCode();
  }
  // apply line/head to the selected edge (and remember as default for new edges)
  function applyEdgeStyle(part,val){
    edgeDefaults[part]=val;
    if(selEdge!=null){const e=edges.find(x=>x.id===selEdge);if(e){e[part]=val;drawEdge(e);genCode();}}
  }

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
    renderGroups();genCode();toast("그룹으로 묶음");
  }
  function ungroup(){
    if(!selNodes.size){toast("해제할 그룹의 노드를 선택하세요");return;}
    let removed=0;
    subgraphs=subgraphs.filter(sg=>{
      const hit=[...selNodes].some(id=>sg.nodes.has(id));
      if(hit){sg.el.remove();removed++;return false;}return true;});
    if(removed){genCode();toast("그룹 해제");}else toast("선택 항목이 속한 그룹이 없습니다");
  }
  // groups that contain any currently selected node
  function selectedGroups(){return subgraphs.filter(sg=>[...selNodes].some(id=>sg.nodes.has(id)));}
  function applyGroupColor(hex){
    const gs=selectedGroups();
    if(!gs.length){toast("색을 바꿀 그룹의 노드를 선택하세요");return;}
    gs.forEach(sg=>sg.color=hex);renderGroups();genCode();
  }
  function updateEmpty(){emptyHint.style.display=nodes.length?"none":"";}

  // ---------- mermaid code ----------
  const wrap={rect:['[',']'],round:['(',')'],stadium:['([','])'],diamond:['{','}'],
    circle:['((','))'],hexagon:['{{','}}'],cylinder:['[(',')]'],subroutine:['[[',']]']};
  function san(t){return '"'+String(t==null?"":t).replace(/"/g,"'").replace(/\n/g," ")+'"';}
  function nodeDef(n){const w=wrap[n.shape]||wrap.round;return "N"+n.id+w[0]+san(n.label)+w[1];}
  // connector token for a given edge line + head
  const CONN={
    solid:{arrow:"-->",open:"---",circle:"--o",cross:"--x",bi:"<-->"},
    dotted:{arrow:"-.->",open:"-.-",circle:"-.-o",cross:"-.-x",bi:"<-.->"},
    thick:{arrow:"==>",open:"===",circle:"==o",cross:"==x",bi:"<==>"}};
  function edgeConn(e){return (CONN[e.line]&&CONN[e.line][e.head])||"-->";}
  // classDef signature for a node's custom style (null = default, no style needed)
  function nodeStyleSig(n){
    const fill=n.fill||DEFAULT_FILL,stroke=n.stroke||DEFAULT_STROKE,b=n.bstyle||"solid";
    if(fill===DEFAULT_FILL&&stroke===DEFAULT_STROKE&&b==="solid")return null;
    let s="fill:"+fill+",stroke:"+stroke+",stroke-width:"+(b==="thick"?"3px":"1px")+",color:#f2ecff";
    if(b==="dashed")s+=",stroke-dasharray:5 3";
    return s;
  }
  function genCode(){
    let out="";
    if(edgeCurve)out+="%%{init: {'flowchart': {'curve': 'basis'}}}%%\n";
    out+="flowchart "+dirEl.value+"\n";
    // subgraphs first (their member node definitions live inside the block)
    const inGroup=new Set();
    subgraphs.forEach(sg=>{
      const mem=[...sg.nodes].filter(id=>nodes.some(n=>n.id===id));
      if(!mem.length)return;
      out+="    subgraph SG"+sg.id+"["+san(sg.title)+"]\n";
      mem.forEach(id=>{inGroup.add(id);out+="        "+nodeDef(nodes.find(n=>n.id===id))+"\n";});
      out+="    end\n";
    });
    // free nodes (not in any subgraph)
    nodes.forEach(n=>{if(!inGroup.has(n.id))out+="    "+nodeDef(n)+"\n";});
    // edges
    edges.forEach(e=>{const c=edgeConn(e);
      out+= e.label ? "    N"+e.from+" "+c+"|"+san(e.label)+"| N"+e.to+"\n"
                    : "    N"+e.from+" "+c+" N"+e.to+"\n";});
    // classDef + class (group nodes that share the same custom style → reusable class)
    const sigMap=new Map();let ci=0;
    nodes.forEach(n=>{const sig=nodeStyleSig(n);if(!sig)return;
      if(!sigMap.has(sig))sigMap.set(sig,{cls:"fm"+(++ci),ids:[]});
      sigMap.get(sig).ids.push("N"+n.id);});
    if(sigMap.size){out+="\n";
      sigMap.forEach((v,sig)=>{out+="    classDef "+v.cls+" "+sig+"\n";});
      sigMap.forEach(v=>{out+="    class "+v.ids.join(",")+" "+v.cls+"\n";});}
    // subgraph box colors → style SGx
    subgraphs.forEach(sg=>{
      if(![...sg.nodes].some(id=>nodes.some(n=>n.id===id)))return;
      const col=sg.color||"#8b5cf6";
      out+="    style SG"+sg.id+" fill:"+col+"1f,stroke:"+col+",stroke-width:1.5px\n";});
    codeEl.textContent=out;
    commit();
    return out;
  }

  // ---------- edge styling + markers ----------
  // set stroke width/dash + start/end markers from e.line and e.head
  function styleEdge(e){
    const p=e.pathEl;
    p.style.stroke="#9c8fce";
    p.style.strokeWidth=(e.line==="thick"?4:2);
    p.style.strokeDasharray=(e.line==="dotted"?"5 4":"");
    const endMap={arrow:"arrow",open:"",circle:"circleEnd",cross:"crossEnd",bi:"arrow"};
    const endId=(e.head in endMap)?endMap[e.head]:"arrow";
    if(endId)p.setAttribute("marker-end","url(#"+endId+")");else p.removeAttribute("marker-end");
    if(e.head==="bi")p.setAttribute("marker-start","url(#arrow)");else p.removeAttribute("marker-start");
  }
  function buildDefs(){
    const defs=document.createElementNS(SVGNS,"defs");
    const COL="#9c8fce";
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
    askFilename("flowmaid-diagram","png",fn=>doExportPNG(fn));
  }
  function doExportPNG(fn){
    let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
    nodes.forEach(n=>{minX=Math.min(minX,n.x-n.w/2);maxX=Math.max(maxX,n.x+n.w/2);
      minY=Math.min(minY,n.y-n.h/2);maxY=Math.max(maxY,n.y+n.h/2);});
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
      el.setAttribute("fill","#f2ecff");el.setAttribute("font-size","14");
      el.setAttribute("text-anchor","middle");el.setAttribute("dominant-baseline","middle");
      el.setAttribute("font-family","sans-serif");});
    root.querySelectorAll(".handle").forEach(el=>el.remove());
    // edge lines carry color/width/dash as inline styles (preserved in clone)
    root.querySelectorAll(".edge path.line").forEach(el=>{
      if(!el.style.stroke)el.style.stroke="#9c8fce";el.setAttribute("fill","none");});
    root.querySelectorAll(".edge .hit").forEach(el=>el.remove());
    root.querySelectorAll(".edge text").forEach(el=>{
      el.setAttribute("fill","#9aa2b1");el.setAttribute("font-size","12");
      el.setAttribute("text-anchor","middle");el.setAttribute("font-family","sans-serif");});
    // subgraph rect fill/stroke are already attributes (per-group color); just add font attrs for the title
    root.querySelectorAll(".subgraph text").forEach(el=>{
      el.setAttribute("font-size","13");el.setAttribute("font-weight","600");
      el.setAttribute("font-family","sans-serif");});
    root.querySelectorAll(".sel").forEach(el=>el.classList.remove("sel"));
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
    const factor=ev.deltaY>0?1.1:0.9;
    const nw=Math.min(6000,Math.max(200,view.w*factor));
    const scale=nw/view.w;
    const r=svg.getBoundingClientRect();
    const rx=(ev.clientX-r.left)/r.width, ry=(ev.clientY-r.top)/r.height;
    view.w=nw;view.h=view.h*scale;
    view.x=p.x-rx*view.w;view.y=p.y-ry*view.h;
    applyView();
  },{passive:false});

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
  function clearScene(){nodes.forEach(n=>n.el.remove());edges.forEach(e=>e.el.remove());
    subgraphs.forEach(sg=>sg.el.remove());
    nodes=[];edges=[];subgraphs=[];selNodes.clear();selEdge=null;}
  function serialize(){return {v:2,dir:dirEl.value,edgeCurve,bgColor,nid,eid,gid,
    nodes:nodes.map(n=>({id:n.id,label:n.label,shape:n.shape,x:Math.round(n.x),y:Math.round(n.y),
      fill:n.fill,stroke:n.stroke,bstyle:n.bstyle})),
    edges:edges.map(e=>({id:e.id,from:e.from,to:e.to,label:e.label,line:e.line,head:e.head})),
    groups:subgraphs.map(sg=>({id:sg.id,title:sg.title,nodes:[...sg.nodes],color:sg.color}))};}
  function loadState(s){
    clearScene();
    nid=s.nid||0;eid=s.eid||0;gid=s.gid||0;
    if(s.dir)dirEl.value=s.dir;
    edgeCurve=!!s.edgeCurve;updateCurveBtn();
    applyBg(s.bgColor||"#0d0b13");
    (s.nodes||[]).forEach(d=>{const n={id:d.id,label:d.label,shape:d.shape,
      fill:d.fill||DEFAULT_FILL,stroke:d.stroke||DEFAULT_STROKE,bstyle:d.bstyle||"solid",
      x:d.x,y:d.y,w:NODE_W,h:NODE_H,handles:[]};nodes.push(n);renderNode(n);});
    (s.edges||[]).forEach(d=>{const e={id:d.id,from:d.from,to:d.to,label:d.label||"",
      line:d.line||"solid",head:d.head||"arrow"};edges.push(e);renderEdge(e);});
    (s.groups||[]).forEach(d=>rebuildGroup(d));
    nid=Math.max(nid,0,...nodes.map(n=>n.id));
    eid=Math.max(eid,0,...edges.map(e=>e.id));
    gid=Math.max(gid,0,...subgraphs.map(sg=>sg.id));
    updateEmpty();renderGroups();genCode();
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
    openInline(x,y,sg.title,v=>{sg.title=String(v==null?"":v).trim()||sg.title;renderGroups();genCode();});
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
    window.addEventListener("mouseup",()=>{if(dragging){dragging=false;sg.el.style.cursor="grab";genCode();}});
  }

  // ---------- history (undo / redo) + autosave ----------
  const LS_DIAGRAM="flowmaid.diagram";
  let undoStack=[],redoStack=[],lastCommitted=null,restoring=false;
  function snapshot(){return JSON.stringify(serialize());}
  function autosave(){try{localStorage.setItem(LS_DIAGRAM,lastCommitted||snapshot());}catch(e){}}
  function commit(){
    if(restoring)return;
    const s=snapshot();
    if(s===lastCommitted)return;
    if(lastCommitted!==null){undoStack.push(lastCommitted);if(undoStack.length>200)undoStack.shift();}
    lastCommitted=s;redoStack=[];autosave();updateUndoBtns();
  }
  function restoreFrom(s){restoring=true;loadState(JSON.parse(s));restoring=false;
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
  function applyBg(hex){
    bgColor=hex;
    const dark=luminance(hex)<0.5;
    const dot=mixColor(hex,dark?0.20:0.16,dark?255:0); // contrasting grid dots
    canvasWrap.style.background=
      "radial-gradient(circle at 1px 1px, "+dot+" 1px, transparent 0) 0 0/22px 22px, "+hex;
    const el=document.getElementById("bgPick");
    if(el&&el.value.toLowerCase()!==hex.toLowerCase())el.value=hex;
  }

  // ---------- curve toggle ----------
  function updateCurveBtn(){const b=document.getElementById("curveBtn");if(b)b.classList.toggle("on",edgeCurve);}
  function toggleCurve(){edgeCurve=!edgeCurve;updateCurveBtn();edges.forEach(drawEdge);genCode();
    toast(edgeCurve?"곡선 화살표":"직선 화살표");}

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
    askFilename("flowmaid-diagram","json",fn=>{
      download(new Blob([JSON.stringify(serialize(),null,2)],{type:"application/json"}),fn);
      toast("저장 완료: "+fn);});}
  function openFile(){document.getElementById("fileInput").click();}
  function handleFile(file){
    const rd=new FileReader();
    rd.onload=()=>{try{const s=JSON.parse(rd.result);loadState(s);fitView();toast("불러오기 완료");}
      catch(e){toast("파일을 읽을 수 없습니다");}};
    rd.readAsText(file);}

  // ---------- shortcuts / settings ----------
  const LS_SETTINGS="flowmaid.settings";
  const ACTIONS=[
    {id:"delete",label:"삭제"},{id:"undo",label:"실행취소"},{id:"redo",label:"다시실행"},
    {id:"curve",label:"곡선/직선 전환"},{id:"fit",label:"화면 맞춤"},
    {id:"save",label:"저장"},{id:"open",label:"불러오기"},{id:"deselect",label:"선택 해제"}];
  const DEFAULT_KEYS={delete:["Delete","Backspace"],undo:["Mod+Z"],redo:["Mod+Shift+Z","Mod+Y"],
    curve:["Mod+E"],fit:["F"],save:["Mod+S"],open:["Mod+O"],deselect:["Escape"]};
  let keys=JSON.parse(JSON.stringify(DEFAULT_KEYS));
  let capturing=null;
  function isMac(){return /Mac|iPhone|iPad/.test((navigator.platform||"")+(navigator.userAgent||""));}
  function loadSettings(){try{const j=JSON.parse(localStorage.getItem(LS_SETTINGS));
    if(j&&j.shortcuts){for(const a in DEFAULT_KEYS)keys[a]=j.shortcuts[a]||DEFAULT_KEYS[a];}}catch(e){}}
  function saveSettings(){try{localStorage.setItem(LS_SETTINGS,JSON.stringify({shortcuts:keys}));}catch(e){}}
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
  document.getElementById("saveBtn").addEventListener("click",saveFile);
  document.getElementById("openBtn").addEventListener("click",openFile);
  document.getElementById("fileInput").addEventListener("change",e=>{
    if(e.target.files[0])handleFile(e.target.files[0]);e.target.value="";});
  document.getElementById("settingsBtn").addEventListener("click",openSettings);
  document.getElementById("keyClose").addEventListener("click",closeSettings);
  document.getElementById("keyReset").addEventListener("click",()=>{
    keys=JSON.parse(JSON.stringify(DEFAULT_KEYS));saveSettings();renderKeyList();toast("기본값으로 복원");});
  document.getElementById("settingsModal").addEventListener("click",e=>{
    if(e.target.id==="settingsModal")closeSettings();});
  const appEl=document.getElementById("app");
  document.getElementById("hideCode").addEventListener("click",()=>appEl.classList.add("code-hidden"));
  document.getElementById("showCode").addEventListener("click",()=>appEl.classList.remove("code-hidden"));
  document.querySelectorAll(".swatch").forEach(sw=>{
    sw.addEventListener("click",()=>{applyColor(sw.dataset.c);
      document.getElementById("colorPick").value=sw.dataset.c;});
  });
  document.getElementById("colorPick").addEventListener("input",e=>applyColor(e.target.value));
  document.getElementById("bgPick").addEventListener("input",e=>{applyBg(e.target.value);genCode();});
  document.getElementById("strokePick").addEventListener("input",e=>applyStroke(e.target.value));
  document.getElementById("strokeStyle").addEventListener("change",e=>applyBstyle(e.target.value));
  document.getElementById("edgeLine").addEventListener("change",e=>applyEdgeStyle("line",e.target.value));
  document.getElementById("edgeHead").addEventListener("change",e=>applyEdgeStyle("head",e.target.value));
  document.getElementById("groupBtn").addEventListener("click",makeGroup);
  document.getElementById("ungroupBtn").addEventListener("click",ungroup);
  document.getElementById("groupColorPick").addEventListener("input",e=>applyGroupColor(e.target.value));
  document.getElementById("delBtn").addEventListener("click",deleteSelected);
  document.getElementById("dir").addEventListener("change",genCode);
  document.getElementById("fitBtn").addEventListener("click",fitView);
  document.getElementById("zoomIn").addEventListener("click",()=>zoomBy(0.8));
  document.getElementById("zoomOut").addEventListener("click",()=>zoomBy(1.25));
  document.getElementById("zoomLevel").addEventListener("click",resetZoom);
  document.getElementById("pngBtn").addEventListener("click",exportPNG);
  document.getElementById("clearBtn").addEventListener("click",()=>{
    if(!nodes.length)return;
    askConfirm("모든 노드와 연결을 삭제할까요?",()=>{
      clearScene();nid=0;eid=0;gid=0;updateEmpty();genCode();});});
  document.getElementById("copyBtn").addEventListener("click",()=>{
    navigator.clipboard.writeText(genCode()).then(()=>toast("코드 복사됨"),()=>toast("복사 실패"));});
  document.getElementById("mmdBtn").addEventListener("click",()=>{
    askFilename("flowmaid","mmd",fn=>{
      download(new Blob([genCode()],{type:"text/plain"}),fn);toast(".mmd 저장 완료: "+fn);});});

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
  (function start(){
    let saved=null;try{saved=JSON.parse(localStorage.getItem(LS_DIAGRAM));}catch(e){}
    restoring=true;
    if(saved&&saved.nodes&&saved.nodes.length)loadState(saved);
    else seedDefault();
    restoring=false;
    clearSel();
    applyBg(bgColor);
    lastCommitted=snapshot();
    updateUndoBtns();
    genCode();
    homeView();   // default zoom fixed at 100%
  })();
})();
