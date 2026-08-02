export interface PeerAnnouncement {
  peerId: string
  version?: string
  transport?: { kind?: 'webrtc' | 'webtransport'; kinds?: ('webrtc' | 'webtransport')[] }
}

/** Normalize current star announcements and the legacy peer-id-only format. */
export const normalizePeerAnnouncement = (value: unknown): PeerAnnouncement | null => {
  if (typeof value === 'string') {
    const peerId = value.trim()
    return peerId && peerId !== 'undefined' ? { peerId } : null
  }

  if (!value || typeof value !== 'object') return null
  const candidate = value as PeerAnnouncement
  if (typeof candidate.peerId !== 'string') return null
  const peerId = candidate.peerId.trim()
  if (!peerId || peerId === 'undefined') return null

  return {
    peerId,
    version: typeof candidate.version === 'string' ? candidate.version : undefined,
    transport: candidate.transport
  }
}
