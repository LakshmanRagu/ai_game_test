# Tactical Ops: Browser Edition

A 3D tactical shooter browser game built with [Three.js](https://threejs.org/).

## Features
- **3D First Person Shooter** gameplay in the browser.
- **HUD Interface**: Includes crosshair, health, armor, ammo, minimap, kill feed, and round timer.
- **Teams**: Counter-Terrorists (CT) and Terrorists (T).
- **Responsive UI**: Scales with the browser window.

## Controls
- **W, A, S, D** - Move
- **Mouse** - Aim
- **Left Click** - Shoot
- **R** - Reload
- **1, 2** - Switch Weapons
- **Space** - Jump
- **Shift** - Sprint

## How to Run
Since this project uses ES6 Modules (importmap for Three.js), it is highly recommended to run it through a local web server to avoid CORS issues.

### Using Python
If you have Python installed, you can start a simple server:

```bash
# Python 3
python -m http.server 8000
```
Then open your browser and navigate to `http://localhost:8000`.

### Using Node.js
If you have Node.js and `npm` installed, you can use `serve` or `http-server`:
```bash
npx serve
# or
npx http-server
```

## Built With
- HTML5 / CSS3
- JavaScript (ES6 Modules)
- [Three.js](https://threejs.org/) (3D Graphics Library)
