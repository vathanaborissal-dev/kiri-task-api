/** Shared helpers for the end-to-end suites. */

export const API = process.env.TEST_API_URL ?? 'http://localhost:4100/api';
export const ORIGIN = process.env.TEST_ORIGIN ?? 'http://localhost:3100';

/**
 * A cookie-jar HTTP client that behaves like the browser does: it keeps the
 * session cookies and echoes the CSRF cookie back in the header.
 */
export const createClient = () => {
  const jar = new Map();

  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

  const absorb = (response) => {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
  };

  const call = async (method, path, body, options = {}) => {
    const headers = { origin: ORIGIN, cookie: cookieHeader() };
    if (!options.formData) headers['content-type'] = 'application/json';
    if (jar.get('kiri_csrf')) headers['x-csrf-token'] = jar.get('kiri_csrf');
    if (options.skipCsrf) delete headers['x-csrf-token'];
    if (options.origin) headers.origin = options.origin;

    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      ...(options.formData
        ? { body: options.formData }
        : body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
    });
    absorb(response);

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: response.status, json, headers: response.headers };
  };

  return {
    jar,
    get: (path, options) => call('GET', path, undefined, options),
    post: (path, body, options) => call('POST', path, body, options),
    patch: (path, body, options) => call('PATCH', path, body, options),
    put: (path, body, options) => call('PUT', path, body, options),
    delete: (path, body, options) => call('DELETE', path, body, options),
  };
};

export const signIn = async (email, password) => {
  const client = createClient();
  const result = await client.post('/auth/login', { email, password }, { skipCsrf: true });
  if (result.status !== 200) {
    throw new Error(`sign-in failed for ${email}: ${result.status} ${JSON.stringify(result.json)}`);
  }
  return { client, user: result.json.user };
};

export const unique = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
