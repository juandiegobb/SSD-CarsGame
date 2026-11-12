'use strict';

// Taller 7: el coordinador conoce varios auths (AUTH_URLS) y tiene que hablar con el LÍDER,
// porque el directorio (heartbeat y /peers?coordinatorId) solo lo atiende el líder.
//
// Para cada petición:
//   1. prueba primero el auth "actual" (el último que respondió bien) y luego el resto de la lista;
//   2. error de red, timeout, 5xx sin formato del auth o un error que no es JSON
//      (p. ej. la página de ngrok cuando el túnel del auth está apagado) -> prueba el siguiente;
//   3. 503 { error: "not_leader", leaderUrl } -> repite en leaderUrl y desde ahí lo usa como actual;
//   4. 503 { error: "no_leader" } -> hay elección: devuelve esa respuesta y el siguiente
//      heartbeat (2 s después) vuelve a intentar, sin bloquear el game loop.
// Si el líder deja de responder, en la siguiente petición se recorre otra vez toda la lista.

function normalizeAuthUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.search || url.hash) {
      return null;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

// AUTH_URLS="http://a,http://b" -> ['http://a', 'http://b']. Si no hay lista se usa AUTH_URL.
// Devuelve null si alguna URL es inválida (el coordinador no debe arrancar con una lista rota).
function parseAuthUrls(listValue, singleValue, fallback = 'http://localhost:4000') {
  const items = String(listValue || '').split(',').map((item) => item.trim()).filter(Boolean);
  const values = items.length > 0 ? items : [singleValue || fallback];
  const urls = [];
  for (const value of values) {
    const url = normalizeAuthUrl(value);
    if (!url) return null;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function createAuthClient({ urls, fetchImpl = fetch, timeoutMs = 5000, log = console }) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('createAuthClient necesita al menos una URL de auth.');
  }
  let current = urls[0];

  function setCurrent(url, reason) {
    if (url === current) return;
    log.info?.(`[coordinator] Auth activo: ${current} -> ${url} (${reason}).`);
    current = url;
  }

  async function fetchOne(baseUrl, path, options, outerSignal) {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        headers: { 'ngrok-skip-browser-warning': 'true', ...(options.headers || {}) },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      return { response, payload };
    } finally {
      clearTimeout(timeout);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  // Devuelve { response, payload, authUrl }. Lanza error si ningún auth respondió.
  async function request(path, options = {}) {
    const { signal, ...fetchOptions } = options;
    const queue = [current, ...urls.filter((url) => url !== current)];
    const tried = new Set();
    let lastAnswer = null;

    while (queue.length > 0) {
      if (signal?.aborted) break;
      const baseUrl = queue.shift();
      if (tried.has(baseUrl)) continue;
      tried.add(baseUrl);

      let answer;
      try {
        answer = await fetchOne(baseUrl, path, fetchOptions, signal);
      } catch {
        if (signal?.aborted) break;
        continue; // caído o sin red: siguiente de la lista
      }
      const { response, payload } = answer;
      lastAnswer = { response, payload, authUrl: baseUrl };

      if (response.status === 503 && payload?.error === 'not_leader') {
        const leaderUrl = normalizeAuthUrl(payload.leaderUrl);
        if (leaderUrl && !tried.has(leaderUrl)) queue.unshift(leaderUrl);
        continue;
      }
      if (response.status === 503 && payload?.error === 'no_leader') {
        return lastAnswer; // elección en curso: el próximo intento llega en 2 s
      }
      if (response.status >= 500 && typeof payload?.error !== 'string') {
        continue; // p. ej. 502 de ngrok con el auth apagado
      }
      if (!response.ok && payload === null) {
        continue; // error que no viene del auth (página HTML de ngrok, proxy...)
      }

      setCurrent(baseUrl, response.ok ? 'respondió' : `HTTP ${response.status}`);
      return lastAnswer;
    }

    if (lastAnswer) return lastAnswer;
    throw new Error('Ningún auth respondió.');
  }

  return {
    request,
    get currentUrl() {
      return current;
    },
    urls: [...urls]
  };
}

module.exports = { createAuthClient, parseAuthUrls, normalizeAuthUrl };
