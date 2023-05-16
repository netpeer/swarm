declare module '@koush/wrtc' {
  export function RTCPeerConnection(config: RTCConfiguration): RTCPeerConnection
  export function RTCSessionDescription(descriptionInitDict: RTCSessionDescriptionInit): RTCSessionDescription
  export function RTCIceCandidate(candidateInitDict?: RTCIceCandidateInit): RTCIceCandidate
}