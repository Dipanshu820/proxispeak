// WebGL capability probe.
//
// The office must never break when the renderer is unavailable (jsdom tests,
// locked-down browsers, software-rendering failures). A probe is cheaper and
// more reliable than waiting for `Canvas` to throw: if this returns false the
// caller renders the accessible 2D floor instead of mounting Three.js at all.
export function isWebGLAvailable() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  if (!window.WebGLRenderingContext) return false

  try {
    const canvas = document.createElement('canvas')
    const context =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl')
    if (!context) return false
    const lose = context.getExtension?.('WEBGL_lose_context')
    lose?.loseContext?.()
    return true
  } catch {
    return false
  }
}
