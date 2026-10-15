// 조사용 오프라인 실행 경계. 루프백 이외의 접속을 차단한다.
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const counts = globalThis.__spikeGuard = { externalConnectionsBlocked: 0, externalRequestsBlocked: 0, localIpcAttempts: 0, blockedKinds: [] };
const local = host => host === '127.0.0.1' || host === '::1';
function connectionHost(args) {
  let first = args[0];
  while (Array.isArray(first)) first = first[0];
  return first && typeof first === 'object' ? first.host : args[1];
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const ipcPath = first && typeof first === 'object' ? first.path : typeof first === 'string' ? first : null;
  // tsx는 Windows 로컬 named pipe로 부모에게 IPC를 시도한다. 원격 UNC는 허용하지 않는다.
  if (typeof ipcPath === 'string' && /^\\\\[?.]\\pipe\\/.test(ipcPath)) {
    counts.localIpcAttempts++;
    return connect.apply(this, args);
  }
  if (!local(connectionHost(args))) {
    counts.externalConnectionsBlocked++;
    counts.blockedKinds.push({ host: connectionHost(args) ?? null,
      hasPath: Boolean(first && typeof first === 'object' && first.path), firstType: typeof first });
    throw new Error('External connections prohibited in offline spike');
  }
  return connect.apply(this, args);
};
const tlsConnect = tls.connect;
tls.connect = function(...args) {
  if (!local(connectionHost(args))) {
    counts.externalConnectionsBlocked++;
    throw new Error('External TLS prohibited in offline spike');
  }
  return tlsConnect.apply(this, args);
};
for (const module of [http, https]) {
  for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function(first, ...rest) {
      const host = typeof first === 'string' || first instanceof URL
        ? new URL(first).hostname : first?.hostname || first?.host;
      if (!local(host)) {
        counts.externalRequestsBlocked++;
        throw new Error('External HTTP prohibited in offline spike');
      }
      return original.call(this, first, ...rest);
    };
  }
}
require('node:module').syncBuiltinESMExports();
