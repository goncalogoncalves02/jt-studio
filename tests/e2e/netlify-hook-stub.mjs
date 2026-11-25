const realFetch = globalThis.fetch.bind(globalThis);
const destination = process.env.JT_TASK7_HOOK_STUB_URL;

globalThis.fetch = async (input, init) => {
  let url;
  try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
  catch { return realFetch(input, init); }
  if (url.hostname !== 'api.netlify.com') return realFetch(input, init);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
      || !/^\/build_hooks\/[A-Za-z0-9_-]{8,128}$/u.test(url.pathname)
      || url.search !== '?trigger_branch=main' || !destination) {
    throw new TypeError('Blocked an unapproved Netlify hook request in the local Task 7 proof.');
  }
  process.stderr.write('task7-hook-intercept-enter\n');
  const stubUrl = new URL(destination);
  stubUrl.search = url.search;
  process.stderr.write(`task7-hook-destination-local-${stubUrl.hostname === '127.0.0.1'}-path-${stubUrl.pathname === '/capture'}-branch-${stubUrl.search === '?trigger_branch=main'}-port-match-${stubUrl.port === process.env.JT_TASK7_HOOK_STUB_PORT}\n`);
  const inputIsRequest = typeof Request !== 'undefined' && input instanceof Request;
  const method = init?.method ?? (inputIsRequest ? input.method : undefined);
  const headers = init?.headers ?? (inputIsRequest ? input.headers : undefined);
  const body = init?.body ?? (inputIsRequest ? input.body : undefined);
  process.stderr.write(`task7-hook-forward-method-${method ?? 'default'}-request-input-${inputIsRequest}\n`);
  try {
    const response = await realFetch(stubUrl, {
      method,
      headers,
      body,
      ...(body && typeof body.getReader === 'function' ? { duplex: 'half' } : {}),
      signal: init?.signal,
      redirect: 'error',
    });
    process.stderr.write(`task7-hook-intercept-status-${response.status}\n`);
    return response;
  } catch {
    process.stderr.write('task7-hook-intercept-transport-error\n');
    throw new TypeError('The controlled local hook transport failed.');
  }
};
