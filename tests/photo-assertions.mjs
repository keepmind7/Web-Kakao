// A rejected retry is HTTP activity, not a second admitted photo job.
export function photoRequestAliases(){
  const ids=new Map();
  return value=>{
    if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))return null;
    if(!ids.has(value))ids.set(value,'synthetic-photo-'+(ids.size+1));
    return ids.get(value);
  };
}

export function observePhotoReply(response,row){
  const end=response.end;
  response.end=function(chunk,...args){
    if(row.path==='/api/photo'&&this.statusCode===409&&typeof chunk==='string'&&chunk.length<=1024){
      try{const {error}=JSON.parse(chunk);if(error==='photo_request_retired')row.responseError=error;}catch{}
    }
    return end.call(this,chunk,...args);
  };
}

export function rejectedPhotoRetry(row){return row.responseStatus===409 && row.responseFinished===true && row.responseError==='photo_request_retired';}

export function photoWorkPeak(trace){
  const events=trace.filter(row=>row.path==='/api/photo'&&!rejectedPhotoRetry(row))
    .flatMap(row=>[[row.startOrder,1],...(row.endOrder===null?[]:[[row.endOrder,-1]])]);
  let active=0,peak=0;
  for(const [,change] of events.sort((a,b)=>a[0]-b[0])){active+=change;peak=Math.max(peak,active);}
  return peak;
}

export function photoCanceled(row,trace){
  if(row.doneMs===null)return false;
  if(row.canceled)return true;
  if(!row.syntheticRequestId)return false;
  if(row.endMethod==='Network.loadingFinished'&&row.responseStatus===409
    && trace.some(item=>item.syntheticRequestId===row.syntheticRequestId&&rejectedPhotoRetry(item)))return true;
  const original=trace.filter(item=>item.path==='/api/photo'&&item.syntheticRequestId===row.syntheticRequestId&&!rejectedPhotoRetry(item));
  return row.endMethod==='Network.loadingFailed'&&row.errorText==='net::ERR_EMPTY_RESPONSE'
    && trace.some(item=>item.path==='/api/photo/cancel'&&item.syntheticRequestId===row.syntheticRequestId&&item.responseFinished&&item.responseStatus===200)
    && original.length>0&&original.every(item=>item.closeMs!==null);
}
