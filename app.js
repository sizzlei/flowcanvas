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
  function applyView(){svg.setAttribute("viewBox",`${view.x} ${view.y} ${view.w} ${view.h}`);}
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

  const DEFAULT_FILL="#2f2748";
  let nodes=[]; // {id,label,shape,x,y,w,h,fill,el,shapeEl,textEl,handles[]}
  let edges=[]; // {id,from,to,label,el,pathEl,hitEl,textEl,bgEl}
  let nid=0, eid=0;
  let connecting=null; // {source, }
  let edgeCurve=false;
  const NODE_W=120, NODE_H=54;
  const dirEl=document.getElementById("dir");

  function toast(m){const t=document.getElementById("toast");t.textContent=m;
    t.classList.add("show");clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove("show"),1700);}

  // ---------- shape geometry ----------
  function makeShapeEl(shape){
    if(shape==="diamond")return document.createElementNS(SVGNS,"polygon");
    if(shape==="circle")return document.createElementNS(SVGNS,"ellipse");
    return document.createElementNS(SVGNS,"rect");
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
    if(n.shape==="diamond"){
      s.setAttribute("points",`0,${-h/2} ${w/2},0 0,${h/2} ${-w/2},0`);
    }else if(n.shape==="circle"){
      s.setAttribute("cx",0);s.setAttribute("cy",0);s.setAttribute("rx",w/2);s.setAttribute("ry",h/2);
    }else{
      s.setAttribute("x",-w/2);s.setAttribute("y",-h/2);
      s.setAttribute("width",w);s.setAttribute("height",h);
      const rad=n.shape==="rect"?0:(n.shape==="stadium"?h/2:12);
      s.setAttribute("rx",rad);s.setAttribute("ry",rad);
    }
    s.setAttribute("fill",n.fill||DEFAULT_FILL);
    renderText(n,lines);
    const pos=[[0,-h/2],[w/2,0],[0,h/2],[-w/2,0]];
    n.handles.forEach((hd,i)=>{hd.setAttribute("cx",pos[i][0]);hd.setAttribute("cy",pos[i][1]);hd.setAttribute("r",6);});
  }
  function renderNode(n){
    const g=document.createElementNS(SVGNS,"g");
    g.setAttribute("class","node");g.dataset.id=n.id;
    const s=makeShapeEl(n.shape);s.setAttribute("class","shape");
    const t=document.createElementNS(SVGNS,"text");t.setAttribute("class","lbl-t");
    g.appendChild(s);g.appendChild(t);
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

  function edgePoint(n,tx,ty){
    const dx=tx-n.x,dy=ty-n.y;if(!dx&&!dy)return{x:n.x,y:n.y};
    const hw=n.w/2,hh=n.h/2;
    const sc=1/Math.max(Math.abs(dx)/hw,Math.abs(dy)/hh);
    return{x:n.x+dx*sc,y:n.y+dy*sc};
  }
  function drawEdge(e){
    const a=nodes.find(n=>n.id===e.from),b=nodes.find(n=>n.id===e.to);if(!a||!b)return;
    const p1=edgePoint(a,b.x,b.y),p2=edgePoint(b,a.x,a.y);
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
    e.pathEl.setAttribute("marker-end","url(#arrow)");
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
      if(spaceDown)return;               // space = pan, handled elsewhere
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
      edges.forEach(drawEdge);
    });
    window.addEventListener("mouseup",()=>{if(dragging){dragging=false;n.el.style.cursor="grab";if(moved)genCode();}});
    n.el.addEventListener("dblclick",ev=>{ev.stopPropagation();
      openInline(ev.clientX,ev.clientY,n.label,v=>{
        n.label=v.trim()||n.label;refreshNode(n);genCode();});});
    // handles = drag to connect
    n.handles.forEach(hd=>{
      hd.addEventListener("mousedown",ev=>{ev.stopPropagation();startConnect(n,ev);});
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
    const n={id:++nid,label:label||("노드"+nid),shape:shape||"round",fill:DEFAULT_FILL,
      x:x??(160+Math.random()*300),y:y??(120+Math.random()*240),w:NODE_W,h:NODE_H,handles:[]};
    nodes.push(n);renderNode(n);updateEmpty();genCode();return n;
  }
  function addEdge(from,to,label){
    if(edges.some(e=>e.from===from&&e.to===to)){toast("이미 연결됨");return;}
    const e={id:++eid,from,to,label:label||""};edges.push(e);renderEdge(e);genCode();
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
    selNodes.clear();updateEmpty();genCode();
  }
  function applyColor(hex){                           // recolor every selected node
    if(!selNodes.size){toast("색을 바꿀 노드를 먼저 선택하세요");return;}
    selNodes.forEach(id=>{const n=nodes.find(x=>x.id===id);
      if(n){n.fill=hex;n.shapeEl.setAttribute("fill",hex);}});
    genCode();
  }
  function updateEmpty(){emptyHint.style.display=nodes.length?"none":"";}

  // ---------- mermaid code ----------
  const wrap={rect:['[',']'],round:['(',')'],stadium:['([','])'],diamond:['{','}'],circle:['((','))']};
  function san(t){return '"'+String(t==null?"":t).replace(/"/g,"'").replace(/\n/g," ")+'"';}
  function txtColor(hex){ // pick readable stroke-lighten
    return "#e6ecff";
  }
  function genCode(){
    let out="";
    if(edgeCurve)out+="%%{init: {'flowchart': {'curve': 'basis'}}}%%\n";
    out+="flowchart "+dirEl.value+"\n";
    nodes.forEach(n=>{const w=wrap[n.shape]||wrap.round;
      out+="    N"+n.id+w[0]+san(n.label)+w[1]+"\n";});
    edges.forEach(e=>{out+= e.label
      ? "    N"+e.from+" -->|"+san(e.label)+"| N"+e.to+"\n"
      : "    N"+e.from+" --> N"+e.to+"\n";});
    const styled=nodes.filter(n=>(n.fill||DEFAULT_FILL)!==DEFAULT_FILL);
    if(styled.length){out+="\n";styled.forEach(n=>{
      out+="    style N"+n.id+" fill:"+n.fill+",stroke:#8b5cf6,color:#f2ecff\n";});}
    codeEl.textContent=out;
    commit();
    return out;
  }

  // ---------- arrow marker ----------
  function buildDefs(){
    const defs=document.createElementNS(SVGNS,"defs");
    const m=document.createElementNS(SVGNS,"marker");
    m.setAttribute("id","arrow");m.setAttribute("viewBox","0 0 10 10");
    m.setAttribute("refX","9");m.setAttribute("refY","5");
    m.setAttribute("markerWidth","7");m.setAttribute("markerHeight","7");
    m.setAttribute("orient","auto-start-reverse");
    const p=document.createElementNS(SVGNS,"path");
    p.setAttribute("d","M 0 0 L 10 5 L 0 10 z");p.setAttribute("fill","#9c8fce");
    m.appendChild(p);defs.appendChild(m);return defs;
  }
  svg.insertBefore(buildDefs(),svg.firstChild);

  // ---------- PNG export ----------
  function exportPNG(){
    if(!nodes.length){toast("먼저 노드를 추가하세요");return;}
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
    bg.setAttribute("fill","#14111f");clone.appendChild(bg);
    clone.appendChild(buildDefs());
    clone.appendChild(gEdges.cloneNode(true));
    clone.appendChild(gNodes.cloneNode(true));
    inlineStyles(clone);
    const svgStr=new XMLSerializer().serializeToString(clone);
    const img=new Image();
    img.onload=function(){
      const canvas=document.createElement("canvas");canvas.width=w*scale;canvas.height=h*scale;
      const ctx=canvas.getContext("2d");ctx.setTransform(scale,0,0,scale,0,0);ctx.drawImage(img,0,0);
      canvas.toBlob(function(b){const a=document.createElement("a");a.href=URL.createObjectURL(b);
        a.download="flowmaid-diagram.png";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
        toast("PNG 저장 완료");},"image/png");
    };
    img.onerror=function(){toast("내보내기 실패");};
    img.src="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svgStr)));
  }
  function inlineStyles(root){
    root.querySelectorAll(".node .shape").forEach(el=>{
      if(!el.getAttribute("fill"))el.setAttribute("fill",DEFAULT_FILL);
      el.setAttribute("stroke","#8b5cf6");el.setAttribute("stroke-width","2");});
    root.querySelectorAll(".node text").forEach(el=>{
      el.setAttribute("fill","#f2ecff");el.setAttribute("font-size","14");
      el.setAttribute("text-anchor","middle");el.setAttribute("dominant-baseline","middle");
      el.setAttribute("font-family","sans-serif");});
    root.querySelectorAll(".handle").forEach(el=>el.remove());
    root.querySelectorAll(".edge path.line").forEach(el=>{
      el.setAttribute("stroke","#9c8fce");el.setAttribute("stroke-width","2");el.setAttribute("fill","none");});
    root.querySelectorAll(".edge .hit").forEach(el=>el.remove());
    root.querySelectorAll(".edge text").forEach(el=>{
      el.setAttribute("fill","#9aa2b1");el.setAttribute("font-size","12");
      el.setAttribute("text-anchor","middle");el.setAttribute("font-family","sans-serif");});
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
    if(!spaceDown)return;
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
    nodes=[];edges=[];selNodes.clear();selEdge=null;}
  function serialize(){return {v:1,dir:dirEl.value,edgeCurve,nid,eid,
    nodes:nodes.map(n=>({id:n.id,label:n.label,shape:n.shape,x:Math.round(n.x),y:Math.round(n.y),fill:n.fill})),
    edges:edges.map(e=>({id:e.id,from:e.from,to:e.to,label:e.label}))};}
  function loadState(s){
    clearScene();
    nid=s.nid||0;eid=s.eid||0;
    if(s.dir)dirEl.value=s.dir;
    edgeCurve=!!s.edgeCurve;updateCurveBtn();
    (s.nodes||[]).forEach(d=>{const n={id:d.id,label:d.label,shape:d.shape,fill:d.fill||DEFAULT_FILL,
      x:d.x,y:d.y,w:NODE_W,h:NODE_H,handles:[]};nodes.push(n);renderNode(n);});
    (s.edges||[]).forEach(d=>{const e={id:d.id,from:d.from,to:d.to,label:d.label||""};edges.push(e);renderEdge(e);});
    nid=Math.max(nid,0,...nodes.map(n=>n.id));
    eid=Math.max(eid,0,...edges.map(e=>e.id));
    updateEmpty();genCode();
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

  // ---------- curve toggle ----------
  function updateCurveBtn(){const b=document.getElementById("curveBtn");if(b)b.classList.toggle("on",edgeCurve);}
  function toggleCurve(){edgeCurve=!edgeCurve;updateCurveBtn();edges.forEach(drawEdge);genCode();
    toast(edgeCurve?"곡선 화살표":"직선 화살표");}

  // ---------- save / load files ----------
  function saveFile(){
    const blob=new Blob([JSON.stringify(serialize(),null,2)],{type:"application/json"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);
    a.download="flowmaid-diagram.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast("저장 완료");}
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
  document.getElementById("delBtn").addEventListener("click",deleteSelected);
  document.getElementById("dir").addEventListener("change",genCode);
  document.getElementById("fitBtn").addEventListener("click",fitView);
  document.getElementById("pngBtn").addEventListener("click",exportPNG);
  document.getElementById("clearBtn").addEventListener("click",()=>{
    if(!nodes.length)return;
    if(confirm("모든 노드와 연결을 삭제할까요?")){
      nodes.forEach(n=>n.el.remove());edges.forEach(e=>e.el.remove());
      nodes=[];edges=[];selNodes.clear();selEdge=null;nid=0;eid=0;updateEmpty();genCode();}});
  document.getElementById("copyBtn").addEventListener("click",()=>{
    navigator.clipboard.writeText(genCode()).then(()=>toast("코드 복사됨"),()=>toast("복사 실패"));});
  document.getElementById("mmdBtn").addEventListener("click",()=>{
    const blob=new Blob([genCode()],{type:"text/plain"});const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);a.download="diagram.mmd";a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);toast(".mmd 저장 완료");});

  // ---------- marquee: drag on empty canvas to box-select nodes ----------
  let marquee=null,marqueeEl=null;
  svg.addEventListener("mousedown",ev=>{
    if(spaceDown)return;                                  // space = pan
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
    lastCommitted=snapshot();
    updateUndoBtns();
    genCode();
    fitView();
  })();
})();
