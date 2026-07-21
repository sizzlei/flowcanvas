/*
 * gif.js — 경량 애니메이션 GIF89a 인코더 (의존성 없음, 오프라인)
 * window.buildGIF(frames, w, h, {delay, loop}) → Uint8Array
 *   frames : RGBA Uint8ClampedArray 배열 (각 길이 = w*h*4)
 *   delay  : 프레임 지연(1/100초 단위), loop : 반복 횟수(0=무한)
 * 색상은 전 프레임을 표본화한 median-cut 256색 팔레트로 양자화합니다.
 */
(function(){
  "use strict";

  function quantize(frames,w,h){
    const px=[];
    const step=Math.max(1,Math.floor((w*h*frames.length)/60000));
    let cnt=0;
    for(const f of frames){
      for(let i=0;i<w*h;i++){if(cnt++%step)continue;const o=i*4;px.push([f[o],f[o+1],f[o+2]]);}
    }
    let boxes=[mkBox(px)];
    function mkBox(list){
      const b={px:list};let mn=[255,255,255],mx=[0,0,0];
      for(const p of list)for(let c=0;c<3;c++){if(p[c]<mn[c])mn[c]=p[c];if(p[c]>mx[c])mx[c]=p[c];}
      const r=[mx[0]-mn[0],mx[1]-mn[1],mx[2]-mn[2]];
      b.range=Math.max(r[0],r[1],r[2]);b.dim=r[0]>=r[1]&&r[0]>=r[2]?0:(r[1]>=r[2]?1:2);return b;
    }
    while(boxes.length<256){
      let bi=-1,br=-1;
      for(let i=0;i<boxes.length;i++)if(boxes[i].px.length>1&&boxes[i].range>br){br=boxes[i].range;bi=i;}
      if(bi<0)break;
      const b=boxes[bi],d=b.dim;b.px.sort((p,q)=>p[d]-q[d]);
      const mid=b.px.length>>1;
      const a=b.px.slice(0,mid),c=b.px.slice(mid);
      if(!a.length||!c.length)break;
      boxes.splice(bi,1,mkBox(a),mkBox(c));
    }
    const palette=boxes.map(b=>{let r=0,g=0,bl=0;for(const p of b.px){r+=p[0];g+=p[1];bl+=p[2];}
      const n=b.px.length||1;return [Math.round(r/n),Math.round(g/n),Math.round(bl/n)];});
    while(palette.length<256)palette.push([0,0,0]);
    // 32^3 색 큐브 → 최근접 팔레트 인덱스 미리 계산
    const cube=new Uint8Array(32768);
    for(let r=0;r<32;r++)for(let g=0;g<32;g++)for(let b=0;b<32;b++){
      const rr=r<<3|4,gg=g<<3|4,bb=b<<3|4;let best=0,bd=1e12;
      for(let i=0;i<256;i++){const p=palette[i];
        const dd=(p[0]-rr)*(p[0]-rr)+(p[1]-gg)*(p[1]-gg)+(p[2]-bb)*(p[2]-bb);
        if(dd<bd){bd=dd;best=i;}}
      cube[(r<<10)|(g<<5)|b]=best;
    }
    return {palette,cube};
  }

  function mapFrame(f,w,h,cube){
    const idx=new Uint8Array(w*h);
    for(let i=0;i<w*h;i++){const o=i*4;
      idx[i]=cube[((f[o]>>3)<<10)|((f[o+1]>>3)<<5)|(f[o+2]>>3)];}
    return idx;
  }

  // GIF LZW (min code size 8). omggif 방식의 코드폭 증가 규칙.
  function lzw(idx){
    const MIN=8, CLEAR=1<<MIN, EOI=CLEAR+1;
    const out=[];let cur=0,n=0;
    const emit=(code,bits)=>{cur|=code<<n;n+=bits;while(n>=8){out.push(cur&255);cur=cur>>8;n-=8;}};
    let dict,size,next;
    const reset=()=>{dict=new Map();size=MIN+1;next=EOI+1;};
    reset();emit(CLEAR,size);
    let prefix=idx[0];
    for(let i=1;i<idx.length;i++){
      const c=idx[i],key=(prefix<<8)|c;
      if(dict.has(key)){prefix=dict.get(key);}
      else{
        emit(prefix,size);
        if(next<4096){dict.set(key,next);next++;
          if(next===(1<<size)&&size<12)size++;}
        else{emit(CLEAR,size);reset();}
        prefix=c;
      }
    }
    emit(prefix,size);emit(EOI,size);
    if(n>0)out.push(cur&255);
    return out;
  }

  function buildGIF(frames,w,h,opts){
    opts=opts||{};const delay=opts.delay||6,loop=opts.loop==null?0:opts.loop;
    const {palette,cube}=quantize(frames,w,h);
    const b=[];
    const u16=v=>{b.push(v&255,(v>>8)&255);};
    const str=s=>{for(let i=0;i<s.length;i++)b.push(s.charCodeAt(i));};
    str("GIF89a");u16(w);u16(h);b.push(0xF7,0,0);          // screen desc + GCT flag(256)
    for(let i=0;i<256;i++)b.push(palette[i][0],palette[i][1],palette[i][2]);
    // 반복(NETSCAPE)
    b.push(0x21,0xFF,0x0B);str("NETSCAPE2.0");b.push(0x03,0x01);u16(loop);b.push(0x00);
    for(const f of frames){
      b.push(0x21,0xF9,0x04,0x00);u16(delay);b.push(0x00,0x00); // graphic control (no transparency)
      b.push(0x2C);u16(0);u16(0);u16(w);u16(h);b.push(0x00);   // image descriptor
      b.push(8);                                               // LZW min code size
      const data=lzw(mapFrame(f,w,h,cube));
      for(let i=0;i<data.length;i+=255){
        const chunk=data.slice(i,i+255);b.push(chunk.length);for(const v of chunk)b.push(v);}
      b.push(0x00);                                            // block terminator
    }
    b.push(0x3B);                                              // trailer
    return new Uint8Array(b);
  }

  if(typeof window!=="undefined")window.buildGIF=buildGIF;
  if(typeof module!=="undefined")module.exports={buildGIF};
})();
