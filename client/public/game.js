// Taller 5: render del juego en el lobby.
// IMPORTANTE: el servidor es la autoridad. Este archivo NO calcula posiciones:
//   - lee el teclado y manda "intent" (dirección -1/0/1) solo cuando cambia,
//   - dibuja las posiciones que llegan en cada mensaje "state".
// Lo único "local" es visual: interpolar entre los dos últimos states para que
// el movimiento se vea fluido a 60 fps aunque el servidor mande 20 por segundo.

(function () {
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

    function createGame({ canvas, send, myUserId }) {
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

        function resize() {
            const dpr = window.devicePixelRatio || 1;
            canvas.width = world.width * dpr;
            canvas.height = world.height * dpr;
            canvas.style.aspectRatio = `${world.width} / ${world.height}`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        resize();

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
            const tag = event.target && event.target.tagName;
            return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        }

        function onKeyDown(event) {
            const key = KEYS[event.code];
            if (!key || isTyping(event) || !running) return;
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
            sendIntentIfChanged();
        }

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);

        // ── Dibujo ────────────────────────────────────────────────────────────
        function drawTrack() {
            ctx.fillStyle = "#2b2f36";
            ctx.fillRect(0, 0, world.width, world.height);
            ctx.strokeStyle = "rgba(255,255,255,0.08)";
            ctx.lineWidth = 2;
            ctx.setLineDash([18, 14]);
            for (let x = 100; x < world.width; x += 100) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, world.height); ctx.stroke();
            }
            for (let y = 100; y < world.height; y += 100) {
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(world.width, y); ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.strokeStyle = "#f2c94c";
            ctx.lineWidth = 4;
            ctx.strokeRect(2, 2, world.width - 4, world.height - 4);
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
            const label = isMe ? `${p.username} (tú)` : p.username;
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(0,0,0,0.7)";
            ctx.strokeText(label, x, y - r - 6);
            ctx.fillStyle = "#fff";
            ctx.fillText(label, x, y - r - 6);
        }

        function frame() {
            if (!running) return;
            drawTrack();
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
                    drawCar({ ...p, color: colorFor(p.userId) }, x, y, headings.get(p.userId) || 0, p.userId === meId);
                }
            }
            requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);

        return {
            onWelcome(msg) {
                if (msg.world) world = { ...world, ...msg.world };
                if (msg.you) meId = msg.you.userId;
                resize();
            },
            onState(msg) {
                if (!Array.isArray(msg.players)) return;
                prev = curr;
                curr = msg;
                currAt = performance.now();
                for (const id of headings.keys()) {
                    if (!msg.players.some((p) => p.userId === id)) headings.delete(id);
                }
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
})();
