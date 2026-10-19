// Offline proposals, not SDK/TLS/server implementations. No transport is built in.
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';

const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAgP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const baseResult = (evidenceLevel = 'source-derived-model') => ({
  uploadPhase: 'not_started', messagePhase: 'not_started', delivery: 'unverified',
  evidenceLevel, calls: {}, reason: 'not_started',
});
const statusOK = response => response && response.status === 0;
const validContext = c => c && ['account', 'room'].every(k => typeof c[k] === 'string' && c[k].length > 0)
  && Number.isSafeInteger(c.generation) && c.generation >= 0;

// A fixed 1x1 JPEG with legal COM segments inserted before EOI. These bytes are
// synthetic and contain no user media. Size describes the exact returned buffer.
export function makeSyntheticImage({ format = 'jpeg', size = 1024 } = {}) {
  if (format === 'png') {
    return { bytes: Buffer.from(PNG), mime: 'image/png', name: 'synthetic.png' };
  }
  if (format !== 'jpeg' || !Number.isSafeInteger(size) || size < JPEG.length + 4 || size > 5 * 1024 * 1024) {
    throw new RangeError('synthetic_jpeg_size_or_format');
  }
  const segments = [JPEG.subarray(0, -2)];
  let remaining = size - JPEG.length;
  while (remaining) {
    let length = Math.min(remaining, 65537);
    if (remaining - length > 0 && remaining - length < 4) length -= 4;
    const segment = Buffer.alloc(length);
    segment[0] = 0xff; segment[1] = 0xfe;
    segment.writeUInt16BE(length - 2, 2);
    segments.push(segment);
    remaining -= length;
  }
  segments.push(JPEG.subarray(-2));
  return { bytes: Buffer.concat(segments), mime: 'image/jpeg', name: 'synthetic.jpg' };
}

export function inspectImage(image, { jpegOnly = false } = {}) {
  if (!image || !Buffer.isBuffer(image.bytes) || !image.bytes.length || image.bytes.length > 5 * 1024 * 1024) {
    return { valid: false, reason: 'invalid_image_size' };
  }
  const b = image.bytes;
  const jpeg = b.length >= 4 && b[0] === 255 && b[1] === 216 && b.at(-2) === 255 && b.at(-1) === 217;
  const png = b.length >= 8 && b.subarray(0, 8).equals(PNG.subarray(0, 8));
  const format = jpeg ? 'jpeg' : png ? 'png' : 'unknown';
  const declared = image.mime === 'image/jpeg' ? 'jpeg' : image.mime === 'image/png' ? 'png' : 'unknown';
  const extOK = typeof image.name === 'string' && (format === 'jpeg' ? /\.jpe?g$/i.test(image.name) : /\.png$/i.test(image.name));
  if (format === 'unknown' || format !== declared || !extOK || (jpegOnly && format !== 'jpeg')) {
    return { valid: false, reason: 'image_format_mismatch' };
  }
  // Signature/extension checks do not replace a full image decoder.
  return { valid: true, format, bytes: b.length, sha256: sha256(b) };
}

function fixtureAsset(response) {
  // Deliberately synthetic grammar; no claim about Kakao's returned asset path.
  const path = response?.body;
  return response?.status === 200 && response.redirected !== true
    && response.contentType === 'text/plain' && typeof path === 'string'
    && path.length <= 256 && /^fixture-asset:[A-Za-z0-9_-]{1,80}$/.test(path) ? path : null;
}

function matchesRegistrationAck(ack, canonical) {
  for (const field of ['clientId', 'chatId', 'msgId']) {
    const expected = field === 'clientId' ? canonical.clientId : canonical.registration[field];
    if (Object.hasOwn(ack, field) && ack[field] !== expected) return false;
  }
  if (Object.hasOwn(ack, 'asset')) {
    if (!ack.asset || typeof ack.asset !== 'object') return false;
    for (const field of ['path', 's', 'sha256']) {
      if (Object.hasOwn(ack.asset, field) && ack.asset[field] !== canonical.asset[field]) return false;
    }
  }
  return true;
}

