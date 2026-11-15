# Plan de Mejora UI/UX — SSD Cars Multijugador

Este documento define la hoja de ruta y especificación de diseño para modernizar la interfaz y experiencia de usuario del juego **SSD Cars** en **3 fases**:

---

## 🏁 Fase 1: Pantalla de Acceso Arcade con Three.js 3D

### Objetivo
Hacer que el primer contacto del jugador con el juego sea emocionante, atractivo y temático de carreras arcade/synthwave, alejándose de los formularios estáticos genéricos.

### Diseño y Componentes
1. **Escenario 3D interactivo con Three.js**:
   - Integración ligera de Three.js (r128) cargada vía CDN para no introducir dependencias pesadas de empaquetado.
   - Un carro de carreras 3D procedural estilizado (alerón, ruedas con rines de brillo, carrocería pulida y faros de neón).
   - Plataforma giratoria con cuadrícula de perspectiva animada y partículas de velocidad.
   - Movimiento de cámara suave que responde a la posición del puntero del mouse.
2. **Panel de Acceso Unificado (Glassmorphism)**:
   - Tarjeta con efecto de vidrio esmerilado y borde luminoso neón.
   - Pestañas dinámicas: **"Iniciar Sesión"** y **"Crear Cuenta"** en una sola tarjeta limpia (en lugar de dos formularios amontonados).
   - Acceso con Google integrado de forma natural con un botón destacado.
   - Alertas visuales con iconos para confirmación y errores (`message` y `hint`).

---

## 🏎️ Fase 2: Rediseño Estructural de Marcos y Secciones del Lobby

### Objetivo
Estructurar el lobby como un **Paddock / Centro de Operaciones** de carreras multijugador, mejorando la jerarquía visual y la facilidad de uso.

### Nuevas Secciones y Marcos
1. **Barra Superior de Piloto & Telemetría**:
   - Tarjeta de perfil: avatar del jugador (foto de Google o inicial estilizada), nombre de usuario y botón de cerrar sesión.
   - Panel de estado de red: Chip luminoso del coordinador conectado (ej. `coord-5003 · Pista Tres`), frecuencia del loop (`20 Hz`) y latencia.
2. **Explorador de Salas (Tarjetas de Circuito)**:
   - Vista de salas en cuadrícula (Cards) con bordes neón.
   - Badges visuales de estado: 🟡 *Esperando pilotos* (con barra de cupo `2/8`) y 🟢 *En carrera*.
   - Botón destacado `+ Crear Carrera` que abre un panel o modal desplegable.
3. **Paddock de Sala Activa (Parrilla de Salida)**:
   - Título del circuito y estado de la sala.
   - Lista de competidores en la sala con el coordinador de origen de cada uno (`coord-5003`, `coord-5005`, etc.).
   - **Garaje de Pintura**: Paleta de colores rediseñada como muestrario de carrocerías metálicas con reflejo.
   - Botón de "Iniciar Partida" exclusivo del anfitrión con animación de pulso cuando hay 2 o más jugadores listos.
4. **Área de Pista y Competición**:
   - Marco de canvas estilizado con esquinas biseladas arcade y semáforo visual de cuenta regresiva.
   - Mini-radar o barra de posiciones durante la carrera.

---

## 🗺️ Fase 3: Circuitos Adicionales y Selector de Mapa al Crear Sala

### Objetivo
Añadir diversidad táctica y permitir que el anfitrión elija qué circuito correr entre opciones con características y curvas completamente distintas.

### Los 3 Circuitos Disponibles
1. **Mapa 1: "Óvalo del Desierto" (Velocidad Pura)**
   - *Características*: Trazado rectangular con curvas amplias de alta aceleración.
   - *Dificultad*: ★☆☆ (Principiante / Velocidad).
2. **Mapa 2: "Neón Metropolis / Cyber Ring" (Circuito Urbano Técnico)**
   - *Características*: Pista urbana con chicanas dobles, curva cerrada de 90° y horquilla de 180° que exige frenar o soltar acelerador.
   - *Dificultad*: ★★☆ (Intermedio / Técnico).
3. **Mapa 3: "Cañón Volcánico / Magma Pass" (Trazado Sinuoso Extremo)**
   - *Características*: Pista asimétrica con sectores en "S" entrelazados, chicanas rápidas y curvas ciegas.
   - *Dificultad*: ★★★ (Avanzado / Reflejos).

### Experiencia de Creación de Sala
- Al pulsar `+ Crear Carrera`, el usuario ve:
  1. Campo para el nombre de la sala.
  2. **Selector visual de circuito**: 3 tarjetas interactivas con miniatura del trazado, nombre, descripción y nivel de dificultad.
  3. Selección activa resaltada con borde neón brillante.
- El `trackId` elegido se envía en el mensaje WebSocket `room_create`.
- El coordinador guarda el `trackId` en la sala, calcula los spawns en la meta de ese mapa, y lo replica a todos los coordinadores de la malla (`room_replicate`) para que todos los jugadores corran en el circuito seleccionado.

---

## 📋 Plan de Ejecución y Aprobación
Este plan se implementará ordenadamente fase por fase tras tu revisión y visto bueno.

