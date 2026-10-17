// The fragment never reaches HTTP logs. Remove it before any asynchronous work.
const fragment=location.hash;
history.replaceState(null,'','/launch');
const ticket=new URLSearchParams(fragment.slice(1)).get('launch');
if(ticket && /^[a-f0-9]{64}$/.test(ticket)){
  fetch('/api/local/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket}),credentials:'same-origin'})
    .then(response=>{if(response.ok)location.replace('/');else document.body.textContent='연결 권한이 만료되었습니다. 로컬 실행 도구에서 다시 열어 주세요.';})
    .catch(()=>{document.body.textContent='로컬 연결을 열 수 없습니다.';});
}else document.body.textContent='로컬 실행 도구에서 웹을 열어 주세요.';