export function createPhotoSimulator({ adapters = {}, isCurrent = () => true, policy = {}, timeoutMs = 100, maxEntries = 256 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new RangeError('bounded_timeout_required');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw new RangeError('bounded_entries_required');
  const entries = new Map();
  let registrationSequence = 0;
  // Memory-only pending/unknown locks span method/clientId/generation switches.
  // A process restart does not preserve this safeguard.
  const uncertainContent = new Set();
  const defaults = {
    ship: () => ({ status: 0 }), post: () => ({ status: 0 }), file: () => ({ status: 0 }),
    complete: () => ({ status: 0 }), upload: () => ({ status: 200, redirected: false, contentType: 'text/plain', body: 'fixture-asset:synthetic' }),
    write: () => ({ status: 0 }),
  };
  const current = context => { try { return isCurrent({ ...context }) === true; } catch { return false; } };
  async function run(request, image) {
    const result = baseResult();
    result.image = { bytes: image.bytes, sha256: image.sha256, format: image.format };
    let possibleCreation = false;
    const contentScope = JSON.stringify([request.context.account, request.context.room, image.sha256]);
    const finish = (reason, uploadPhase = result.uploadPhase, messagePhase = result.messagePhase) => {
      Object.assign(result, { reason, uploadPhase, messagePhase });
      if (possibleCreation && ['accepted', 'failed'].includes(messagePhase)) uncertainContent.delete(contentScope);
      return result;
    };
    const invoke = async (name, details = {}) => {
      result.calls[name] = (result.calls[name] ?? 0) + 1;
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => (adapters[name] ?? defaults[name])({
            context: { ...request.context }, method: request.method,
            image: { ...image },
            // Independent fixture peer can hash bytes; every adapter gets its own
            // copy, never a mutable reference to request or another adapter.
            ...(['upload', 'file'].includes(name) ? { payload: Buffer.from(request.image.bytes) } : {}),
            ...(name === 'upload' ? { multipart: { user_id: '0', attachment_type: 'image/jpeg', filename: 'synthetic.jpg' } } : {}),
            ...structuredClone(details),
          })),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture_deadline')), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    if (!current(request.context)) return finish('stale_context', 'not_started', 'refused');
    if (uncertainContent.has(contentScope)) return finish('unknown_content_retry_refused', 'not_started', 'refused');
    try {
      if (request.method === 'http-write') {
        result.uploadPhase = 'uploading';
        const response = await invoke('upload');
        const path = fixtureAsset(response);
        if (path === null) return finish('invalid_upload_response', 'failed', 'not_started');
        // Logical request-local snapshots, never trusted response size/hash.
        // Receiving a path cannot authenticate the server's path-to-bytes link.
        const asset = Object.freeze({ path, s: image.bytes, sha256: image.sha256 });
        result.uploadPhase = 'asset_uploaded';
        if (!current(request.context)) return finish('stale_context_after_upload', undefined, 'refused');
        if (policy.allLocoBlocked === true) return finish('loco_registration_blocked', undefined, 'failed');
        if (uncertainContent.has(contentScope)) return finish('unknown_content_retry_refused', undefined, 'refused');
        possibleCreation = true;
        uncertainContent.add(contentScope);
        result.messagePhase = 'registering';
        // Minimal legacy-derived proposal only: not current PHOTO extra/BSON.
        const registration = Object.freeze({ chatId: request.context.room,
          msgId: ++registrationSequence, type: 2, noSeen: true,
          extra: JSON.stringify({ path: asset.path, s: asset.s }) });
        const canonical = Object.freeze({ clientId: request.clientId, asset, registration });
        const ack = await invoke('write', canonical);
        if (!current(request.context)) return finish('stale_context_after_write', undefined, 'unknown');
        if (!ack || !Number.isInteger(ack.status)) return finish('missing_write_response', undefined, 'unknown');
        if (!matchesRegistrationAck(ack, canonical)) return finish('write_ack_mismatch', undefined, 'unknown');
        return statusOK(ack) ? finish('modeled_write_ack', undefined, 'accepted') : finish('write_rejected', undefined, 'failed');
      }
      if (policy.allLocoBlocked === true || policy.fileTransportBlocked === true) return finish('modeled_loco_transport_block', 'blocked', 'not_started');
      result.uploadPhase = 'ship';
      if (!statusOK(await invoke('ship'))) return finish('ship_rejected', 'failed', 'not_started');
      if (!current(request.context)) return finish('stale_context_before_post', 'failed', 'refused');
      if (uncertainContent.has(contentScope)) return finish('unknown_content_retry_refused', 'not_started', 'refused');
      // POST may create a message: no automatic retry/fallback from this point.
      possibleCreation = true;
      uncertainContent.add(contentScope);
      result.uploadPhase = 'post'; result.messagePhase = 'pending';
      if (!statusOK(await invoke('post'))) return finish('post_rejected', 'failed', 'unknown');
      result.uploadPhase = 'streaming';
      if (!statusOK(await invoke('file'))) return finish('file_interrupted', 'failed', 'unknown');
      const complete = await invoke('complete');
      if (!current(request.context)) return finish('stale_context_after_complete', 'unknown', 'unknown');
      if (!complete || !Number.isInteger(complete.status)) return finish('missing_complete', 'unknown', 'unknown');
      return statusOK(complete) ? finish('modeled_complete', 'complete', 'accepted') : finish('complete_rejected', 'failed', 'unknown');
    } catch {
      return finish(possibleCreation ? 'uncertain_after_possible_creation' : 'transport_failed_before_creation',
        result.uploadPhase === 'asset_uploaded' ? 'asset_uploaded' : 'unknown', possibleCreation ? 'unknown' : 'not_started');
    }
  }
  return {
    async send(request = {}) {
      const rejected = reason => ({ ...baseResult(), messagePhase: 'refused', reason });
      if (!['loco', 'http-write'].includes(request.method) || !validContext(request.context)
        || typeof request.clientId !== 'string' || request.clientId.length < 1 || request.clientId.length > 128) return rejected('invalid_request');
      if (!Buffer.isBuffer(request.image?.bytes) || request.image.bytes.length > 5 * 1024 * 1024) return rejected('invalid_image_size');
      const inputImage = { ...request.image, bytes: Buffer.from(request.image.bytes) };
      const image = inspectImage(inputImage, { jpegOnly: request.method === 'http-write' });
      if (!image.valid) return rejected(image.reason);
      const fingerprint = JSON.stringify([request.context.account, request.context.room, request.context.generation, request.method, image.sha256]);
      const previous = entries.get(request.clientId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return rejected('client_id_reuse_refused');
        return structuredClone(await previous.promise);
      }
      if (entries.size >= maxEntries) return rejected('memory_dedupe_capacity');
      // Reserve before awaiting adapters, including concurrent duplicate calls.
      const immutableRequest = { ...request, context: { ...request.context }, image: inputImage };
      const promise = Promise.resolve().then(() => run(immutableRequest, image));
      entries.set(request.clientId, { fingerprint, promise });
      return structuredClone(await promise);
    },
  };
}

export function simulateOfficial({ target = 'arbitrary-room', consent = false, configured = false, friendUuids = [], response = { status: 0 } } = {}) {
  const result = baseResult('official-capability-model');
  result.messageForm = 'image_template_card';
  if (target === 'arbitrary-room') return { ...result, messagePhase: 'unsupported', reason: 'no_arbitrary_room_api' };
  if (!['self', 'friends', 'share'].includes(target)) return { ...result, messagePhase: 'refused', reason: 'invalid_target' };
  if (!configured || (target !== 'share' && !consent)) return { ...result, messagePhase: 'blocked', reason: 'settings_or_consent_missing' };
  if (target === 'friends' && (!Array.isArray(friendUuids) || friendUuids.length < 1 || friendUuids.length > 5)) {
    return { ...result, messagePhase: 'refused', reason: 'friend_count_out_of_range' };
  }
  if (target === 'share') return { ...result, messagePhase: 'requires_user_selection', reason: 'official_share_ui_required' };
  const failures = Array.isArray(response?.failure_info) ? response.failure_info.length : 0;
  const successes = Array.isArray(response?.successful_receiver_uuids) ? response.successful_receiver_uuids.length : 0;
  result.calls.template = 1;
  if (failures) return { ...result, messagePhase: successes ? 'partial_failure' : 'failed', reason: 'per_recipient_failure', successfulRecipients: successes, failedRecipients: failures };
  const accepted = target === 'self' ? response?.status === 0
    : response?.httpStatus === 200 && successes === friendUuids.length
      && new Set(response.successful_receiver_uuids).size === successes
      && response.successful_receiver_uuids.every(id => friendUuids.includes(id));
  return { ...result, messagePhase: accepted ? 'accepted' : 'unknown', reason: accepted ? 'modeled_template_ack' : 'missing_template_outcome' };
}

export function simulateManualShare({ supported = false, canShare = false, userActivation = false, outcome = 'resolve' } = {}) {
  const result = baseResult('web-share-capability-model');
  result.targetApp = 'unknown'; result.targetRoom = 'user_selected_unknown';
  if (!supported || !canShare) return { ...result, messagePhase: 'unsupported', reason: 'file_share_unavailable' };
  if (!userActivation) return { ...result, messagePhase: 'blocked', reason: 'user_activation_required' };
  result.calls.share = 1;
  return { ...result, messagePhase: outcome === 'resolve' ? 'handed_off' : outcome === 'cancel' ? 'cancelled' : 'failed',
    reason: outcome === 'resolve' ? 'handoff_not_delivery' : outcome === 'cancel' ? 'user_cancelled' : 'share_failed' };
}

export function simulateCrypto({ profile = 'gcm', decryptProfile = profile, tamper = false } = {}) {
  const result = baseResult('offline-synthetic-crypto');
  if (!['cfb', 'gcm'].includes(profile) || decryptProfile !== profile) return { ...result, reason: 'cipher_profile_mismatch', cryptoPhase: 'refused' };
  const key = Buffer.alloc(16, 0x11); // Synthetic fixture only; never exported.
  const iv = Buffer.alloc(profile === 'gcm' ? 12 : 16, 0x22);
  const plain = Buffer.from('synthetic-file-boundary');
  const cipher = createCipheriv(`aes-128-${profile}`, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = profile === 'gcm' ? cipher.getAuthTag() : undefined;
  if (tamper) encrypted[0] ^= 1;
  try {
    const decipher = createDecipheriv(`aes-128-${profile}`, key, iv);
    if (tag) decipher.setAuthTag(tag);
    const decoded = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return { ...result, reason: 'offline_roundtrip_not_service_compatibility', cryptoPhase: decoded.equals(plain) ? 'roundtrip' : 'modified_plaintext',
      profile, nonceBytes: iv.length, tagBytes: tag?.length ?? 0, plaintextBytes: plain.length,
      ciphertextBytes: encrypted.length, frameBytes: iv.length + encrypted.length + (tag?.length ?? 0),
      authenticated: profile === 'gcm', compatibility: 'unverified' };
  } catch {
    return { ...result, reason: 'authenticated_tamper_detected', cryptoPhase: 'rejected', profile, compatibility: 'unverified' };
  } finally { key.fill(0); }
}

export function simulateTransportPolicy({ fileTransportBlocked = false, allLocoBlocked = false } = {}) {
  return { ...baseResult('hypothesis-model'), reason: 'selective_block_not_observed',
    locoFilePossible: !fileTransportBlocked && !allLocoBlocked,
    httpAssetPossible: true, httpWriteRegistrationPossible: !allLocoBlocked,
    httpAloneCanDeliver: false, bypassClaim: false };
}
