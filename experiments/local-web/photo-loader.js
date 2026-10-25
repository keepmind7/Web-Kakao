'use strict';
// Direct images and explicit downloads share two HTTP slots across local tabs
// with Web Locks (two per tab on browsers without it). No bytes/object URLs are
// retained here; the browser owns image decoding and eviction.
globalThis.createPhotoLoader=function({root,locks=globalThis.navigator?.locks}={}){
  const images=new Map(),targets=new Map(),waiting=new Set(),active=new Set();
  let epoch=0,enabled=true,clearing=false,nextSlot=0;
  const aborted=()=>new DOMException('Photo request canceled','AbortError');
  const safe=src=>typeof src==='string' && /^\/api\/photo\?room=r_[a-f0-9]{24}&message=m_[a-f0-9]{24}&index=(?:[0-9]|[12][0-9])&cap=[a-f0-9]{64}$/.test(src);
  function makeObserver(){
    const generation=epoch;
    return typeof IntersectionObserver==='function'?new IntersectionObserver(rows=>{
      if(generation!==epoch)return;
      for(const row of rows){const job=targets.get(row.target);if(!job || job.epoch!==epoch || job.state!=='waiting')continue;job.visible=row.isIntersecting;if(job.visible)waiting.add(job);else waiting.delete(job);}
      pump();
    },{root,rootMargin:'200px 0px'}):null;
  }
  let observer=makeObserver();
  function unobserve(job){if(!job.image)return;observer?.unobserve(job.target);if(targets.get(job.target)===job)targets.delete(job.target);}
  function detach(job){if(!job.image)return;job.image.removeEventListener('load',job.load);job.image.removeEventListener('error',job.error);}
  function release(job,canceled=false){
    const unlock=job.unlock;job.unlock=null;
    // Removing src queues the HTML image update. Let that cancellation run
    // before handing the same HTTP slot to another tab.
    if(unlock){if(canceled && job.image)queueMicrotask(unlock);else unlock();}
  }
  function finish(job,error,value){
    if(!['active','locking'].includes(job.state))return;
    active.delete(job);detach(job);clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.abort);job.state='done';release(job,Boolean(error));
    if(job.epoch===epoch){if(job.image)(error?job.onError:job.onLoad)?.();else(error?job.reject:job.resolve)(error || value);}
    pump();
  }
  function cancel(job){
    if(job.state==='canceled')return;
    const pending=job.state!=='done';job.state='canceled';waiting.delete(job);active.delete(job);unobserve(job);detach(job);
    clearTimeout(job.timer);job.signal?.removeEventListener('abort',job.abort);job.controller?.abort();
    if(job.image){if(images.get(job.image)===job)images.delete(job.image);job.image.removeAttribute('src');}
    else if(pending)job.reject(aborted());
    release(job,true);
    pump();
  }
  function start(job){
    if(job.state!=='locking' || job.epoch!==epoch)return;
    job.state='active';
    job.timer=setTimeout(()=>{
      if(job.state!=='active')return;
      job.controller.abort();if(job.image)job.image.removeAttribute('src');
      finish(job,new Error('photo_timeout'));
    },job.image?15000:30000);
    if(job.image){
      const current=()=>job.epoch===epoch && images.get(job.image)===job && job.state==='active';
      job.load=()=>{if(current())finish(job);};job.error=()=>{if(current())finish(job,new Error('photo_unavailable'));};
      job.image.addEventListener('load',job.load);job.image.addEventListener('error',job.error);
      // IO, rather than the browser's larger lazy prefetch window, decides
      // eligibility. Web Locks additionally reserve origin-wide HTTP slots.
      job.image.loading='eager';job.image.src=job.src;
    }else{
      Promise.resolve().then(()=>{if(job.state!=='active')throw aborted();return job.operation(job.controller.signal);}).then(value=>finish(job,null,value),error=>finish(job,error));
    }
  }
  function pump(){
    if(!enabled || clearing)return;
    while(active.size<2 && waiting.size){
      const job=[...waiting].find(row=>row.priority) || waiting.values().next().value;waiting.delete(job);
      if(job.epoch!==epoch || job.state!=='waiting')continue;
      job.state='locking';active.add(job);unobserve(job);
      if(typeof locks?.request==='function'){
        // Alternating fixed slots avoids taking both locks for a single job.
        // Waiting for a lock creates no image/fetch HTTP request.
        try{Promise.resolve(locks.request('web-kakao-photo-'+(nextSlot++%2),{signal:job.controller.signal},()=>new Promise(resolve=>{
          job.unlock=resolve;if(job.state==='locking' && job.epoch===epoch)start(job);else resolve();
        }))).catch(error=>finish(job,error));}catch(error){finish(job,error);}
      }else start(job);
    }
  }
  function image(element,src,{target=element,eager=false,onLoad,onError}={}){
    if(!safe(src))return;
    const previous=images.get(element);if(previous?.src===src)return;
    if(previous)cancel(previous);
    const job={image:element,target,src,onLoad,onError,controller:new AbortController(),epoch,state:'waiting',visible:eager || !observer,priority:eager};images.set(element,job);
    if(!eager && observer){targets.set(target,job);observer.observe(target);}
    if(job.visible)waiting.add(job);pump();
  }
  function run(operation,{signal}={}){
    return new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(aborted());return;}
      const job={operation,signal,resolve,reject,controller:new AbortController(),epoch,state:'waiting',priority:true};
      job.abort=()=>cancel(job);signal?.addEventListener('abort',job.abort,{once:true});waiting.add(job);pump();
    });
  }
  function clear(){
    clearing=true;epoch++;observer?.disconnect();
    for(const job of new Set([...images.values(),...waiting,...active]))cancel(job);
    images.clear();targets.clear();waiting.clear();active.clear();observer=makeObserver();clearing=false;
  }
  return {image,run,clear,
    remove(element){const job=images.get(element);if(job)cancel(job);},
    removeTree(node){clearing=true;if(images.has(node))cancel(images.get(node));for(const image of node.querySelectorAll?.('img') || []){const job=images.get(image);if(job)cancel(job);}clearing=false;pump();},
    setActive(value){if(enabled===value)return;enabled=value;if(!enabled)clear();else pump();},
  };
};
