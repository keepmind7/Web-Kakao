// LOCO has both a packet header status and a BSON body status. Neither error
// may be hidden by the other field's success value. Never mutate wire evidence.
export function responseStatus(packet) {
  if (!Number.isInteger(packet?.status)) return null;
  if (packet.status !== 0) return packet.status;
  if (packet.body && Object.hasOwn(packet.body, 'status')) {
    return Number.isInteger(packet.body.status) ? packet.body.status : null;
  }
  return packet.status;
}
export function normalizedResponse(packet) {
  return {...packet, status:responseStatus(packet)};
}
