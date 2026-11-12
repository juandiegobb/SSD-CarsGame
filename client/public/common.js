function getAppConfig() {
    if (!window.APP_CONFIG || !window.APP_CONFIG.AUTH_URL || !window.APP_CONFIG.COORDINATOR_WS_URL) {
        throw new Error("No se pudo cargar la configuración del cliente.");
    }
    return window.APP_CONFIG;
}

// ---------------------------------------------------------------------------
// Taller 7: el auth ahora son 3 nodos (un líder y dos réplicas). El cliente
// recibe la lista AUTH_URLS y para cada petición:
//   1. prueba primero el último auth que funcionó (o el primero de la lista);
//   2. error de red, timeout o 5xx  -> prueba el siguiente de la lista;
//   3. 503 { error: "not_leader", leaderUrl } -> repite la petición en leaderUrl;
//   4. 503 { error: "no_leader" } (elección en curso) -> espera ~1 s y reintenta.
// Un 5xx con error propio del auth (p. ej. "replication_timeout") es una respuesta
// definitiva: NO se repite en otro auth para no duplicar una escritura.
// Si solo existe AUTH_URL (talleres anteriores) se usa como lista de un elemento.
// ---------------------------------------------------------------------------
const AUTH_LAST_GOOD_KEY = "authLastGoodUrl";
const AUTH_REQUEST_TIMEOUT_MS = 8000;
const AUTH_NO_LEADER_WAIT_MS = 1000;
const AUTH_MAX_ROUNDS = 12; // ~12 s: lo que tarda en peor caso una elección

function normalizeAuthUrl(value) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
            return null;
        }
        return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
        return null;
    }
}

function readLastGoodAuthUrl() {
    try {
        return window.sessionStorage ? window.sessionStorage.getItem(AUTH_LAST_GOOD_KEY) : null;
    } catch {
        return null;
    }
}

function rememberAuthUrl(url) {
    try {
        if (window.sessionStorage) window.sessionStorage.setItem(AUTH_LAST_GOOD_KEY, url);
    } catch {
        // sessionStorage puede no existir (pruebas) o estar bloqueado: solo se pierde la preferencia.
    }
}

function getAuthUrls() {
    const config = getAppConfig();
    const configured = Array.isArray(config.AUTH_URLS) && config.AUTH_URLS.length > 0
        ? config.AUTH_URLS
        : [config.AUTH_URL];
    const urls = [];
    for (const value of configured) {
        const url = normalizeAuthUrl(value);
        if (url && !urls.includes(url)) urls.push(url);
    }
    if (urls.length === 0) throw new Error("No se pudo cargar la configuración del cliente.");

    // El último auth que respondió bien va primero (si sigue en la lista o fue un leaderUrl).
    const lastGood = normalizeAuthUrl(readLastGoodAuthUrl());
    if (lastGood) {
        const index = urls.indexOf(lastGood);
        if (index > 0) urls.splice(index, 1);
        if (index !== 0) urls.unshift(lastGood);
    }
    return urls;
}

// URL del auth que respondió la última petición (para mostrarlo en la UI).
function currentAuthUrl() {
    try {
        return getAuthUrls()[0];
    } catch {
        return null;
    }
}

const authSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOneAuth(baseUrl, path, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl}${path}`, {
            ...options,
            headers: { "ngrok-skip-browser-warning": "true", ...(options.headers || {}) },
            signal: controller.signal
        });
        const payload = await response.json().catch(() => null);
        return { response, payload };
    } finally {
        clearTimeout(timeout);
    }
}

// Devuelve { response, payload, authUrl }. Lanza error solo si ningún auth respondió.
async function authFetch(path, options = {}) {
    const urls = getAuthUrls();
    let lastAnswer = null;

    for (let round = 0; round < AUTH_MAX_ROUNDS; round += 1) {
        const queue = [...urls];
        const tried = new Set();
        let failoverInProgress = false;

        while (queue.length > 0) {
            const baseUrl = queue.shift();
            if (tried.has(baseUrl)) continue;
            tried.add(baseUrl);

            let answer;
            try {
                answer = await fetchOneAuth(baseUrl, path, options);
            } catch {
                console.warn(`[auth] ${baseUrl} no responde, se prueba el siguiente.`);
                continue;
            }
            const { response, payload } = answer;
            lastAnswer = { ...answer, authUrl: baseUrl };

            if (response.status === 503 && payload && payload.error === "not_leader") {
                const leaderUrl = normalizeAuthUrl(payload.leaderUrl);
                if (leaderUrl && !tried.has(leaderUrl)) {
                    console.info(`[auth] ${baseUrl} es réplica; se repite la petición en el líder ${leaderUrl}.`);
                    queue.unshift(leaderUrl);
                } else {
                    failoverInProgress = true; // el líder que anuncia ya no responde
                }
                continue;
            }
            if (response.status === 503 && payload && payload.error === "no_leader") {
                console.info(`[auth] ${baseUrl}: elección de líder en curso.`);
                failoverInProgress = true;
                continue;
            }
            const definitiveError = payload && typeof payload.error === "string";
            if (typeof response.status === "number" && response.status >= 500 && !definitiveError) {
                console.warn(`[auth] ${baseUrl} respondió ${response.status}, se prueba el siguiente.`);
                continue;
            }

            if (!(response.status >= 500)) rememberAuthUrl(baseUrl);
            return lastAnswer;
        }

        // Nadie pudo atender. Solo se espera y reintenta si hay un cambio de líder en curso.
        if (!failoverInProgress) break;
        await authSleep(AUTH_NO_LEADER_WAIT_MS);
    }

    if (lastAnswer) return lastAnswer;
    throw new Error("Ningún auth respondió.");
}

// Taller 7: a qué auth está hablando el cliente ahora mismo (para mostrarlo en la UI).
// GET /status lo responde cualquier auth; authFetch lo manda al último que funcionó,
// así que si ese auth se cae, la etiqueta cambia sola al siguiente.
async function requestAuthStatus() {
    try {
        const { response, payload, authUrl } = await authFetch("/status", { cache: "no-store" });
        if (response.ok && payload && typeof payload.authId === "string") {
            return {
                ok: true,
                authId: payload.authId,
                role: typeof payload.role === "string" ? payload.role : null,
                term: Number.isInteger(payload.term) ? payload.term : null,
                authUrl
            };
        }
        // Auth de talleres anteriores (sin /status): solo sabemos su URL.
        return { ok: false, authUrl };
    } catch {
        return { ok: false, networkError: true };
    }
}

function authRoleLabel(role) {
    if (role === "leader") return "líder";
    if (role === "replica") return "réplica";
    if (role === "candidate") return "en elección";
    return role || "";
}

async function apiPost(path, body) {
    let response;
    let payload;

    try {
        ({ response, payload } = await authFetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        }));
    } catch {
        return { ok: false, valid: false, networkError: true };
    }

    if (!payload || typeof payload !== "object" || typeof payload.message !== "string") {
        return { ok: false, valid: false, status: response.status };
    }

    if (response.ok && payload.ok === true) {
        return { ok: true, valid: true, status: response.status, payload };
    }

    if (
        payload.ok === false &&
        typeof payload.code === "string" &&
        typeof payload.hint === "string"
    ) {
        return { ok: false, valid: true, status: response.status, payload };
    }

    return { ok: false, valid: false, status: response.status };
}

// Taller 6: el auth (directory service) dice a qué coordinador conectarse.
// Devuelve { ok: true, coordinatorId, coordinatorName, publicUrl } o { ok: false, status, payload }
// (o { ok: false, networkError: true } si el auth no responde).
function normalizeCoordinatorUrl(value) {
    try {
        const url = new URL(value);
        if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            return null;
        }
        return `${url.protocol}//${url.host}`;
    } catch {
        return null;
    }
}

