function getAppConfig() {
    if (!window.APP_CONFIG || !window.APP_CONFIG.AUTH_URL || !window.APP_CONFIG.COORDINATOR_WS_URL) {
        throw new Error("No se pudo cargar la configuración del cliente.");
    }
    return window.APP_CONFIG;
}

async function apiPost(path, body) {
    let response;
    let payload;

    try {
        const { AUTH_URL } = getAppConfig();
        response = await fetch(`${AUTH_URL}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "ngrok-skip-browser-warning": "true"
            },
            body: JSON.stringify(body)
        });
        payload = await response.json();
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
// Devuelve { ok: true, coordinatorId, publicUrl } o { ok: false, status, payload }
// (o { ok: false, networkError: true } si el auth no responde).
async function requestCoordinator() {
    let response;
    let payload = null;

    try {
        const { AUTH_URL } = getAppConfig();
        response = await fetch(`${AUTH_URL}/coordinator`, {
            headers: { "ngrok-skip-browser-warning": "true" },
            cache: "no-store"
        });
        payload = await response.json().catch(() => null);
    } catch {
        return { ok: false, networkError: true };
    }

    if (
        response.ok &&
        payload &&
        typeof payload.coordinatorId === "string" &&
        typeof payload.publicUrl === "string"
    ) {
        return {
            ok: true,
            coordinatorId: payload.coordinatorId,
            publicUrl: payload.publicUrl.replace(/\/+$/, "")
        };
    }

    return { ok: false, status: response.status, payload };
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
        TOKEN_MISMATCH: {
            message: "Esta sesión corresponde a otra cuenta.",
            hint: "Inicia sesión en la cuenta que quieres usar."
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
        INVALID_ROOM_NAME: { message: "Ese nombre de sala no es válido.", hint: "Usa entre 3 y 32 letras, números, espacios o guiones." },
        ROOM_NOT_FOUND: { message: "La sala ya no está disponible.", hint: "Regresa al listado y elige otra sala." },
        ROOM_FULL: { message: "Esta sala ya está completa.", hint: "Elige una sala con espacio para nuevos pilotos." },
        ROOM_ALREADY_STARTED: { message: "Esta partida ya comenzó.", hint: "Espera a que termine o elige otra sala." },
        ROOM_ALREADY_JOINED: { message: "Ya estás dentro de una sala.", hint: "Sal de la sala actual antes de cambiar de sala." },
        NOT_ROOM_HOST: { message: "Solo el creador puede iniciar la carrera.", hint: "Espera a que el creador pulse Iniciar partida." },
        MIN_PLAYERS_REQUIRED: { message: "Todavía faltan pilotos.", hint: "Necesitas al menos 2 jugadores para iniciar." },
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
