import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthContext.jsx'
import { RedirectIfAuthenticated, RequireAuth } from '../auth/guards.jsx'
import Login from '../pages/Login.jsx'
import Signup from '../pages/Signup.jsx'

const ACCOUNT = {
  id: 'account-1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  avatarColor: '#45e0c0',
  preferences: { theme: 'dark', defaultRoom: 'design-team', mutedByDefault: false },
  createdAt: '2026-01-01T00:00:00.000Z',
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null, getSetCookie: () => [] },
  }
}

function installFetch(handler) {
  const mock = vi.fn(handler)
  vi.stubGlobal('fetch', mock)
  return mock
}

function anonymousHandler(overrides = {}) {
  return async (url, options = {}) => {
    const path = String(url)
    const key = `${options.method || 'GET'} ${path}`
    for (const [route, response] of Object.entries(overrides)) {
      if (key.endsWith(route)) return typeof response === 'function' ? response(options) : response
    }
    if (path.endsWith('/api/auth/me')) {
      return jsonResponse(401, { ok: false, error: { code: 'AUTH_REQUIRED' } })
    }
    throw new Error(`Unexpected request: ${key}`)
  }
}

function renderAt(initialEntry, { authenticated = false, extraRoutes = [] } = {}) {
  const handler = anonymousHandler(
    authenticated ? { 'GET /api/auth/me': jsonResponse(200, { ok: true, user: ACCOUNT }) } : {},
  )
  const fetchMock = installFetch(handler)

  const view = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route
            path="/office"
            element={
              <RequireAuth>
                <div>Office stub</div>
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <div>Settings stub</div>
              </RequireAuth>
            }
          />
          {extraRoutes}
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )

  return { ...view, fetchMock }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('login page', () => {
  it('renders labelled email and password fields', async () => {
    renderAt('/login')
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^show characters$/i })).toBeTruthy()
    expect(screen.getByRole('link', { name: /create an account/i })).toBeTruthy()
  })

  it('validates locally and never calls the API for an empty form', async () => {
    const { fetchMock } = renderAt('/login')
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByText('Enter your email address.')).toBeTruthy()
    expect(screen.getByText('Enter your password.')).toBeTruthy()
    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/auth/login'))
    expect(loginCalls).toHaveLength(0)
  })

  it('submits credentials with the session cookie and returns to the intended page', async () => {
    const fetchMock = installFetch(
      anonymousHandler({
        'POST /api/auth/login': jsonResponse(200, { ok: true, user: ACCOUNT }),
      }),
    )

    render(
      <MemoryRouter initialEntries={[{ pathname: '/login', state: { from: { pathname: '/settings' } } }]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <div>Settings stub</div>
                </RequireAuth>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: ' ADA@Example.com ' },
    })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } })
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByText('Settings stub')).toBeTruthy()

    const loginCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/auth/login'))
    expect(loginCall).toBeTruthy()
    const options = loginCall[1]
    expect(options.credentials).toBe('include')
    expect(JSON.parse(options.body).email).toBe('ada@example.com')
  })

  it('shows a generic message for invalid credentials', async () => {
    installFetch(
      anonymousHandler({
        'POST /api/auth/login': jsonResponse(401, {
          ok: false,
          error: { code: 'INVALID_CREDENTIALS' },
        }),
      }),
    )

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Email or password is incorrect.',
    )
  })
})

describe('signup page', () => {
  it('rejects mismatched passwords before hitting the API', async () => {
    const { fetchMock } = renderAt('/signup')

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'different-horse-2' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect(await screen.findByText('The passwords do not match.')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/auth/signup'))).toBe(false)
  })

  it('enforces the password policy in the form', async () => {
    renderAt('/signup')

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'allletters' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'allletters' } })
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect(await screen.findByText('Include at least one letter and one number.')).toBeTruthy()
  })

  it('reports a duplicate email from the server on the email field', async () => {
    installFetch(
      anonymousHandler({
        'POST /api/auth/signup': jsonResponse(409, {
          ok: false,
          error: { code: 'EMAIL_TAKEN' },
        }),
      }),
    )

    render(
      <MemoryRouter initialEntries={['/signup']}>
        <AuthProvider>
          <Routes>
            <Route path="/signup" element={<Signup />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ada Lovelace' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-1' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'correct-horse-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    expect(
      await screen.findByText('An account with that email already exists. Try signing in instead.'),
    ).toBeTruthy()
  })
})

describe('route guards', () => {
  function LoginStub() {
    const location = useLocation()
    return <div>login stub from:{location.state?.from?.pathname || 'none'}</div>
  }

  it('redirects an anonymous visitor away from the office and keeps the destination', async () => {
    installFetch(anonymousHandler())

    render(
      <MemoryRouter initialEntries={['/office']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginStub />} />
            <Route
              path="/office"
              element={
                <RequireAuth>
                  <div>Office stub</div>
                </RequireAuth>
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByText('login stub from:/office')).toBeTruthy()
    expect(screen.queryByText('Office stub')).toBeNull()
  })

  it('redirects an authenticated visitor away from login', async () => {
    installFetch(anonymousHandler({ 'GET /api/auth/me': jsonResponse(200, { ok: true, user: ACCOUNT }) }))

    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/login"
              element={
                <RedirectIfAuthenticated>
                  <div>Login form</div>
                </RedirectIfAuthenticated>
              }
            />
            <Route path="/office" element={<div>Office stub</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByText('Office stub')).toBeTruthy())
    expect(screen.queryByText('Login form')).toBeNull()
  })
})