async function requestCoordinator() {
    let response;
    let payload = null;

    try {
        ({ response, payload } = await authFetch("/coordinator", { cache: "no-store" }));
    } catch {
        return { ok: false, networkError: true };
    }

    if (response.ok && payload && typeof payload.coordinatorId === "string" && typeof payload.publicUrl === "string") {
        const publicUrl = normalizeCoordinatorUrl(payload.publicUrl);
        if (!publicUrl) return { ok: false, status: response.status, payload: null };
        return {
            ok: true,
            coordinatorId: payload.coordinatorId,
            coordinatorName: typeof payload.coordinatorName === "string" ? payload.coordinatorName : payload.coordinatorId,
            publicUrl
        };
    }

    return { ok: false, status: response.status, payload };
}

function coordinatorPlayersUrl(value) {
    try {
        const url = new URL(value);
        if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            return null;
        }
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        url.pathname = "/players";
        return url.toString();
    } catch {
        return null;
    }
}

async function fetchRosterResponse(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
        const response = await fetch(url, {
            headers: { "ngrok-skip-browser-warning": "true" },
            cache: "no-store",
            signal: controller.signal
        });
        return { response, payload: await response.json().catch(() => null) };
    } finally {
        clearTimeout(timeout);
    }
}

async function requestGlobalPlayers() {
    let response;
    let payload;
    try {
        ({ response, payload } = await authFetch("/coordinators", { cache: "no-store" }));
    } catch {
        return { ok: false, reason: "directory-unavailable", coordinators: [] };
    }

    if (!response.ok || payload?.ok !== true || !Array.isArray(payload.coordinators)) {
        return { ok: false, reason: "directory-invalid", coordinators: [] };
    }

    const activeCoordinators = payload.coordinators.filter((coordinator) =>
        coordinator?.live === true &&
        typeof coordinator.coordinatorId === "string" &&
        coordinator.coordinatorId.length > 0
    );
    const coordinators = await Promise.all(activeCoordinators.map(async (coordinator) => {
        const result = {
            coordinatorId: coordinator.coordinatorId,
            coordinatorName: typeof coordinator.coordinatorName === "string"
                ? coordinator.coordinatorName
                : coordinator.coordinatorId,
            ok: false,
            players: []
        };
        const endpoint = coordinatorPlayersUrl(coordinator.publicUrl);
        if (!endpoint) return result;

        try {
            const { response: playerResponse, payload: playerPayload } = await fetchRosterResponse(endpoint);
            if (
                !playerResponse.ok ||
                playerPayload?.ok !== true ||
                !Array.isArray(playerPayload.players) ||
                !playerPayload.players.every((player) =>
                    player &&
                    (typeof player.userId === "string" || typeof player.userId === "number") &&
                    typeof player.username === "string"
                )
            ) {
                return result;
            }

            result.ok = true;
            result.players = playerPayload.players.map((player) => ({
                ...player,
                coordinatorId: typeof player.coordinatorId === "string"
                    ? player.coordinatorId
                    : result.coordinatorId,
                coordinatorName: typeof player.coordinatorName === "string"
                    ? player.coordinatorName
                    : result.coordinatorName
            }));
        } catch {
            return result;
        }
        return result;
    }));

    return { ok: true, coordinators };
}

function mergePlayerLists(...lists) {
    const playersById = new Map();
    for (const players of lists) {
        if (!Array.isArray(players)) continue;
        for (const player of players) {
            if (
                !player ||
                (typeof player.userId !== "string" && typeof player.userId !== "number") ||
                typeof player.username !== "string"
            ) {
                continue;
            }
            const userId = String(player.userId);
            playersById.set(userId, {
                ...playersById.get(userId),
                ...player,
                userId
            });
        }
    }
    return [...playersById.values()];
}

