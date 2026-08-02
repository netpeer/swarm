import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePeerAnnouncement } from '../src/client/peer-announcement.ts'

test('normalizes current and legacy peer announcements', () => {
  assert.deepEqual(normalizePeerAnnouncement('peer-a'), { peerId: 'peer-a' })
  assert.deepEqual(normalizePeerAnnouncement({ peerId: 'peer-b', version: '1.0.0' }), {
    peerId: 'peer-b',
    version: '1.0.0',
    transport: undefined
  })
})

test('rejects announcements without a usable peer id', () => {
  assert.equal(normalizePeerAnnouncement(undefined), null)
  assert.equal(normalizePeerAnnouncement({ peerId: undefined }), null)
  assert.equal(normalizePeerAnnouncement('undefined'), null)
})
