// A stream is a local transport lease, not proof that an OS tab still exists.
export function createTabPresence({onEmpty,now=()=>performance.now(),later=setTimeout,clear=clearTimeout,graceMs=120000,maxTabs=4}={}){
  // Four HTTP/1.1 streams leave browser connections available for ordinary APIs.
  if(typeof onEmpty!=='function' || typeof now!=='function' || typeof later!=='function' || typeof clear!=='function'
    || !Number.isSafeInteger(graceMs) || graceMs<1 || graceMs>120000 || !Number.isSafeInteger(maxTabs) || maxTabs<1 || maxTabs>4)throw new Error('invalid_tab_presence_options');
  const tabs=new Set();let timer=null,deadline=null,generation=0,closed=false,observed=-Infinity;
  const time=()=>{const value=now();if(!Number.isFinite(value))throw new Error('invalid_tab_presence_clock');observed=Math.max(observed,value);return observed;};
  function invalidate(){generation++;const previous=timer;timer=null;if(previous!==null)clear(previous);}
  function sweep(){
    const at=time();
    if(!closed && !tabs.size && deadline!==null && at>=deadline){
      invalidate();deadline=null;
      // Publish the empty state before reentrant cleanup observers run.
      onEmpty();
    }
    return at;
  }
  function schedule(at){
    const run=++generation;
    timer=later(()=>{
      if(closed || run!==generation)return;
      timer=null;generation++;
      const current=sweep();
      // Early callbacks keep the original deadline; duplicate callbacks are stale.
      if(!closed && !tabs.size && deadline!==null)schedule(current);
    },Math.max(1,deadline-at));
    timer?.unref?.();
  }
  function armAt(at){if(!tabs.size && deadline===null){deadline=at+graceMs;schedule(at);}}
  return {
    acquire(){
      if(closed)return null;
      sweep();
      if(closed || tabs.size>=maxTabs)return null;
      invalidate();deadline=null;
      const tab=Symbol();tabs.add(tab);
      return ()=>{
        if(closed)return false;
        const at=sweep();if(!tabs.delete(tab))return false;
        if(!tabs.size)armAt(at);
        return true;
      };
    },
    arm(){if(closed)return false;const at=sweep();if(closed)return false;armAt(at);return true;},
    snapshot(){const at=closed?observed:sweep();return {activeTabs:tabs.size,graceMs,graceRemainingMs:deadline===null?null:Math.max(0,Math.ceil(deadline-at))};},
    close(){if(closed)return;closed=true;invalidate();deadline=null;tabs.clear();},
  };
}
