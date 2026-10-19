export const DEFAULT_PHOTO_TRANSPORT='https';

export function normalizePhotoTransport(value){
  if(value==='https-experimental')return 'https';
  if(value==='https' || value==='loco')return value;
  throw new Error('invalid_photo_transport');
}

export function photoTransportFromArgs(args){
  let mode=DEFAULT_PHOTO_TRANSPORT;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--photo-transport')mode=normalizePhotoTransport(args[++index]);
    else if(args[index].startsWith('--photo-transport='))mode=normalizePhotoTransport(args[index].slice('--photo-transport='.length));
  }
  return mode;
}
