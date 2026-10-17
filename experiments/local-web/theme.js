'use strict';
// This external head script runs before the first paint. Only a theme choice is
// kept in browser storage; account state stays with the local server.
(()=>{
  const storageKey='web-kakao-theme';
  const media=typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)'):null;
  let mode='system';
  try{const saved=localStorage.getItem(storageKey);if(saved==='light' || saved==='dark')mode=saved;}catch{}
  function apply(){
    const dark=mode==='dark' || mode==='system' && media?.matches===true;
    document.documentElement.dataset.theme=dark?'dark':'light';
    const toggle=document.getElementById('theme-toggle'),select=document.getElementById('theme-mode');
    if(toggle){
      const label=dark?'라이트 모드로 전환':'다크 모드로 전환';
      toggle.textContent=dark?'☀':'☾';toggle.title=label;
      toggle.setAttribute('aria-label',label);toggle.setAttribute('aria-pressed',String(dark));
    }
    if(select)select.value=mode;
  }
  function choose(value){
    if(!['system','light','dark'].includes(value))return;
    mode=value;
    try{if(mode==='system')localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,mode);}catch{}
    apply();
  }
  apply();
  const systemChanged=()=>{if(mode==='system')apply();};
  if(media?.addEventListener)media.addEventListener('change',systemChanged);
  else media?.addListener?.(systemChanged);
  function bind(){
    document.getElementById('theme-toggle')?.addEventListener('click',()=>choose(document.documentElement.dataset.theme==='dark'?'light':'dark'));
    document.getElementById('theme-mode')?.addEventListener('change',event=>choose(event.target.value));
    apply();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind,{once:true});else bind();
})();
