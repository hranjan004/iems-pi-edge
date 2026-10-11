/* Shared SVG analysis controls for measured series and forecast views. */
;(function () {
  'use strict'
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const finite = Number.isFinite
  const clock = t => new Date(t).toLocaleString('en-US', {timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})
  const format = (v, unit) => !finite(v) ? 'Unavailable' : unit === 'W' ? (Math.abs(v) >= 1000 ? (v/1000).toFixed(2)+' kW' : Math.round(v)+' W') : v.toFixed(1)+' '+unit
  function extrema(points) {
    const valid = points.filter(p => finite(p.t) && finite(p.v))
    if (!valid.length) return {peak:null,dip:null}
    return {peak:valid.reduce((a,b)=>b.v>a.v?b:a),dip:valid.reduce((a,b)=>b.v<a.v?b:a)}
  }

  function niceScale(lo,hi,n=4){
    if(!finite(lo)||!finite(hi)){lo=0;hi=1}if(!(hi>lo))hi=lo+1
    const raw=(hi-lo)/n,p=Math.pow(10,Math.floor(Math.log10(raw))),step=[1,2,2.5,5,10].find(m=>m*p>=raw-1e-9)*p
    const min=Math.floor(lo/step+1e-9)*step,max=Math.ceil(hi/step-1e-9)*step,ticks=[]
    for(let v=min;v<=max+step/2;v+=step)ticks.push(Math.round(v*1e8)/1e8)
    return {lo:min,hi:max,step,ticks}
  }
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})
  function ptOffset(t){const p=parts.formatToParts(new Date(t)),g=k=>+p.find(x=>x.type===k).value;return Date.UTC(g('year'),g('month')-1,g('day'),g('hour')%24,g('minute'),g('second'))-Math.floor(t/1000)*1000}
  function timeTicks(start,end,count){
    const step=[1,2,5,10,15,30,60,120,180,240,360,720,1440].map(m=>m*60000).find(s=>s>=(end-start)/Math.max(1,count))||86400000,out=new Set()
    for(const off of new Set([ptOffset(start),ptOffset(end)]))for(let wall=Math.ceil((start+off)/step)*step;wall-off<=end;wall+=step){const t=wall-off;if(t>=start&&ptOffset(t)===off)out.add(t)}
    return Array.from(out).sort((a,b)=>a-b)
  }
  const style = document.createElement('style')
  style.textContent = `
    .sc-root{min-width:0;font-family:inherit}.sc-tools{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:12px 0 8px}
    .sc-tools button,.sc-insights button{font:inherit;cursor:pointer;color:#344054;background:#fff;border:1px solid #d0d5dd;border-radius:6px;padding:7px 9px;min-height:34px}
    .sc-tools button:disabled{opacity:.4;cursor:default}.sc-tools button:hover:not(:disabled){border-color:#175cd3;color:#175cd3}
    .sc-tools button:focus-visible,.sc-insights button:focus-visible,.sc-tools input:focus-visible,.sc-svg:focus-visible{outline:3px solid #84adff;outline-offset:2px}
    .sc-window{font-size:11px;color:#667085;margin-left:auto}.sc-tools label{display:flex;align-items:center;gap:5px;font-size:11px;color:#667085}.sc-tools input{width:85px}
    .sc-frame{position:relative;height:300px;min-width:0}.sc-svg{display:block;width:100%;height:100%;touch-action:pan-y}
    .sc-tip{position:absolute;z-index:2;display:none;pointer-events:none;background:#182230;color:white;border-radius:6px;padding:8px 10px;font-size:12px;max-width:230px;line-height:1.6;box-shadow:0 3px 14px #18223022}
    .sc-insights{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.sc-insights button{flex:1;min-width:115px;text-align:left;padding:9px 11px;border-left:3px solid var(--accent,#175cd3)}
    .sc-insights small{display:block;font-size:11px;color:#667085}.sc-insights strong{display:block;font-size:18px;margin:3px 0;color:#182230;font-variant-numeric:tabular-nums}
    .sc-bound-legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:11px;color:#475467;margin:8px 0}.sc-bound-legend[hidden]{display:none}.sc-bound-legend span:first-child::before{content:"";display:inline-block;width:20px;border-top:2px dashed currentColor;margin-right:6px}.sc-bound-legend span:nth-child(2)::before{content:"";display:inline-block;width:20px;border-top:2px dotted currentColor;margin-right:6px}
    .sc-readout{font-size:11px;color:#667085;min-height:18px;margin-top:5px;overflow-wrap:anywhere}
    .sc-insights .sc-upper,.sc-insights .sc-lower{flex-basis:calc(50% - 8px)}
    .sc-insights [hidden]{display:none}.sc-empty{display:flex;align-items:center;justify-content:center;height:100%;font-size:13px;color:#667085}
    @media(max-width:480px){.sc-frame{height:280px}.sc-tools{gap:5px}.sc-tools button{font-size:12px;padding:7px}.sc-window{width:100%;margin:0}.sc-insights{gap:5px}.sc-insights button{min-width:95px;padding:7px}.sc-insights strong{font-size:15px}}
  `
  document.head.appendChild(style)
  let serial = 0
  class AnalysisChart {
    constructor(host, config) {
      this.host=host;this.id='sc-'+(++serial);this.viewport=null
      host.innerHTML='<div class="sc-root"><div class="sc-insights"></div><div class="sc-tools">'+
        '<button type="button" data-action="in" aria-label="Zoom in">Zoom in</button><button type="button" data-action="out" aria-label="Zoom out">Zoom out</button>'+
        '<button type="button" data-action="earlier" aria-label="View earlier times">‹ Earlier</button><button type="button" data-action="later" aria-label="View later times">Later ›</button><button type="button" data-action="reset">Reset zoom</button>'+
        '<label>Pan <input type="range" min="0" max="1000" value="0" aria-label="Position of chart window"></label><span class="sc-window"></span></div>'+
        '<div class="sc-bound-legend" hidden><span>Upper bound · dashed</span><span>Lower bound · dotted</span><span>Shaded forecast uncertainty</span></div><div class="sc-frame"><svg class="sc-svg" tabindex="0" role="img"></svg><div class="sc-tip"></div></div><div class="sc-readout">Hover or tap the graph to inspect a value. Arrow keys move between readings.</div></div>'
      this.root=host.querySelector('.sc-root');this.svg=host.querySelector('.sc-svg');this.tip=host.querySelector('.sc-tip')
      this.root.addEventListener('click',e=>{
        const button=e.target.closest('button');if(!button)return
        if(button.dataset.action==='in')this.zoom(.5)
        if(button.dataset.action==='out')this.zoom(2)
        if(button.dataset.action==='reset'){this.viewport=null;this.draw()}
        if(button.dataset.action==='earlier')this.pan(-.5)
        if(button.dataset.action==='later')this.pan(.5)
        if(button.dataset.time){this.select(+button.dataset.time,true)}
      })
      this.root.querySelector('input').addEventListener('input',e=>{
        const span=this.end-this.start,available=this.fullEnd-this.fullStart-span
        this.viewport=[this.fullStart+available*(+e.target.value/1000),this.fullStart+available*(+e.target.value/1000)+span];this.draw()
      })
      this.svg.addEventListener('pointermove',e=>this.inspect(e))
      this.svg.addEventListener('pointerleave',()=>{this.tip.style.display='none';const cross=this.svg.querySelector('.sc-cross');if(cross)cross.innerHTML=''})
      this.svg.addEventListener('click',e=>{const p=this.pointAt(e);if(p){this.inspect(e);if(p.kind!=='Observed history')this.select(p.t,false)}})
      this.svg.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault()
        const pts=this.features.filter(p=>p.t>=this.start&&p.t<=this.end);if(!pts.length)return
        let index=pts.findIndex(p=>p.t>=this.selected);if(index<0)index=pts.length-1
        this.select(pts[Math.max(0,Math.min(pts.length-1,index+(e.key==='ArrowRight'?1:-1)))].t,false)
      })
      this.update(config)
      if(window.ResizeObserver){this.observer=new ResizeObserver(()=>this.draw());this.observer.observe(this.root.querySelector('.sc-frame'))}
    }
    update(config) {
      if(this.config && this.config.rangeKey!==config.rangeKey)this.viewport=null
      this.config=config
      this.features=(config.features||[]).filter(p=>finite(p.t)&&finite(p.v)).sort((a,b)=>a.t-b.t)
      if(finite(config.selectedTime))this.selected=config.selectedTime
      else if(!finite(this.selected))this.selected=this.features.at(-1)?.t
      this.draw()
    }
    destroy(){if(this.observer)this.observer.disconnect();this.host.innerHTML=''}
    clamp(start,span){span=Math.min(this.fullEnd-this.fullStart,Math.max(this.config.minSpan||60000,span));start=Math.max(this.fullStart,Math.min(this.fullEnd-span,start));this.viewport=[start,start+span]}
    zoom(factor){const span=(this.end-this.start)*factor,center=finite(this.selected)&&this.selected>=this.start&&this.selected<=this.end?this.selected:(this.start+this.end)/2;this.clamp(center-span/2,span);this.draw()}
    pan(fraction){this.clamp(this.start+(this.end-this.start)*fraction,this.end-this.start);this.draw()}
    select(time,focus){
      this.selected=time
      if(focus&&(time<this.start||time>this.end))this.clamp(time-(this.end-this.start)/2,this.end-this.start)
      this.draw();if(this.config.onSelect)this.config.onSelect(time)
    }
    pointAt(e){
      const rect=this.svg.getBoundingClientRect(),px=(e.clientX-rect.left)/rect.width*this.W
      if(px<this.L||px>this.W-this.R)return null
      const t=this.start+(px-this.L)/(this.W-this.L-this.R)*(this.end-this.start)
      const points=(this.config.inspection||this.features).filter(p=>p.t>=this.start&&p.t<=this.end&&finite(p.v))
      return points.length?points.reduce((a,b)=>Math.abs(b.t-t)<Math.abs(a.t-t)?b:a):null
    }
    inspect(e){
      const p=this.pointAt(e);if(!p)return
      this.tip.innerHTML=esc(clock(p.t))+' PT'+(p.kind?'<br>'+esc(p.kind):'')+'<br><b>'+esc(format(p.v,this.config.unit||'W'))+'</b>'+(finite(p.lo)&&finite(p.hi)?'<br>Upper bound <b>'+esc(format(p.hi,this.config.unit||'W'))+'</b><br>Lower bound <b>'+esc(format(p.lo,this.config.unit||'W'))+'</b>':'')
      const rect=this.svg.getBoundingClientRect(),px=e.clientX-rect.left
      this.tip.style.display='block';this.tip.style.left=Math.max(2,Math.min(rect.width-235,px+12))+'px';this.tip.style.top=Math.max(2,Math.min(rect.height-90,e.clientY-rect.top-45))+'px'
      const cross=this.svg.querySelector('.sc-cross');if(cross)cross.innerHTML='<line x1="'+this.x(p.t)+'" x2="'+this.x(p.t)+'" y1="'+this.T+'" y2="'+(this.H-this.B)+'" stroke="#98a2b3" stroke-dasharray="3 4"/>'
      this.root.querySelector('.sc-readout').textContent=clock(p.t)+' PT · '+format(p.v,this.config.unit||'W')
    }
    draw(){
      const c=this.config;if(!c)return
      const tracks=(c.tracks||[]).filter(t=>t.visible!==false)
      const all=(c.tracks||[]).flatMap(t=>t.points).filter(p=>finite(p.t))
      this.fullStart=finite(c.start)?c.start:Math.min(...all.map(p=>p.t));this.fullEnd=finite(c.end)?c.end:Math.max(...all.map(p=>p.t))
      if(!finite(this.fullStart)||!finite(this.fullEnd)||this.fullEnd<=this.fullStart){this.svg.innerHTML='<text x="50%" y="50%" text-anchor="middle" fill="#667085">No readings available</text>';return}
      if(this.viewport)this.clamp(this.viewport[0],this.viewport[1]-this.viewport[0])
      ;[this.start,this.end]=this.viewport||[this.fullStart,this.fullEnd]
      this.W=Math.max(260,this.svg.clientWidth||650);this.H=this.svg.clientHeight||300;this.L=this.W<450?48:60;this.R=18;this.T=38;this.B=43
      const visible=tracks.flatMap(t=>t.points.filter(p=>p.t>=this.start&&p.t<=this.end&&finite(p.v)))
      let values=visible.flatMap(p=>(c.band!==false||c.uncertainty)?[p.v,p.lo,p.hi].filter(finite):[p.v])
      let min=values.length?Math.min(...values):0,max=values.length?Math.max(...values):1
      if(c.includeZero){min=Math.min(0,min);max=Math.max(0,max)}
      if(finite(c.axisMax))max=Math.max(max,c.axisMax)
      if(finite(c.axisMin))min=Math.min(min,c.axisMin)
      const pad=Math.max((max-min)*.12,c.unit==='%'?.5:c.unit==='°F'?.5:1)
      min-=pad;max+=pad
      if(c.includeZero&&values.every(v=>v>=0))min=0
      if(c.bounds){min=Math.max(c.bounds[0],min);max=Math.min(c.bounds[1],max)}
      if(max<=min){if(c.bounds&&min>=c.bounds[1])min=c.bounds[1]-1;else max=min+1}
      let scale=niceScale(min,max,this.W<450?3:4)
      if(c.bounds){scale.lo=Math.max(c.bounds[0],scale.lo);scale.hi=Math.min(c.bounds[1],scale.hi);scale.ticks=scale.ticks.filter(v=>v>=scale.lo&&v<=scale.hi)}
      min=scale.lo;max=scale.hi
      this.x=t=>this.L+(t-this.start)/(this.end-this.start)*(this.W-this.L-this.R)
      this.y=v=>this.H-this.B-(v-min)/(max-min)*(this.H-this.T-this.B)
      const x=this.x,y=this.y,W=this.W,H=this.H,L=this.L,R=this.R,T=this.T,B=this.B
      this.svg.dataset.windowStart=this.start;this.svg.dataset.windowEnd=this.end
      this.svg.setAttribute('viewBox','0 0 '+W+' '+H)
      this.svg.setAttribute('aria-label',c.name+' · '+(c.unit||'W')+' · '+clock(this.start)+' to '+clock(this.end)+' Pacific. Use arrow keys to inspect values.')
      let out='<defs><clipPath id="'+this.id+'-clip"><rect x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'"/></clipPath></defs>'
      const power=c.unit==='W',kw=power&&Math.max(Math.abs(min),Math.abs(max))>=1000,unit=kw?'kW':c.unit||'W',step=scale.step/(kw?1000:1),decimals=step>=1&&Math.abs(step-Math.round(step))<1e-8?0:Math.abs(step*10-Math.round(step*10))<1e-8?1:2
      for(const v of scale.ticks){const yy=y(v),text=(kw?v/1000:v).toFixed(decimals).replace('-','−');out+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+yy+'" y2="'+yy+'" stroke="#eaecf0"/><text x="'+(L-8)+'" y="'+(yy+4)+'" text-anchor="end" font-size="11" fill="#667085">'+esc(text)+'</text>'}
      out+='<text x="'+L+'" y="16" font-size="11" fill="#667085">'+esc(unit)+'</text>'
      const tickTimes=timeTicks(this.start,this.end,Math.max(2,Math.floor((W-L-R)/110)))
      for(const time of tickTimes){const xx=x(time);out+='<text x="'+xx+'" y="'+(H-22)+'" text-anchor="middle" font-size="10" fill="#667085">'+esc(new Date(time).toLocaleTimeString('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}))+'</text><text x="'+xx+'" y="'+(H-7)+'" text-anchor="middle" font-size="9" fill="#98a2b3">'+esc(new Date(time).toLocaleDateString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric'}))+'</text>'}
      out+='<g clip-path="url(#'+this.id+'-clip)">'
      if(min<0&&max>0)out+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="#98a2b3"/>'
      for(const track of tracks){
        const pts=track.points
        if(c.band!==false&&track.band){
          let segment=[];const flush=()=>{if(segment.length>1){const polygon=segment.map(p=>x(p.t)+','+y(p.hi)).concat(segment.slice().reverse().map(p=>x(p.t)+','+y(p.lo))).join(' ');out+='<polygon class="sc-band" points="'+polygon+'" fill="'+track.color+'" opacity="'+(c.uncertainty?'.16':'.1')+'"/>'}segment=[]}
          for(const p of pts){if(finite(p.v)&&finite(p.lo)&&finite(p.hi))segment.push(p);else flush()}flush()
        }
        if(c.uncertainty&&track.band){
          for(const [kind,key,dash] of [['upper','hi','6 4'],['lower','lo','2 4']]){
            if(c.boundLines?.[kind]===false)continue
            let boundPath='',joined=false
            for(const p of pts){if(!finite(p.t)||!finite(p[key])||!finite(p.v)){joined=false;continue}boundPath+=(joined?' L':' M')+x(p.t).toFixed(2)+','+y(p[key]).toFixed(2);joined=true}
            out+='<path class="sc-bound" data-bound="'+kind+'" d="'+boundPath+'" fill="none" stroke="'+track.color+'" stroke-width="1.8" stroke-dasharray="'+dash+'" opacity=".9"><title>'+kind+' forecast uncertainty bound</title></path>'
          }
        }
        let path='',active=false
        for(const p of pts){if(!finite(p.v)||!finite(p.t)){active=false;continue}path+=(active?' L':' M')+x(p.t).toFixed(2)+','+y(p.v).toFixed(2);active=true}
        out+='<path class="sc-line" data-track="'+esc(track.id)+'" d="'+path+'" fill="none" stroke="'+track.color+'" stroke-width="'+(track.width||2.2)+'" stroke-linejoin="round"/>'
      }
      if(finite(c.origin)&&c.origin>=this.start&&c.origin<=this.end)out+='<line x1="'+x(c.origin)+'" x2="'+x(c.origin)+'" y1="'+T+'" y2="'+(H-B)+'" stroke="#98a2b3" stroke-dasharray="4 5"/>'
      for(const marker of c.events||[])if(marker.t>=this.start&&marker.t<=this.end)out+='<g><title>'+esc(marker.title)+'</title><circle cx="'+x(marker.t)+'" cy="'+(T+4)+'" r="3" fill="#b54708"/></g>'
      out+='</g>'
      const stats=extrema(this.features),flags=c.highlights||{peak:true,dip:true,selected:true}
      const labels=c.labels||{peak:'Peak',dip:'Low'}
      const marker=(point,kind,color,label)=>{
        if(!point||point.t<this.start||point.t>this.end)return
        const px=x(point.t),py=y(point.v),boxW=Math.min(130,W-L-R),bx=Math.max(L,Math.min(W-R-boxW,px-boxW/2)),by=Math.max(20,Math.min(H-B-24,py+(kind==='dip'?12:-26)))
        out+='<g class="sc-marker" data-kind="'+kind+'"><title>'+esc(label+' '+format(point.v,c.unit||'W')+' · '+clock(point.t)+' PT')+'</title><circle cx="'+px+'" cy="'+py+'" r="4" fill="white" stroke="'+color+'" stroke-width="2"/><rect x="'+bx+'" y="'+(by-12)+'" width="'+boxW+'" height="20" rx="4" fill="white" stroke="'+color+'" stroke-opacity=".3"/><text x="'+(bx+boxW/2)+'" y="'+(by+2)+'" text-anchor="middle" font-size="11" font-weight="600" fill="'+color+'">'+esc(label+' '+format(point.v,c.unit||'W'))+'</text></g>'
      }
      if(flags.peak)marker(stats.peak,'peak','#b54708',labels.peak)
      if(flags.dip&&stats.dip?.v!==stats.peak?.v)marker(stats.dip,'dip','#087e8b',labels.dip)
      const exact=(c.features||[]).find(p=>p.t===this.selected)
      const selected=exact||(this.features.length?this.features.reduce((a,b)=>Math.abs(b.t-this.selected)<Math.abs(a.t-this.selected)?b:a):null)
      if(c.uncertainty&&flags.selected&&selected&&selected.t>=this.start&&selected.t<=this.end){
        for(const [kind,key] of [['upper','hi'],['lower','lo']])if(c.boundLines?.[kind]!==false&&finite(selected[key])){
          const px=x(selected.t),py=y(selected[key]),tx=Math.max(L+4,Math.min(W-R-140,px+9)),ty=Math.max(T+10,Math.min(H-B-5,py+(kind==='upper'?16:-10)))
          out+='<g class="sc-bound-selected" data-bound="'+kind+'"><circle cx="'+px+'" cy="'+py+'" r="4" fill="white" stroke="'+(c.color||'#175cd3')+'" stroke-width="2"/><text x="'+tx+'" y="'+ty+'" font-size="10" font-weight="600" fill="'+(c.color||'#175cd3')+'" stroke="white" stroke-width="3" paint-order="stroke">'+esc((kind==='upper'?'Upper ':'Lower ')+format(selected[key],c.unit||'W'))+'</text></g>'
        }
      }
      if(flags.selected&&selected&&finite(selected.v)&&selected.t>=this.start&&selected.t<=this.end)out+='<circle class="sc-selected" cx="'+x(selected.t)+'" cy="'+y(selected.v)+'" r="5" fill="'+(c.color||'#175cd3')+'" stroke="white" stroke-width="2"/>'
      if(!tracks.length)out+='<text x="'+W/2+'" y="'+H/2+'" text-anchor="middle" font-size="12" fill="#667085">Lines hidden · Select a line filter above</text>'
      else if(!visible.length)out+='<text x="'+W/2+'" y="'+H/2+'" text-anchor="middle" font-size="12" fill="#667085">No readings in this zoom window</text>'
      out+='<g class="sc-cross"></g>';this.svg.innerHTML=out
      const insights=this.root.querySelector('.sc-insights')
      if(!insights.children.length)insights.innerHTML=['peak','dip','selected','upper','lower'].map(kind=>'<button type="button" class="sc-'+kind+'"><small></small><strong></strong><small></small></button>').join('')
      for(const [kind,p,title,color] of [['peak',stats.peak,labels.peak,'#b54708'],['dip',stats.dip,labels.dip,'#087e8b'],['selected',selected,'Selected time',c.color||'#175cd3']]){
        const button=insights.querySelector('.sc-'+kind);button.hidden=!p||!flags[kind]
        if(p){button.dataset.time=p.t;button.style.setProperty('--accent',color);button.children[0].textContent=title;button.children[1].textContent=format(p.v,c.unit||'W');button.children[2].textContent=clock(p.t)+' PT'}
      }
      const uncertaintyVisible=c.uncertainty
      for(const [kind,key,title] of [['upper','hi','Upper bound at selected time'],['lower','lo','Lower bound at selected time']]){
        const button=insights.querySelector('.sc-'+kind);button.hidden=!uncertaintyVisible||c.boundLines?.[kind]===false
        button.style.setProperty('--accent',c.color||'#175cd3');button.children[0].textContent=title
        button.children[1].textContent=format(selected?.[key],c.unit||'W');button.children[2].textContent=selected?clock(selected.t)+' PT':'No forecast value'
        if(selected)button.dataset.time=selected.t;else delete button.dataset.time
      }
      const legend=this.root.querySelector('.sc-bound-legend');legend.hidden=!uncertaintyVisible
      legend.children[0].hidden=c.boundLines?.upper===false;legend.children[1].hidden=c.boundLines?.lower===false;legend.children[2].hidden=c.band===false
      this.root.querySelector('.sc-window').textContent=clock(this.start)+' – '+clock(this.end)+' PT'
      const span=this.end-this.start,full=this.fullEnd-this.fullStart,slider=this.root.querySelector('input')
      slider.disabled=span>=full-1;slider.value=full-span>1?Math.round((this.start-this.fullStart)/(full-span)*1000):0
      this.root.querySelector('[data-action="out"]').disabled=span>=full-1
      this.root.querySelector('[data-action="in"]').disabled=span<=(c.minSpan||60000)+1
      this.root.querySelector('[data-action="earlier"]').disabled=this.start<=this.fullStart+1
      this.root.querySelector('[data-action="later"]').disabled=this.end>=this.fullEnd-1
      this.svg.__analysis={start:this.start,end:this.end,min,max,peak:stats.peak,dip:stats.dip,selected}
    }
  }
  window.SeriesAnalysis={Chart:AnalysisChart,extrema,format,clock,niceScale,timeTicks}
})()