async function requestWsTicket(coordinatorUrl, token) {
    try {
        const normalizedUrl = normalizeCoordinatorUrl(coordinatorUrl);
        if (!normalizedUrl) return { ok: false };
        const endpoint = new URL(normalizedUrl);
        if (endpoint.protocol === "wss:") endpoint.protocol = "https:";
        else if (endpoint.protocol === "ws:") endpoint.protocol = "http:";
        else return { ok: false };
        endpoint.pathname = "/ws-ticket";
        endpoint.search = "";
        endpoint.hash = "";

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "ngrok-skip-browser-warning": "true"
            },
            cache: "no-store"
        });
        const payload = await response.json().catch(() => null);
        if (response.ok && payload?.ok === true && typeof payload.ticket === "string") {
            return { ok: true, ticket: payload.ticket };
        }
        return { ok: false, status: response.status, payload };
    } catch {
        return { ok: false, networkError: true };
    }
}

function getToken() {
    return localStorage.getItem("token");
}

function normalizeUsername(username) {
    return typeof username === "string" ? username.trim().toLowerCase() : username;
}

function setCredentials(token, username) {
    localStorage.setItem("token", token);
    localStorage.setItem("username", normalizeUsername(username));
}

function clearCredentials() {
    localStorage.removeItem("token");
    localStorage.removeItem("username");
}

