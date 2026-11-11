(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.RaceTracks = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
    const WORLD_WIDTH = 800;
    const WORLD_HEIGHT = 600;
    const ROAD_WIDTH = 112;
    const STEPS_PER_CORNER = 16;

    function roundedRectangle(x, y, width, height, radius) {
        const right = x + width;
        const bottom = y + height;
        const corners = [
            { x: right - radius, y: y + radius, from: -90 },
            { x: right - radius, y: bottom - radius, from: 0 },
            { x: x + radius, y: bottom - radius, from: 90 },
            { x: x + radius, y: y + radius, from: 180 }
        ];
        const points = [{ x: WORLD_WIDTH / 2, y }];

        for (const [index, corner] of corners.entries()) {
            const start = index === 0 ? -90 : corner.from;
            const end = start + 90;
            for (let step = 1; step <= STEPS_PER_CORNER; step += 1) {
                const angle = (start + (end - start) * step / STEPS_PER_CORNER) * Math.PI / 180;
                points.push({
                    x: corner.x + Math.cos(angle) * radius,
                    y: corner.y + Math.sin(angle) * radius
                });
            }

            const next = corners[(index + 1) % corners.length];
            if (index === corners.length - 1) continue;
            const angle = end * Math.PI / 180;
            const endPoint = {
                x: corner.x + Math.cos(angle) * radius,
                y: corner.y + Math.sin(angle) * radius
            };
            const nextAngle = next.from * Math.PI / 180;
            const nextPoint = {
                x: next.x + Math.cos(nextAngle) * radius,
                y: next.y + Math.sin(nextAngle) * radius
            };
            const steps = Math.max(
                1,
                Math.ceil(Math.hypot(nextPoint.x - endPoint.x, nextPoint.y - endPoint.y) / 12)
            );
            for (let step = 1; step < steps; step += 1) {
                points.push({
                    x: endPoint.x + (nextPoint.x - endPoint.x) * step / steps,
                    y: endPoint.y + (nextPoint.y - endPoint.y) * step / steps
                });
            }
        }
        return points;
    }

    function sampleCurve(pointAt, samples) {
        const points = [];
        for (let index = 0; index < samples; index += 1) {
            points.push(pointAt(index / samples * Math.PI * 2));
        }
        return points;
    }

    function smoothClosedPath(anchors, stepsPerSegment = 12) {
        const points = [];
        for (let index = 0; index < anchors.length; index += 1) {
            const p0 = anchors[(index - 1 + anchors.length) % anchors.length];
            const p1 = anchors[index];
            const p2 = anchors[(index + 1) % anchors.length];
            const p3 = anchors[(index + 2) % anchors.length];
            for (let step = 0; step < stepsPerSegment; step += 1) {
                const t = step / stepsPerSegment;
                const t2 = t * t;
                const t3 = t2 * t;
                const coordinate = (key) => 0.5 * (
                    2 * p1[key] +
                    (-p0[key] + p2[key]) * t +
                    (2 * p0[key] - 5 * p1[key] + 4 * p2[key] - p3[key]) * t2 +
                    (-p0[key] + 3 * p1[key] - 3 * p2[key] + p3[key]) * t3
                );
                points.push({ x: coordinate("x"), y: coordinate("y") });
            }
        }
        return points;
    }

    const tracks = [
        {
            id: 1,
            name: "Óvalo del desierto",
            points: roundedRectangle(100, 90, 600, 420, 105),
            roadWidth: ROAD_WIDTH,
            obstacles: []
        },
        {
            id: 2,
            name: "Vuelta del oasis",
            points: sampleCurve((angle) => ({
                x: 400 + 295 * Math.cos(angle - Math.PI / 2),
                y: 300 + 205 * Math.sin(angle - Math.PI / 2)
            }), 320),
            roadWidth: ROAD_WIDTH,
            obstacles: [{ x: 400, y: 300, shape: "diamond" }]
        },
        {
            id: 3,
            name: "Ocho cruzado",
            points: sampleCurve((angle) => {
                const t = angle + Math.PI / 2;
                return {
                    x: 400 + 260 * Math.sin(t),
                    y: 300 + 170 * Math.sin(t) * Math.cos(t)
                };
            }, 400),
            roadWidth: ROAD_WIDTH,
            obstacles: []
        },
        {
            id: 4,
            name: "Desafío de rocas",
            points: smoothClosedPath([
                { x: 400, y: 90 },
                { x: 555, y: 90 },
                { x: 660, y: 155 },
                { x: 620, y: 225 },
                { x: 680, y: 300 },
                { x: 680, y: 390 },
                { x: 600, y: 475 },
                { x: 500, y: 475 },
                { x: 455, y: 395 },
                { x: 390, y: 380 },
                { x: 330, y: 475 },
                { x: 220, y: 475 },
                { x: 140, y: 390 },
                { x: 140, y: 220 },
                { x: 220, y: 135 },
                { x: 300, y: 135 },
                { x: 320, y: 210 },
                { x: 400, y: 210 }
            ]),
            roadWidth: ROAD_WIDTH,
            obstacles: [
                { x: 270, y: 310, shape: "rock" },
                { x: 520, y: 310, shape: "rock" },
                { x: 400, y: 300, shape: "rock" }
            ]
        }
    ];

    function scaledPoints(track, width = WORLD_WIDTH, height = WORLD_HEIGHT) {
        return track.points.map((point) => ({
            x: point.x * width / WORLD_WIDTH,
            y: point.y * height / WORLD_HEIGHT
        }));
    }

    function pointAtDistance(track, distance, width = WORLD_WIDTH, height = WORLD_HEIGHT) {
        const points = scaledPoints(track, width, height);
        const lengths = points.map((point, index) => {
            const next = points[(index + 1) % points.length];
            return Math.hypot(next.x - point.x, next.y - point.y);
        });
        const total = lengths.reduce((sum, length) => sum + length, 0);
        let remaining = ((distance % total) + total) % total;

        for (let index = 0; index < points.length; index += 1) {
            const length = lengths[index];
            if (remaining <= length) {
                const start = points[index];
                const end = points[(index + 1) % points.length];
                const ratio = length ? remaining / length : 0;
                const dx = end.x - start.x;
                const dy = end.y - start.y;
                const magnitude = length || 1;
                return {
                    x: start.x + dx * ratio,
                    y: start.y + dy * ratio,
                    tangent: { x: dx / magnitude, y: dy / magnitude }
                };
            }
            remaining -= length;
        }

        const last = points[points.length - 1];
        return { x: last.x, y: last.y, tangent: { x: 1, y: 0 } };
    }

    function spawnAtStart(track, index, width = WORLD_WIDTH, height = WORLD_HEIGHT) {
        const position = pointAtDistance(track, -(index + 1) * 28, width, height);
        const lane = index % 2 === 0 ? -18 : 18;
        return {
            x: position.x - position.tangent.y * lane,
            y: position.y + position.tangent.x * lane
        };
    }

    function distanceToTrack(track, x, y, width = WORLD_WIDTH, height = WORLD_HEIGHT) {
        const points = scaledPoints(track, width, height);
        let minimum = Infinity;

        for (let index = 0; index < points.length; index += 1) {
            const start = points[index];
            const end = points[(index + 1) % points.length];
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const lengthSquared = dx * dx + dy * dy;
            const ratio = lengthSquared
                ? Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared))
                : 0;
            minimum = Math.min(minimum, Math.hypot(x - (start.x + dx * ratio), y - (start.y + dy * ratio)));
        }

        return minimum;
    }

    function isOnRoad(track, x, y, playerRadius = 20, width = WORLD_WIDTH, height = WORLD_HEIGHT) {
        const scale = Math.min(width / WORLD_WIDTH, height / WORLD_HEIGHT);
        return distanceToTrack(track, x, y, width, height) <= track.roadWidth * scale / 2 - playerRadius * 0.45;
    }

    function crossesFinish(track, previous, current, width = WORLD_WIDTH, height = WORLD_HEIGHT) {
        const start = scaledPoints(track, width, height)[0];
        const next = scaledPoints(track, width, height)[1];
        const dx = next.x - start.x;
        const dy = next.y - start.y;
        const length = Math.hypot(dx, dy) || 1;
        const tangent = { x: dx / length, y: dy / length };
        const normal = { x: -tangent.y, y: tangent.x };
        const before = (previous.x - start.x) * tangent.x + (previous.y - start.y) * tangent.y;
        const after = (current.x - start.x) * tangent.x + (current.y - start.y) * tangent.y;
        if (before > 0 || after <= 0) return false;

        const ratio = before === after ? 0 : -before / (after - before);
        const crossingX = previous.x + (current.x - previous.x) * ratio;
        const crossingY = previous.y + (current.y - previous.y) * ratio;
        const lateral = (crossingX - start.x) * normal.x + (crossingY - start.y) * normal.y;
        const halfRoad = track.roadWidth * Math.min(width / WORLD_WIDTH, height / WORLD_HEIGHT) / 2;
        return Math.abs(lateral) <= halfRoad;
    }

    return {
        WORLD_WIDTH,
        WORLD_HEIGHT,
        tracks,
        scaledPoints,
        pointAtDistance,
        spawnAtStart,
        distanceToTrack,
        isOnRoad,
        crossesFinish
    };
});
