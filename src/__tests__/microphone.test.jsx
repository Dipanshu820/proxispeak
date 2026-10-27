import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import VirtualOffice from '../pages/VirtualOffice'
import { installOfficeHarness } from './officeHarness'

let harness
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')

afterEach(() => {
  harness?.uninstall()
  harness = null
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices)
  else delete navigator.mediaDevices
})

function mountOffice() {
  harness = installOfficeHarness()
  return render(<VirtualOffice onHome={() => {}} />)
}

function stubMediaDevices(mediaDevices) {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: mediaDevices,
    configurable: true,
    writable: true,
  })
}

async function enableMic() {
  const button = document.querySelector('button[aria-label="Enable microphone"]')
  await act(async () => {
    fireEvent.click(button)
    // let the rejected getUserMedia promise settle
    await Promise.resolve()
  })
  return button
}

const micState = () =>
  document.querySelector('#audio').textContent.match(/Your microphone\s*(OFF|MUTED|LIVE)/)?.[1]

describe('Microphone failure handling', () => {
  it('reports a problem when the browser exposes no microphone API', async () => {
    delete navigator.mediaDevices
    mountOffice()

    await enableMic()

    expect(micState()).toBe('OFF')
    expect(screen.getByRole('status').textContent).toMatch(/Microphone access failed/i)
  })

  it('reports a problem when permission is denied', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))
    stubMediaDevices({ getUserMedia })
    mountOffice()

    await enableMic()

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(micState()).toBe('OFF')
    expect(screen.getByRole('status').textContent).toMatch(/Microphone access failed/i)
  })

  it('reports a problem when the device is missing', async () => {
    stubMediaDevices({
      getUserMedia: vi.fn().mockRejectedValue(new DOMException('no device', 'NotFoundError')),
    })
    mountOffice()

    await enableMic()

    expect(micState()).toBe('OFF')
    expect(screen.getByRole('status').textContent).toMatch(/Microphone access failed/i)
  })

  it('leaves the input meter untouched when access fails', async () => {
    stubMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(new Error('denied')) })
    mountOffice()

    await enableMic()

    const meter = document.getElementById('micmeter')
    expect(meter.style.getPropertyValue('--level')).toBe('')
    // Mute is disabled while the microphone is off.
    expect(document.querySelector('button[aria-label="Mute microphone"]').disabled).toBe(true)
  })
})
