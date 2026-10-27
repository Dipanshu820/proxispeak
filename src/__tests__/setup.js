import { beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unit tests must stay hermetic. The jsdom environment inherits Node's global
// fetch, so the office component's session bootstrap would otherwise reach a
// developer's running backend and open real sockets (slow, order-dependent, and
// noisy). Component tests that care about authentication inject their own fetch
// implementation (see src/__tests__/auth.test.js).
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = () =>
    Promise.reject(new TypeError('fetch is disabled in unit tests'));
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});