// Traduce los códigos técnicos del servidor a mensajes sencillos para el usuario.
function friendlyFeedback(payload, fallbackMessage = "No se pudo completar la acción.") {
    const feedback = {
        INVALID_USERNAME: {
            message: "Ese nombre de usuario no es válido.",
            hint: "Usa entre 3 y 32 letras, números o guiones bajos."
        },
        INVALID_PASSWORD: {
            message: "La contraseña debe tener una longitud válida.",
            hint: "Escribe entre 8 y 72 caracteres."
        },
        INVALID_CREDENTIALS: {
            message: "El usuario o la contraseña no son correctos.",
            hint: "Revisa los datos o crea una cuenta nueva."
        },
        USERNAME_TAKEN: {
            message: "Ese nombre de usuario ya está registrado.",
            hint: "Elige otro nombre o inicia sesión con el que ya tienes."
        },
        INVALID_BODY: {
            message: "Faltan algunos datos para continuar.",
            hint: "Completa los campos solicitados e inténtalo de nuevo."
        },
        USE_GOOGLE_LOGIN: {
            message: "Esta cuenta se creó con Google.",
            hint: "Continúa usando el botón " + "Iniciar sesión con Google" + " en esta página."
        },
        GOOGLE_NOT_CONFIGURED: {
            message: "El inicio de sesión con Google no está disponible ahora.",
            hint: "Intenta entrar con tu nombre de usuario y contraseña."
        },
        INVALID_ID_TOKEN: {
            message: "No pudimos verificar la cuenta de Google.",
            hint: "Pulsa nuevamente el botón de Google para intentarlo otra vez."
        },
        USERNAME_REQUIRED: {
            message: "Necesitamos elegir cómo te verás en el juego.",
            hint: "Escribe el nombre de usuario que quieres usar."
        },
        TOKEN_MISSING: {
            message: "Tu sesión no está disponible.",
            hint: "Inicia sesión nuevamente para continuar."
        },
        TOKEN_EXPIRED: {
            message: "Tu sesión ha terminado por seguridad.",
            hint: "Inicia sesión otra vez para volver al juego."
        },
        TOKEN_INVALID_SIGNATURE: {
            message: "No pudimos reconocer tu sesión.",
            hint: "Inicia sesión nuevamente para continuar."
        },
        TOKEN_MALFORMED: {
            message: "Tu sesión no es válida.",
            hint: "Inicia sesión nuevamente para continuar."
        },
        TICKET_INVALID: {
            message: "La conexión segura ya no es válida.",
            hint: "Vuelve a conectarte para solicitar un ticket nuevo."
        },
        TOKEN_MISMATCH: {
            message: "Esta sesión corresponde a otra cuenta.",
            hint: "Inicia sesión en la cuenta que quieres usar."
        },
        TOKEN_TRANSPORT_UNSUPPORTED: {
            message: "La conexión usa un método de autenticación antiguo.",
            hint: "Recarga la página para usar el método seguro actual."
        },
        NO_COORDINATORS_AVAILABLE: {
            message: "No hay coordinadores de juego disponibles en este momento.",
            hint: "Estamos reintentando automáticamente; si sigue así, avisa a quien administra el juego."
        },
        AUTH_UNREACHABLE: {
            message: "No pudimos contactar al servicio que asigna el coordinador.",
            hint: "Estamos reintentando automáticamente; revisa tu conexión a internet."
        },
        INVALID_JSON: {
            message: "La información enviada al juego no se pudo leer.",
            hint: "Actualiza la página e inténtalo nuevamente."
        },
        INVALID_INTENT: {
            message: "No pudimos interpretar ese movimiento.",
            hint: "Inténtalo de nuevo usando los controles del juego."
        },
        INVALID_EXTRAS: {
            message: "Ese color de carro no se pudo aplicar.",
            hint: "Elige otro color con el selector."
        },
        UNKNOWN_MESSAGE_TYPE: {
            message: "El juego recibió una acción que no reconoce.",
            hint: "Recarga el juego si el problema continúa."
        },
        MIGRATION_NOT_PENDING: {
            message: "No hay un cambio de coordinador pendiente.",
            hint: "Conserva la conexión actual y espera un nuevo balanceo."
        },
        INVALID_ROOM_NAME: { message: "Ese nombre de sala no es válido.", hint: "Usa entre 3 y 32 letras, números, espacios o guiones." },
        ROOM_NOT_FOUND: { message: "La sala ya no está disponible.", hint: "Regresa al listado y elige otra sala." },
        ROOM_FULL: { message: "Esta sala ya está completa.", hint: "Elige una sala con espacio para nuevos pilotos." },
        ROOM_ALREADY_STARTED: { message: "Esta partida ya comenzó.", hint: "Espera a que termine o elige otra sala." },
        ROOM_ALREADY_JOINED: { message: "Ya estás dentro de una sala.", hint: "Sal de la sala actual antes de cambiar de sala." },
        NOT_ROOM_HOST: { message: "Solo el creador actual puede realizar esta acción.", hint: "Espera a que el creador inicie la partida o transfiera el rol." },
        MIN_PLAYERS_REQUIRED: { message: "Todavía faltan pilotos.", hint: "Necesitas al menos 2 jugadores para iniciar." },
        HOST_TRANSFER_TO_SELF: { message: "No puedes transferirte el rol de creador a ti mismo.", hint: "Selecciona a otro participante de la sala." },
        ROOM_MEMBER_NOT_FOUND: { message: "Ese participante ya no está en la sala.", hint: "Elige a un participante que siga dentro de la sala." },
        COLOR_INVALID: { message: "Ese color de carro no es válido.", hint: "Elige uno usando el selector de color." },
        COLOR_TAKEN: { message: "Otro piloto ya eligió ese color.", hint: "Elige un color diferente para tu carro." },
        ROOM_NOT_JOINED: { message: "Todavía no estás dentro de una sala.", hint: "Crea una sala o únete a una disponible." }
    };

    if (payload && payload.code && feedback[payload.code]) return feedback[payload.code];
    if (payload && payload.ok === true && payload.message) {
        const isRegistration = /registrado exitosamente/i.test(payload.message);
        return {
            message: isRegistration ? "¡Cuenta creada! Ya puedes iniciar sesión." : payload.message,
            hint: ""
        };
    }
    return { message: fallbackMessage, hint: "" };
}
