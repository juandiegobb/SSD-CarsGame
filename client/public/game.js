// Taller 5: render del juego en el lobby.
// IMPORTANTE: el servidor es la autoridad. Este archivo NO calcula posiciones:
//   - lee el teclado y manda "intent" (dirección -1/0/1) solo cuando cambia,
//   - dibuja las posiciones que llegan en cada mensaje "state".
// Lo único "local" es visual: interpolar entre los dos últimos states para que
// el movimiento se vea fluido a 60 fps aunque el servidor mande 20 por segundo.

(function () {
    const RaceTracks = window.RaceTracks;
    const KEYS = {
        ArrowUp: "up", KeyW: "up",
        ArrowDown: "down", KeyS: "down",
        ArrowLeft: "left", KeyA: "left",
        ArrowRight: "right", KeyD: "right"
    };

    // Color estable por jugador (mismo userId → mismo color en todas las pantallas)
    function colorFor(userId) {
        let hash = 0;
        for (const ch of String(userId)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        // Multiplicar por el "ángulo áureo" (~137.5°) reparte bien los tonos aunque
        // los ids sean consecutivos (1, 2, 3...); con hash % 360 saldrían casi iguales.
        return `hsl(${Math.round((hash * 137.508) % 360)}, 70%, 55%)`;
    }

    // Taller 5, feature extra: el color viaja en extras y lo manda OTRO cliente,
    // así que no confiamos en él: solo aceptamos "#rrggbb"; si no, color por defecto.
    const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
    function carColor(p) {
        const c = p.extras && p.extras.color;
        return typeof c === "string" && HEX_COLOR.test(c) ? c : colorFor(p.userId);
    }

    // Convierte el color por defecto (hsl) a hex, que es lo que entiende <input type="color">
    function defaultColorHex(userId) {
        const probe = document.createElement("canvas").getContext("2d");
        probe.fillStyle = colorFor(userId);
        return probe.fillStyle; // el navegador lo normaliza a "#rrggbb"
    }

    // Insignia junto al nombre: "G" para cuentas de Google, candado para cuentas locales.
    // provider lo pone el coordinador desde el JWT verificado (el cliente no lo puede falsear).
    function drawBadge(ctx, provider, x, y) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fillStyle = provider === "google" ? "#fff" : "#475467";
        ctx.fill();
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (provider === "google") {
            ctx.fillStyle = "#4285f4";
            ctx.fillText("G", x, y + 0.5);
        } else {
            // candado simple dibujado (no depende de que el sistema tenga emojis)
            ctx.strokeStyle = "#fff";
            ctx.fillStyle = "#fff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(x, y - 1.5, 2.5, Math.PI, 0);
            ctx.stroke();
            ctx.fillRect(x - 3.5, y - 1.5, 7, 5);
        }
        ctx.restore();
    }

    function createGame({ canvas, send, myUserId, controls }) {
        const ctx = canvas.getContext("2d");
        let world = { width: 800, height: 600, playerRadius: 20, tickRate: 20 };
        let meId = myUserId || null;
        let prev = null;           // state anterior
        let curr = null;           // state más reciente
        let currAt = 0;            // momento (local) en que llegó curr
        const headings = new Map(); // userId → ángulo del carro (solo visual)
        const pressed = new Set();
        let lastDir = { x: 0, y: 0 };
        let running = true;
        const stage = canvas.parentElement;
        let raceState = {
            level: 1,
            phase: "waiting",
            countdownStartedAt: null,
            serverTime: Date.now(),
            laps: {}
        };
        let raceClockOffset = 0;

        function resize() {
            const dpr = window.devicePixelRatio || 1;
            const scale = stage
                ? Math.min(stage.clientWidth / world.width, stage.clientHeight / world.height)
                : 0;
            canvas.style.width = `${world.width * scale}px`;
            canvas.style.height = `${world.height * scale}px`;
            if (canvas.width !== world.width * dpr) canvas.width = world.width * dpr;
            if (canvas.height !== world.height * dpr) canvas.height = world.height * dpr;
            canvas.style.aspectRatio = `${world.width} / ${world.height}`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        resize();
        if (stage && window.ResizeObserver) {
            new ResizeObserver(resize).observe(stage);
        }

        // ── Entrada: teclado → intent ───────────────────────────────────────
        function currentDir() {
            const x = (pressed.has("right") ? 1 : 0) - (pressed.has("left") ? 1 : 0);
            const y = (pressed.has("down") ? 1 : 0) - (pressed.has("up") ? 1 : 0);
            return { x, y };
        }

        function sendIntentIfChanged() {
            const dir = currentDir();
            if (dir.x === lastDir.x && dir.y === lastDir.y) return; // sin cambios: no saturar la red
            lastDir = dir;
            send({ type: "intent", intent: { dir } });
        }

        function isTyping(event) {
            const el = event.target;
            if (!el || !el.tagName) return false;
            if (el.tagName === "INPUT") return el.type !== "color"; // el selector de color no "escribe"
            return el.tagName === "TEXTAREA" || el.tagName === "SELECT";
        }

        function canDrive() {
            return raceState.phase !== "countdown" && raceState.phase !== "finished";
        }

        function onKeyDown(event) {
            const key = KEYS[event.code];
            if (!key || isTyping(event) || !running || !canDrive()) return;
            event.preventDefault(); // que las flechas no muevan la página
            pressed.add(key);
            sendIntentIfChanged();
        }

        function onKeyUp(event) {
            const key = KEYS[event.code];
            if (!key) return;
            pressed.delete(key);
            sendIntentIfChanged();
        }

        // Si la ventana pierde el foco, soltamos todo (si no, el carro seguiría solo)
        function onBlur() {
            pressed.clear();
            pointerDirections.clear();
            sendIntentIfChanged();
        }

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);

        const controlButtons = controls ? [...controls.querySelectorAll("[data-direction]")] : [];
        const pointerDirections = new Map();

        for (const button of controlButtons) {
            const direction = button.dataset.direction;
            button.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                if (!running || !canDrive()) return;
                button.setPointerCapture?.(event.pointerId);
                pointerDirections.set(event.pointerId, direction);
                pressed.add(direction);
                sendIntentIfChanged();
            });
            button.addEventListener("pointerup", (event) => {
                pointerDirections.delete(event.pointerId);
                if (![...pointerDirections.values()].includes(direction)) pressed.delete(direction);
                sendIntentIfChanged();
            });
            button.addEventListener("pointercancel", (event) => {
                pointerDirections.delete(event.pointerId);
                if (![...pointerDirections.values()].includes(direction)) pressed.delete(direction);
                sendIntentIfChanged();
            });
            button.addEventListener("contextmenu", (event) => event.preventDefault());
        }

        // ── Dibujo ────────────────────────────────────────────────────────────
        function drawTrack() {
            const track = RaceTracks.tracks.find((item) => item.id === raceState.level) || RaceTracks.tracks[0];
            const points = RaceTracks.scaledPoints(track, world.width, world.height);
            const scale = Math.min(world.width / RaceTracks.WORLD_WIDTH, world.height / RaceTracks.WORLD_HEIGHT);
            const roadWidth = track.roadWidth * scale;
            ctx.fillStyle = "#e9d8b5";
            ctx.fillRect(0, 0, world.width, world.height);

            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
            ctx.closePath();
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.strokeStyle = "#b92c24";
            ctx.lineWidth = roadWidth + 18 * scale;
            ctx.stroke();
            ctx.setLineDash([24 * scale, 18 * scale]);
            ctx.strokeStyle = "#fff8e9";
            ctx.lineWidth = roadWidth + 8 * scale;
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.strokeStyle = "#a96d37";
            ctx.lineWidth = roadWidth - 4 * scale;
            ctx.stroke();
            ctx.setLineDash([13 * scale, 16 * scale]);
            ctx.strokeStyle = "rgba(255, 231, 184, .48)";
            ctx.lineWidth = 2 * scale;
            ctx.stroke();
            ctx.setLineDash([]);
            drawTrackDecorations(track, points, scale);
        }

        function drawTrackDecorations(track, points, scale) {
            const start = points[0];
            const next = points[1];
            const angle = Math.atan2(next.y - start.y, next.x - start.x);
            ctx.save();
            ctx.translate(start.x, start.y);
            ctx.rotate(angle);
            const roadWidth = track.roadWidth * scale;
            const tileWidth = 12 * scale;
            const tileDepth = 9 * scale;
            for (let row = 0; row < Math.ceil(roadWidth / tileWidth); row += 1) {
                for (let column = 0; column < 2; column += 1) {
                    ctx.fillStyle = (row + column) % 2 ? "#242424" : "#fff";
                    ctx.fillRect(
                        -tileDepth + column * tileDepth,
                        -roadWidth / 2 + row * tileWidth,
                        tileDepth,
                        tileWidth
                    );
                }
            }
            ctx.restore();

            for (const obstacle of track.obstacles) {
                const x = obstacle.x * world.width / RaceTracks.WORLD_WIDTH;
                const y = obstacle.y * world.height / RaceTracks.WORLD_HEIGHT;
                ctx.save();
                ctx.translate(x, y);
                if (obstacle.shape === "diamond") {
                    ctx.rotate(Math.PI / 4);
                    ctx.fillStyle = "#8eb2b4";
                    ctx.strokeStyle = "#d9e7dc";
                    ctx.lineWidth = 5 * scale;
                    ctx.fillRect(-42 * scale, -42 * scale, 84 * scale, 84 * scale);
                    ctx.strokeRect(-42 * scale, -42 * scale, 84 * scale, 84 * scale);
                } else {
                    ctx.fillStyle = "#758e91";
                    ctx.strokeStyle = "#b5d0ca";
                    ctx.lineWidth = 4 * scale;
                    ctx.beginPath();
                    ctx.moveTo(-26 * scale, 12 * scale);
                    ctx.lineTo(-18 * scale, -18 * scale);
                    ctx.lineTo(5 * scale, -30 * scale);
                    ctx.lineTo(28 * scale, -9 * scale);
                    ctx.lineTo(22 * scale, 20 * scale);
                    ctx.lineTo(-4 * scale, 28 * scale);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.restore();
            }
        }

        function drawRaceOverlay() {
            if (raceState.phase !== "countdown") return;
            const elapsed = Math.max(0, Date.now() + raceClockOffset - raceState.countdownStartedAt);
            const activeLight = Math.min(2, Math.floor(elapsed / 2000));
            const remaining = Math.max(1, 2 - Math.floor((elapsed % 2000) / 1000));
            const colors = ["#f12232", "#ffe32b", "#35e64b"];
            const centerX = world.width / 2;
            const centerY = world.height / 2;
            const panelWidth = 150;
            const panelHeight = 330;
            const top = centerY - panelHeight / 2;

            ctx.save();
            ctx.fillStyle = "rgba(15, 19, 26, .94)";
            roundRect(centerX - panelWidth / 2, top, panelWidth, panelHeight, 24);
            ctx.fill();
            ctx.strokeStyle = "#343a43";
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.font = "700 20px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(`NIVEL ${raceState.level}`, centerX, top + 28);

            for (let index = 0; index < 3; index += 1) {
                const y = top + 88 + index * 75;
                ctx.beginPath();
                ctx.arc(centerX, y, 28, 0, Math.PI * 2);
                ctx.fillStyle = index === activeLight ? colors[index] : "#373a3d";
                ctx.shadowColor = index === activeLight ? colors[index] : "transparent";
                ctx.shadowBlur = index === activeLight ? 24 : 0;
                ctx.fill();
                ctx.shadowBlur = 0;
                ctx.strokeStyle = index === activeLight ? "rgba(255,255,255,.55)" : "#1d2024";
                ctx.lineWidth = 4;
                ctx.stroke();
            }

            ctx.fillStyle = "#fff";
            ctx.font = "700 22px system-ui, sans-serif";
            ctx.fillText(activeLight === 2 ? "¡YA!" : String(remaining), centerX, top + 310);
            ctx.restore();
        }

        function drawRaceFinished() {
            if (raceState.phase !== "finished") return;
            ctx.save();
            ctx.fillStyle = "rgba(12, 18, 28, .82)";
            ctx.fillRect(0, world.height / 2 - 54, world.width, 108);
            ctx.fillStyle = "#ffe16a";
            ctx.font = "700 34px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("¡CARRERA COMPLETADA!", world.width / 2, world.height / 2);
            ctx.restore();
        }

        function roundRect(x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.arcTo(x + w, y, x + w, y + h, r);
            ctx.arcTo(x + w, y + h, x, y + h, r);
            ctx.arcTo(x, y + h, x, y, r);
            ctx.arcTo(x, y, x + w, y, r);
            ctx.closePath();
        }

        function drawCar(p, x, y, angle, isMe) {
            const r = world.playerRadius;
            const len = r * 2;        // largo del carro = diámetro del jugador
            const wid = r * 1.2;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(angle);

            if (isMe) { // halo para reconocer tu carro
                ctx.beginPath();
                ctx.arc(0, 0, r + 6, 0, Math.PI * 2);
                ctx.fillStyle = "rgba(255,255,255,0.15)";
                ctx.fill();
            }
            // llantas
            ctx.fillStyle = "#111";
            for (const [wx, wy] of [[-len * 0.3, -wid / 2], [len * 0.3, -wid / 2], [-len * 0.3, wid / 2], [len * 0.3, wid / 2]]) {
                ctx.fillRect(wx - 5, wy - 3, 10, 6);
            }
            // carrocería
            roundRect(-len / 2, -wid / 2, len, wid, 6);
            ctx.fillStyle = p.color;
            ctx.fill();
            ctx.lineWidth = isMe ? 2.5 : 1.5;
            ctx.strokeStyle = isMe ? "#fff" : "rgba(0,0,0,0.5)";
            ctx.stroke();
            // parabrisas (indica hacia dónde mira)
            roundRect(len * 0.08, -wid / 2 + 4, len * 0.22, wid - 8, 3);
            ctx.fillStyle = "rgba(20,30,45,0.8)";
            ctx.fill();
            ctx.restore();

            // nombre (sin rotar)
            ctx.font = "600 13px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            const displayUsername = typeof p.username === "string" ? p.username.trim().toLowerCase() : p.username;
            const label = isMe ? `${displayUsername} (tú)` : displayUsername;
            const textWidth = ctx.measureText(label).width;
            const labelX = x + 10; // corrido a la derecha para dejar espacio a la insignia
            const labelY = y - r - 6;
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(0,0,0,0.7)";
            ctx.strokeText(label, labelX, labelY);
            ctx.fillStyle = "#fff";
            ctx.fillText(label, labelX, labelY);
            drawBadge(ctx, p.provider, labelX - textWidth / 2 - 11, labelY - 7);
        }

        function frame() {
            if (!running) return;
            drawTrack();
            // Se dibuja lo que haya en window.lastState (lo último que mandó el servidor,
            // o lo que alguien haya alterado a mano en DevTools hasta el próximo tick).
            if (window.lastState && Array.isArray(window.lastState.players)) curr = window.lastState;
            if (curr) {
                // alpha: qué tan lejos estamos entre prev y curr (0 → prev, 1 → curr)
                const tickMs = 1000 / world.tickRate;
                const alpha = Math.min(1, (performance.now() - currAt) / tickMs);
                const before = new Map((prev ? prev.players : []).map((p) => [p.userId, p]));
                const list = [...curr.players].sort((a, b) => (a.userId === meId) - (b.userId === meId)); // el tuyo encima
                for (const p of list) {
                    const old = before.get(p.userId) || p;
                    const x = old.x + (p.x - old.x) * alpha;
                    const y = old.y + (p.y - old.y) * alpha;
                    const dx = p.x - old.x;
                    const dy = p.y - old.y;
                    if (Math.hypot(dx, dy) > 0.5) headings.set(p.userId, Math.atan2(dy, dx));
                    drawCar({ ...p, color: carColor(p) }, x, y, headings.get(p.userId) || 0, p.userId === meId);
                }
            }
            drawRaceOverlay();
            drawRaceFinished();
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        function setRaceState(next) {
            if (!next || !Number.isInteger(next.level) || next.level < 1 || next.level > RaceTracks.tracks.length ||
                !["waiting", "countdown", "racing", "finished"].includes(next.phase)) return;
            const changed = raceState.level !== next.level ||
                raceState.phase !== next.phase ||
                raceState.countdownStartedAt !== next.countdownStartedAt;
            const previousPhase = raceState.phase;
            if (changed && Number.isFinite(next.serverTime)) {
                raceClockOffset = next.serverTime - Date.now();
            }
            raceState = {
                level: next.level,
                phase: next.phase,
                countdownStartedAt: Number.isFinite(next.countdownStartedAt) ? next.countdownStartedAt : null,
                serverTime: Number.isFinite(next.serverTime) ? next.serverTime : Date.now(),
                laps: next.laps && typeof next.laps === "object" ? next.laps : {}
            };
            if (changed && (raceState.phase === "countdown" || previousPhase === "countdown")) {
                pressed.clear();
                pointerDirections.clear();
                lastDir = { x: 0, y: 0 };
                send({ type: "intent", intent: { dir: lastDir } });
            }
        }

        return {
            onWelcome(msg) {
                if (msg.world) world = { ...world, ...msg.world };
                if (msg.you) meId = msg.you.userId;
                resize();
            },
            onState(msg) {
                if (msg.race) setRaceState(msg.race);
                if (!Array.isArray(msg.players)) return;
                prev = curr;
                curr = msg;
                // Referencia global para la demostración de autoridad desde DevTools.
                // Solo afecta el dibujo local; no se envía al coordinador.
                window.lastState = curr;
                currAt = performance.now();
                for (const id of headings.keys()) {
                    if (!msg.players.some((p) => p.userId === id)) headings.delete(id);
                }
            },
            onRaceUpdate(next) {
                setRaceState(next);
            },
            // Taller 6: al reconectar a otro coordinador se arranca limpio:
            // sin fotos viejas, sin teclas "pegadas" y volviendo a escuchar el teclado.
            resume() {
                prev = null;
                curr = null;
                window.lastState = null;
                headings.clear();
                pressed.clear();
                pointerDirections.clear();
                lastDir = { x: 0, y: 0 };
                if (running) return;
                running = true;
                window.addEventListener("keydown", onKeyDown);
                window.addEventListener("keyup", onKeyUp);
                window.addEventListener("blur", onBlur);
                requestAnimationFrame(frame);
            },
            stop() {
                running = false;
                window.removeEventListener("keydown", onKeyDown);
                window.removeEventListener("keyup", onKeyUp);
                window.removeEventListener("blur", onBlur);
            }
        };
    }

    window.createGame = createGame;
    window.defaultCarColor = defaultColorHex;
})();
