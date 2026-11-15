// ============================================================================
// SSD CARS - Bólido 3D Aerodinámico Supercar GT (Three.js r128)
// ============================================================================
// - Geometría de alta resolución con curvaturas aerodinámicas suaves (normal smoothing).
// - Iluminación PBR con reflejos metálicos y acentos en amarillo-anaranjado neón (#ffcf3f / #ff7a00).
// - Integración volumétrica con el fondo oscuro y sombra difuminada con gradiente alfa (sin marcos ni cortes).
// ============================================================================

(function () {
    'use strict';

    function hasWebGL() {
        try {
            const canvas = document.createElement('canvas');
            return Boolean(
                window.WebGLRenderingContext &&
                (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
            );
        } catch {
            return false;
        }
    }

    if (!hasWebGL() || typeof THREE === 'undefined') {
        console.info('[login-3d] WebGL o Three.js no disponibles.');
        return;
    }

    const container = document.getElementById('threejs-canvas-container');
    if (!container) return;

    // ── Helper para asegurar suavizado de normales en cada geometría ──────────
    function makeSmooth(geometry) {
        geometry.computeVertexNormals();
        return geometry;
    }

    // ── Dimensiones y Escena ────────────────────────────────────────────────
    let width = container.clientWidth || 540;
    let height = container.clientHeight || 520;

    const scene = new THREE.Scene();

    // Niebla muy sutil para fundir partículas lejanas sin atenuar el vehículo
    scene.fog = new THREE.FogExp2(0x080d17, 0.018);

    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
    camera.position.set(2.2, 1.7, 5.2);
    camera.lookAt(0, 0.12, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0); // Fondo totalmente transparente
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // ── Iluminación de Estudio y Paleta de Neón (Amarillo / Naranja) ─────────
    // Luz ambiental suave para sombras ricas
    const ambientLight = new THREE.AmbientLight(0x131a2a, 2.2);
    scene.add(ambientLight);

    // Luz principal superior cálida (destellos en la pintura metálica)
    const keyLight = new THREE.DirectionalLight(0xfff1dc, 2.8);
    keyLight.position.set(5, 8, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.bias = -0.0008;
    scene.add(keyLight);

    // Luz de relleno azulada profunda (contraste cyberpunk sutil)
    const fillLight = new THREE.DirectionalLight(0x223554, 1.4);
    fillLight.position.set(-6, 3, -4);
    scene.add(fillLight);

    // Luces de acento de neón acordes con la paleta: Amarillo Dorado (#ffcf3f) y Naranja (#ff7a00)
    const neonGold = new THREE.PointLight(0xffcf3f, 4.5, 11);
    neonGold.position.set(-3.2, 1.2, 2.2);
    scene.add(neonGold);

    const neonOrange = new THREE.PointLight(0xff7a00, 4.8, 12);
    neonOrange.position.set(3.2, 1.4, -2.4);
    scene.add(neonOrange);

    // Resplandor cálido bajo el chasis (Underglow que ilumina el suelo)
    const underglowLight = new THREE.PointLight(0xff7a00, 3.8, 5.0);
    underglowLight.position.set(0, 0.08, 0);
    scene.add(underglowLight);

    // ── Grupo del Bólido (Escala calibrada con holgura para evitar recortes) ─
    const carRoot = new THREE.Group();
    carRoot.scale.set(0.72, 0.72, 0.72);
    carRoot.position.set(0, -0.12, 0);
    scene.add(carRoot);

    // ── Materiales PBR Automotrices de Alta Gama ─────────────────────────────
    // 1. Pintura metálica naranja-dorada de competición con barniz reflectante (Clearcoat)
    const paintMaterial = new THREE.MeshPhysicalMaterial({
        color: 0xd95700,
        emissive: 0x240e00,
        emissiveIntensity: 0.35,
        metalness: 0.85,
        roughness: 0.18,
        clearcoat: 1.0,
        clearcoatRoughness: 0.08,
        reflectivity: 0.95
    });

    // 2. Acento en amarillo dorado brillante (--accent: #ffcf3f)
    const goldAccentMat = new THREE.MeshStandardMaterial({
        color: 0xffcf3f,
        emissive: 0xffaa00,
        emissiveIntensity: 0.5,
        metalness: 0.75,
        roughness: 0.2
    });

    // 3. Fibra de carbono satinada para piezas aerodinámicas
    const carbonMaterial = new THREE.MeshStandardMaterial({
        color: 0x0a0e17,
        metalness: 0.45,
        roughness: 0.32
    });

    // 4. Vidrio de cúpula aerodinámica con tintado oscuro y reflejos suaves
    const cockpitGlassMat = new THREE.MeshPhysicalMaterial({
        color: 0x050a14,
        metalness: 0.2,
        roughness: 0.04,
        transmission: 0.72,
        transparent: true,
        opacity: 0.92,
        reflectivity: 0.98
    });

    // 5. Faros LED diurnos en amarillo dorado cálido
    const ledGoldMat = new THREE.MeshBasicMaterial({ color: 0xffcf3f });

    // 6. Barra trasera LED en rojo anaranjado de competición
    const ledRedMat = new THREE.MeshBasicMaterial({ color: 0xff3b00 });

    // 7. Neumáticos de competición de caucho suave
    const tireMaterial = new THREE.MeshStandardMaterial({
        color: 0x141822,
        metalness: 0.12,
        roughness: 0.78
    });

    // 8. Rines de aleación cepillada con centro oscuro
    const rimMaterial = new THREE.MeshStandardMaterial({
        color: 0x222938,
        metalness: 0.92,
        roughness: 0.15
    });

    const brakeCaliperMat = new THREE.MeshBasicMaterial({ color: 0xffcf3f });

    // ── Construcción de la Carrocería con Curvas Aerodinámicas Continuas ────

    // A. Fuselaje principal curvado (cuerpo estilizado en elipsoide)
    const mainFuselageGeo = makeSmooth(new THREE.SphereGeometry(1, 64, 36));
    const mainFuselage = new THREE.Mesh(mainFuselageGeo, paintMaterial);
    mainFuselage.scale.set(0.82, 0.29, 1.95);
    mainFuselage.position.set(0, 0.38, 0);
    mainFuselage.castShadow = true;
    mainFuselage.receiveShadow = true;
    carRoot.add(mainFuselage);

    // B. Morro aerodinámico en cuña suave con inclinación frontal
    const noseGeo = makeSmooth(new THREE.CylinderGeometry(0.38, 0.72, 1.25, 48));
    const nose = new THREE.Mesh(noseGeo, paintMaterial);
    nose.rotation.x = Math.PI / 2 + 0.12;
    nose.scale.set(0.98, 0.42, 1.0);
    nose.position.set(0, 0.33, 1.35);
    nose.castShadow = true;
    carRoot.add(nose);

    // C. Splitter frontal curvo inferior en fibra de carbono
    const splitterGeo = makeSmooth(new THREE.CylinderGeometry(0.76, 0.82, 0.038, 48, 1, false, 0, Math.PI));
    const splitter = new THREE.Mesh(splitterGeo, carbonMaterial);
    splitter.rotation.y = -Math.PI / 2;
    splitter.scale.set(0.95, 1, 1.35);
    splitter.position.set(0, 0.17, 1.62);
    carRoot.add(splitter);

    // D. Línea de acento neón en el splitter frontal (Amarillo dorado)
    const splitterNeonGeo = makeSmooth(new THREE.TorusGeometry(0.76, 0.014, 16, 48, Math.PI));
    const splitterNeon = new THREE.Mesh(splitterNeonGeo, ledGoldMat);
    splitterNeon.rotation.x = Math.PI / 2;
    splitterNeon.rotation.z = Math.PI;
    splitterNeon.scale.set(0.95, 1.35, 1);
    splitterNeon.position.set(0, 0.17, 1.62);
    carRoot.add(splitterNeon);

    // E. Cúpula de cabina aerodinámica (Gota de agua panorámica continua)
    const canopyGeo = makeSmooth(new THREE.SphereGeometry(0.88, 64, 36));
    const canopy = new THREE.Mesh(canopyGeo, cockpitGlassMat);
    canopy.scale.set(0.58, 0.38, 1.12);
    canopy.position.set(0, 0.58, -0.06);
    canopy.castShadow = true;
    carRoot.add(canopy);

    // Techo y toma de aire dorsal continua (Air scoop aerodinámico)
    const roofScoopGeo = makeSmooth(new THREE.CylinderGeometry(0.07, 0.24, 0.85, 24));
    const roofScoop = new THREE.Mesh(roofScoopGeo, goldAccentMat);
    roofScoop.rotation.x = Math.PI / 2 + 0.11;
    roofScoop.scale.set(0.65, 0.32, 1);
    roofScoop.position.set(0, 0.78, -0.16);
    carRoot.add(roofScoop);

    // F. Pasos de rueda esculpidos (Side Pods musculosos con curvaturas fluidas)
    const podGeo = makeSmooth(new THREE.SphereGeometry(0.52, 48, 28));

    // Delantero Izquierdo
    const podFL = new THREE.Mesh(podGeo, paintMaterial);
    podFL.scale.set(0.38, 0.34, 0.98);
    podFL.position.set(0.70, 0.36, 0.92);
    podFL.castShadow = true;
    carRoot.add(podFL);

    // Delantero Derecho
    const podFR = podFL.clone();
    podFR.position.x = -0.70;
    carRoot.add(podFR);

    // Trasero Izquierdo (Músculo ensanchado)
    const podRL = new THREE.Mesh(podGeo, paintMaterial);
    podRL.scale.set(0.45, 0.41, 1.22);
    podRL.position.set(0.74, 0.40, -0.86);
    podRL.castShadow = true;
    carRoot.add(podRL);

    // Trasero Derecho
    const podRR = podRL.clone();
    podRR.position.x = -0.74;
    carRoot.add(podRR);

    // G. Alerón trasero aerodinámico integrado de doble ala (Curvo, no recto)
    const wingGeo = makeSmooth(new THREE.CylinderGeometry(0.12, 0.12, 1.64, 36));
    const rearWing = new THREE.Mesh(wingGeo, goldAccentMat);
    rearWing.rotation.z = Math.PI / 2;
    rearWing.scale.set(1.5, 0.075, 0.44);
    rearWing.position.set(0, 0.83, -1.58);
    rearWing.castShadow = true;
    carRoot.add(rearWing);

    // Aletas laterales del alerón (Endplates fluidos)
    const endplateGeo = makeSmooth(new THREE.BoxGeometry(0.028, 0.22, 0.38));
    const endplateL = new THREE.Mesh(endplateGeo, carbonMaterial);
    endplateL.position.set(0.82, 0.83, -1.58);
    carRoot.add(endplateL);

    const endplateR = endplateL.clone();
    endplateR.position.x = -0.82;
    carRoot.add(endplateR);

    // Soportes aerodinámicos en cuello de cisne (Swan neck)
    const supportGeo = makeSmooth(new THREE.CylinderGeometry(0.022, 0.022, 0.44, 16));
    const supportL = new THREE.Mesh(supportGeo, carbonMaterial);
    supportL.rotation.x = -0.28;
    supportL.position.set(0.36, 0.65, -1.50);
    carRoot.add(supportL);

    const supportR = supportL.clone();
    supportR.position.x = -0.36;
    carRoot.add(supportR);

    // H. Faros LED delanteros curvados (Estética rasgada moderna)
    const headlightGeo = makeSmooth(new THREE.BoxGeometry(0.24, 0.035, 0.12));

    const hlLeft = new THREE.Mesh(headlightGeo, ledGoldMat);
    hlLeft.rotation.y = -0.35;
    hlLeft.rotation.z = -0.15;
    hlLeft.position.set(0.53, 0.39, 1.60);
    carRoot.add(hlLeft);

    const hlRight = new THREE.Mesh(headlightGeo, ledGoldMat);
    hlRight.rotation.y = 0.35;
    hlRight.rotation.z = 0.15;
    hlRight.position.set(-0.53, 0.39, 1.60);
    carRoot.add(hlRight);

    // I. Barra LED trasera continua y curvada
    const lightBarGeo = makeSmooth(new THREE.CylinderGeometry(0.022, 0.022, 1.38, 32));
    const tailLightBar = new THREE.Mesh(lightBarGeo, ledRedMat);
    tailLightBar.rotation.z = Math.PI / 2;
    tailLightBar.position.set(0, 0.44, -1.72);
    carRoot.add(tailLightBar);

    // J. Tubos de escape dobles con resplandor neón naranja
    const exhaustGeo = makeSmooth(new THREE.CylinderGeometry(0.065, 0.065, 0.14, 24));
    const exhaustInnerMat = new THREE.MeshBasicMaterial({ color: 0xff7a00 });

    const exhaustL = new THREE.Mesh(exhaustGeo, exhaustInnerMat);
    exhaustL.rotation.x = Math.PI / 2;
    exhaustL.position.set(0.12, 0.33, -1.74);
    carRoot.add(exhaustL);

    const exhaustR = exhaustL.clone();
    exhaustR.position.x = -0.12;
    carRoot.add(exhaustR);

    // ── Ruedas de Competición con Neumáticos de Curvatura Suave ─────────────
    const wheels = [];
    const wheelPositions = [
        { x:  0.74, y: 0.30, z:  0.92, isFront: true },
        { x: -0.74, y: 0.30, z:  0.92, isFront: true },
        { x:  0.78, y: 0.32, z: -0.88, isFront: false },
        { x: -0.78, y: 0.32, z: -0.88, isFront: false }
    ];

    for (const pos of wheelPositions) {
        const wheelGroup = new THREE.Group();
        wheelGroup.position.set(pos.x, pos.y, pos.z);

        const radius = pos.isFront ? 0.30 : 0.32;
        const tubeRadius = 0.105;

        // Neumático con bordes redondeados y alta resolución (Torus con 32x48 segmentos)
        const tireGeo = makeSmooth(new THREE.TorusGeometry(radius - tubeRadius, tubeRadius, 32, 48));
        const tire = new THREE.Mesh(tireGeo, tireMaterial);
        tire.rotation.y = Math.PI / 2;
        tire.castShadow = true;
        wheelGroup.add(tire);

        // Rin cóncavo de aleación cepillada
        const rimGeo = makeSmooth(new THREE.CylinderGeometry(radius * 0.72, radius * 0.68, 0.20, 32));
        const rim = new THREE.Mesh(rimGeo, rimMaterial);
        rim.rotation.z = Math.PI / 2;
        wheelGroup.add(rim);

        // Anillo interior de neón dorado en el rin
        const rimRingGeo = makeSmooth(new THREE.TorusGeometry(radius * 0.58, 0.012, 16, 32));
        const rimRing = new THREE.Mesh(rimRingGeo, ledGoldMat);
        rimRing.rotation.y = Math.PI / 2;
        wheelGroup.add(rimRing);

        // Pinza de freno deportiva en amarillo dorado
        const caliperGeo = makeSmooth(new THREE.BoxGeometry(0.055, 0.13, 0.075));
        const caliper = new THREE.Mesh(caliperGeo, brakeCaliperMat);
        caliper.position.set(pos.x > 0 ? 0.06 : -0.06, 0.11, 0);
        wheelGroup.add(caliper);

        carRoot.add(wheelGroup);
        wheels.push(wheelGroup);
    }

    // ── Suelo con Desvanecimiento Suave / Gradiente Alfa (Sin Marcos ni Cortes) ─
    // Generamos proceduralmente una textura de gradiente radial difuminado
    // para que la sombra y el resplandor se fundan suavemente con el fondo oscuro
    function createSoftAmbientShadowTexture() {
        const c = document.createElement('canvas');
        c.width = 512;
        c.height = 512;
        const ctx = c.getContext('2d');

        // Gradiente radial ultra-suave desde el centro hacia los extremos
        const grad = ctx.createRadialGradient(256, 256, 0, 256, 256, 256);
        grad.addColorStop(0.00, 'rgba(255, 122, 0, 0.28)'); // Resplandor cálido central (underglow)
        grad.addColorStop(0.25, 'rgba(0, 0, 0, 0.55)');       // Sombra de oclusión ambiental bajo el chasis
        grad.addColorStop(0.55, 'rgba(8, 13, 23, 0.25)');     // Transición hacia el fondo
        grad.addColorStop(0.85, 'rgba(8, 13, 23, 0.05)');     // Penumbra difuminada
        grad.addColorStop(1.00, 'rgba(8, 13, 23, 0.00)');     // 100% transparente en el borde

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 512, 512);

        const tex = new THREE.CanvasTexture(c);
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        return tex;
    }

    const groundPlaneGeo = new THREE.PlaneGeometry(5.0, 5.0);
    const groundPlaneMat = new THREE.MeshBasicMaterial({
        map: createSoftAmbientShadowTexture(),
        transparent: true,
        opacity: 0.9,
        depthWrite: false
    });
    const groundPlane = new THREE.Mesh(groundPlaneGeo, groundPlaneMat);
    groundPlane.rotation.x = -Math.PI / 2;
    groundPlane.position.y = 0.01;
    scene.add(groundPlane);

    // ── Partículas Ambientales Suaves en Tonos Cálidos ──────────────────────
    const particleCount = 60;
    const particleGeo = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);

    for (let i = 0; i < particleCount * 3; i += 3) {
        particlePositions[i]     = (Math.random() - 0.5) * 7.5;
        particlePositions[i + 1] = Math.random() * 3.0;
        particlePositions[i + 2] = (Math.random() - 0.5) * 7.5;
    }

    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

    const particleMat = new THREE.PointsMaterial({
        color: 0xffcf3f,
        size: 0.035,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);

    // ── Redimensionamiento Responsivo Automático ────────────────────────────
    function onContainerResize() {
        if (!container) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w <= 0 || h <= 0) return;
        width = w;
        height = h;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
    }

    if (window.ResizeObserver) {
        new ResizeObserver(() => onContainerResize()).observe(container);
    } else {
        window.addEventListener('resize', onContainerResize);
    }

    // ── Interactividad: Parallax y Arrastre 360° con Mouse ───────────────────
    const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
    let isDragging = false;
    let previousMouseX = 0;
    let userRotationOffset = 0;

    container.addEventListener('pointermove', (event) => {
        const rect = container.getBoundingClientRect();
        mouse.targetX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.targetY = -(((event.clientY - rect.top) / rect.height) * 2 - 1);

        if (isDragging) {
            const deltaX = event.clientX - previousMouseX;
            userRotationOffset += deltaX * 0.012;
            previousMouseX = event.clientX;
        }
    });

    container.addEventListener('pointerdown', (event) => {
        isDragging = true;
        previousMouseX = event.clientX;
        try { container.setPointerCapture(event.pointerId); } catch (_) {}
    });

    container.addEventListener('pointerup', (event) => {
        isDragging = false;
        try { container.releasePointerCapture(event.pointerId); } catch (_) {}
    });

    container.addEventListener('pointercancel', () => { isDragging = false; });
    container.addEventListener('pointerleave', () => {
        if (!isDragging) {
            mouse.targetX = 0;
            mouse.targetY = 0;
        }
    });

    // ── Bucle de Animación Continuo y Fluido (60 FPS) ────────────────────────
    const clock = new THREE.Clock();

    function animate() {
        requestAnimationFrame(animate);

        const delta = clock.getDelta();
        const elapsed = clock.getElapsedTime();

        // Parallax suave con inercia
        mouse.x += (mouse.targetX - mouse.x) * 0.05;
        mouse.y += (mouse.targetY - mouse.y) * 0.05;

        // Rotación continua fluida del carro + giro manual del usuario
        carRoot.rotation.y = elapsed * 0.45 + userRotationOffset;

        // Sutil cabeceo aerodinámico (suspensión viva orgánica)
        carRoot.position.y = -0.12 + Math.sin(elapsed * 1.8) * 0.015;

        // Inclinación de cámara con respuesta al mouse
        camera.position.x = 2.2 + mouse.x * 0.32;
        camera.position.y = 1.7 + mouse.y * 0.22;
        camera.lookAt(0, 0.12, 0);

        // Giro continuo de ruedas
        for (const w of wheels) {
            w.children[0].rotation.x += delta * 3.4;
            w.children[1].rotation.x += delta * 3.4;
            w.children[2].rotation.x += delta * 3.4;
        }

        // Partículas flotando suavemente en el espacio
        const positions = particleGeo.attributes.position.array;
        for (let i = 1; i < particleCount * 3; i += 3) {
            positions[i] += delta * 0.32;
            if (positions[i] > 3.0) positions[i] = 0;
        }
        particleGeo.attributes.position.needsUpdate = true;

        // Pulsaciones de neón suaves integradas en la paleta cálida
        underglowLight.intensity = 3.6 + Math.sin(elapsed * 3.2) * 0.8;
        neonGold.intensity       = 4.2 + Math.cos(elapsed * 2.2) * 0.8;
        neonOrange.intensity     = 4.4 + Math.sin(elapsed * 2.0) * 0.7;

        renderer.render(scene, camera);
    }

    animate();
})();
