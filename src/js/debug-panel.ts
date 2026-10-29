import type { AnimationEngine } from './animation-engine';
import type { AnimationConfig, TouchRegion } from './types';

const READY_STATE_LABELS: Record<number, string> = {
    [-1]: 'NOT LOADED',
    0: 'HAVE_NOTHING',
    1: 'HAVE_METADATA',
    2: 'HAVE_CURRENT_DATA',
    3: 'HAVE_FUTURE_DATA',
    4: 'HAVE_ENOUGH_DATA',
};

const REGION_COLORS = [
    'rgba(0, 150, 255, 0.30)',
    'rgba(255, 80, 80, 0.30)',
    'rgba(80, 220, 80, 0.30)',
    'rgba(255, 200, 0, 0.30)',
    'rgba(200, 80, 255, 0.30)',
];

/**
 * Compute the rendered rect of a video with object-fit:cover inside a container.
 * Returns the offset and scale so we can map video-relative coords to container coords.
 */
function computeCoverRect(
    containerW: number,
    containerH: number,
    videoW: number,
    videoH: number,
): { offsetX: number; offsetY: number; renderedW: number; renderedH: number } {
    const containerAspect = containerW / containerH;
    const videoAspect = videoW / videoH;

    let renderedW: number;
    let renderedH: number;

    if (videoAspect > containerAspect) {
        // Video is wider — height fills, sides cropped
        renderedH = containerH;
        renderedW = containerH * videoAspect;
    } else {
        // Video is taller — width fills, top/bottom cropped
        renderedW = containerW;
        renderedH = containerW / videoAspect;
    }

    const offsetX = (containerW - renderedW) / 2;
    const offsetY = (containerH - renderedH) / 2;

    return { offsetX, offsetY, renderedW, renderedH };
}

/**
 * Map a video-relative region (0-1) to CSS pixel values inside the container,
 * accounting for object-fit:cover.
 */
function regionToContainerPx(
    region: TouchRegion,
    containerW: number,
    containerH: number,
    videoW: number,
    videoH: number,
): { left: number; top: number; width: number; height: number } {
    const { offsetX, offsetY, renderedW, renderedH } = computeCoverRect(
        containerW, containerH, videoW, videoH,
    );

    return {
        left: region.x * renderedW + offsetX,
        top: region.y * renderedH + offsetY,
        width: region.width * renderedW,
        height: region.height * renderedH,
    };
}

export interface SceneRotationControls {
    isLocked: () => boolean;
    setLocked: (locked: boolean) => void;
    getNextTransition: () => { sceneId: string; remainingMs: number } | null;
}

export function createDebugPanel(
    engine: AnimationEngine,
    config: AnimationConfig,
    transitionToScene?: (sceneId: string) => Promise<void>,
    sceneRotation?: SceneRotationControls,
): void {
    // Button
    const btn = document.createElement('button');
    btn.id = 'debug-toggle-btn';
    btn.classList.add('auto-hide');
    btn.setAttribute('aria-label', 'Toggle debug panel');
    btn.textContent = '🐞';
    document.body.appendChild(btn);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.classList.add('debug-hidden');
    panel.innerHTML = `
    <div class="debug-header">
      <span>Debug Panel</span>
      <button id="debug-close-btn">✕</button>
    </div>
    <div class="debug-tabs">
      <button class="debug-tab debug-tab-active" data-tab="status">Status</button>
      <button class="debug-tab" data-tab="scenes">Scenes</button>
      <button class="debug-tab" data-tab="config">Config</button>
      <button class="debug-tab" data-tab="layers">Layers</button>
      <button class="debug-tab" data-tab="perf">Perf</button>
    </div>
    <div id="debug-content"></div>
    <div id="debug-scenes-content" class="debug-tab-hidden"></div>
    <div id="debug-config-content" class="debug-tab-hidden"></div>
    <div id="debug-layers-content" class="debug-tab-hidden"></div>
    <div id="debug-perf-content" class="debug-tab-hidden"></div>
  `;
    document.body.appendChild(panel);

    const content = panel.querySelector('#debug-content') as HTMLElement;
    const scenesContent = panel.querySelector('#debug-scenes-content') as HTMLElement;
    const configContent = panel.querySelector('#debug-config-content') as HTMLElement;
    const layersContent = panel.querySelector('#debug-layers-content') as HTMLElement;
    const perfContent = panel.querySelector('#debug-perf-content') as HTMLElement;
    const closeBtn = panel.querySelector('#debug-close-btn') as HTMLButtonElement;
    const tabButtons = panel.querySelectorAll<HTMLButtonElement>('.debug-tab');

    let open = false;
    let activeTab = 'status';
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let showTouchRegions = false;
    let isRotated = false;
    let autoRotate = true;
    let sliderActive = false;

    // ── FPS tracker ──
    const FPS_HISTORY_SIZE = 120;
    const fpsHistory: number[] = [];
    let fpsFrameCount = 0;
    let fpsLastTime = performance.now();
    let currentFps = 0;
    let fpsMin = Infinity;
    let fpsMax = 0;
    let fpsRafId = 0;

    const fpsLoop = (now: number): void => {
        if (!open || activeTab !== 'perf') { fpsRafId = 0; return; }
        fpsFrameCount++;
        const elapsed = now - fpsLastTime;
        if (elapsed >= 500) {
            currentFps = Math.round((fpsFrameCount / elapsed) * 1000);
            fpsFrameCount = 0;
            fpsLastTime = now;
            fpsHistory.push(currentFps);
            if (fpsHistory.length > FPS_HISTORY_SIZE) fpsHistory.shift();
            if (currentFps > 0) {
                if (currentFps < fpsMin) fpsMin = currentFps;
                if (currentFps > fpsMax) fpsMax = currentFps;
            }
        }
        fpsRafId = requestAnimationFrame(fpsLoop);
    };

    // ── Frame time tracker ──
    const frameTimeHistory: number[] = [];
    let lastFrameTime = performance.now();
    let frameTimeRafId = 0;
    const frameTimeLoop = (now: number): void => {
        if (!open || activeTab !== 'perf') { frameTimeRafId = 0; return; }
        const dt = now - lastFrameTime;
        lastFrameTime = now;
        frameTimeHistory.push(dt);
        if (frameTimeHistory.length > FPS_HISTORY_SIZE) frameTimeHistory.shift();
        frameTimeRafId = requestAnimationFrame(frameTimeLoop);
    };

    const startPerfLoops = (): void => {
        if (!fpsRafId) {
            fpsFrameCount = 0;
            fpsLastTime = performance.now();
            fpsRafId = requestAnimationFrame(fpsLoop);
        }
        if (!frameTimeRafId) {
            lastFrameTime = performance.now();
            frameTimeRafId = requestAnimationFrame(frameTimeLoop);
        }
    };

    const stopPerfLoops = (): void => {
        if (fpsRafId) { cancelAnimationFrame(fpsRafId); fpsRafId = 0; }
        if (frameTimeRafId) { cancelAnimationFrame(frameTimeRafId); frameTimeRafId = 0; }
    };

    // ── Battery ──
    interface BatteryManager {
        level: number;
        charging: boolean;
        chargingTime: number;
        dischargingTime: number;
        addEventListener(type: string, listener: () => void): void;
    }
    let battery: BatteryManager | null = null;
    let batteryStartLevel = -1;
    let batteryStartTime = 0;
    const navAny = navigator as { getBattery?: () => Promise<BatteryManager> };
    if (navAny.getBattery) {
        navAny.getBattery().then(b => {
            battery = b;
            batteryStartLevel = b.level;
            batteryStartTime = Date.now();
        }).catch(() => { /* not available */ });
    }

    // ── Dropped frames ──
    let droppedFrames = 0;
    let totalFrames = 0;
    const getVideoFrameStats = (): { dropped: number; total: number } => {
        let d = 0, t = 0;
        for (const vid of engine.containerElement.querySelectorAll('video')) {
            const wk = vid as HTMLVideoElement & { webkitDecodedFrameCount?: number; webkitDroppedFrameCount?: number };
            if (typeof wk.webkitDroppedFrameCount === 'number') {
                d += wk.webkitDroppedFrameCount;
                t += wk.webkitDecodedFrameCount ?? 0;
            } else if ('getVideoPlaybackQuality' in vid) {
                const q = vid.getVideoPlaybackQuality();
                d += q.droppedVideoFrames;
                t += q.totalVideoFrames;
            }
        }
        return { dropped: d, total: t };
    };

    const refreshPerf = (): void => {
        let html = '';

        // FPS section
        const fpsColor = currentFps >= 50 ? '#a5d6a7' : currentFps >= 30 ? '#ffb74d' : '#ef9a9a';
        const fpsAvg = fpsHistory.length > 0 ? Math.round(fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length) : 0;

        html += `<div class="debug-section">`;
        html += `<div class="debug-title">FPS</div>`;
        html += `<div class="debug-row"><span>Current</span><span class="debug-value" style="color:${fpsColor};font-size:18px;font-weight:bold">${currentFps}</span></div>`;
        html += `<div class="debug-row"><span>Average</span><span class="debug-value">${fpsAvg}</span></div>`;
        html += `<div class="debug-row"><span>Min / Max</span><span class="debug-value">${fpsMin === Infinity ? '–' : fpsMin} / ${fpsMax === 0 ? '–' : fpsMax}</span></div>`;
        // FPS graph
        html += `<canvas id="debug-fps-graph" width="280" height="60" style="width:100%;height:60px;margin-top:6px;border-radius:4px;background:rgba(0,0,0,0.3)"></canvas>`;
        html += `</div>`;

        // Frame time section
        const recentFrameTimes = frameTimeHistory.slice(-60);
        const avgFrameTime = recentFrameTimes.length > 0 ? (recentFrameTimes.reduce((a, b) => a + b, 0) / recentFrameTimes.length) : 0;
        const maxFrameTime = recentFrameTimes.length > 0 ? Math.max(...recentFrameTimes) : 0;
        const jank = recentFrameTimes.filter(t => t > 33.3).length;

        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Frame Time</div>`;
        html += `<div class="debug-row"><span>Avg</span><span class="debug-value">${avgFrameTime.toFixed(1)}ms</span></div>`;
        html += `<div class="debug-row"><span>Worst</span><span class="debug-value" style="color:${maxFrameTime > 33.3 ? '#ffb74d' : '#a5d6a7'}">${maxFrameTime.toFixed(1)}ms</span></div>`;
        html += `<div class="debug-row"><span>Jank (>33ms)</span><span class="debug-value" style="color:${jank > 0 ? '#ffb74d' : '#a5d6a7'}">${jank} frames</span></div>`;
        html += `<canvas id="debug-frametime-graph" width="280" height="60" style="width:100%;height:60px;margin-top:6px;border-radius:4px;background:rgba(0,0,0,0.3)"></canvas>`;
        html += `</div>`;

        // Dropped video frames
        const frameStats = getVideoFrameStats();
        const dropRate = frameStats.total > 0 ? ((frameStats.dropped / frameStats.total) * 100).toFixed(1) : '0.0';
        const dropColor = frameStats.dropped > droppedFrames ? '#ffb74d' : '#a5d6a7';
        droppedFrames = frameStats.dropped;
        totalFrames = frameStats.total;

        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Video Decode</div>`;
        html += `<div class="debug-row"><span>Decoded Frames</span><span class="debug-value">${totalFrames.toLocaleString()}</span></div>`;
        html += `<div class="debug-row"><span>Dropped Frames</span><span class="debug-value" style="color:${dropColor}">${droppedFrames.toLocaleString()}</span></div>`;
        html += `<div class="debug-row"><span>Drop Rate</span><span class="debug-value" style="color:${dropColor}">${dropRate}%</span></div>`;
        html += `</div>`;

        // Memory section (Chromium only)
        const perfAny = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } };
        if (perfAny.memory) {
            const m = perfAny.memory;
            const used = (m.usedJSHeapSize / 1048576).toFixed(1);
            const total = (m.totalJSHeapSize / 1048576).toFixed(1);
            const limit = (m.jsHeapSizeLimit / 1048576).toFixed(0);
            const pct = ((m.usedJSHeapSize / m.jsHeapSizeLimit) * 100).toFixed(0);
            const memColor = m.usedJSHeapSize / m.jsHeapSizeLimit > 0.7 ? '#ffb74d' : '#a5d6a7';

            html += `<div class="debug-section">`;
            html += `<div class="debug-title">Memory (JS Heap)</div>`;
            html += `<div class="debug-row"><span>Used</span><span class="debug-value" style="color:${memColor}">${used} MB (${pct}%)</span></div>`;
            html += `<div class="debug-row"><span>Allocated</span><span class="debug-value">${total} MB</span></div>`;
            html += `<div class="debug-row"><span>Limit</span><span class="debug-value">${limit} MB</span></div>`;
            // Memory bar
            html += `<div style="width:100%;height:8px;background:rgba(255,255,255,0.1);border-radius:4px;margin-top:6px;overflow:hidden">`;
            html += `<div style="width:${pct}%;height:100%;background:${memColor};border-radius:4px;transition:width 0.3s"></div>`;
            html += `</div>`;
            html += `</div>`;
        }

        // Battery section
        if (battery) {
            const level = Math.round(battery.level * 100);
            const charging = battery.charging;
            const battColor = level <= 20 ? '#ef9a9a' : level <= 50 ? '#ffb74d' : '#a5d6a7';
            const elapsed = Date.now() - batteryStartTime;
            const drainedPct = Math.round((batteryStartLevel - battery.level) * 100);

            html += `<div class="debug-section">`;
            html += `<div class="debug-title">Battery</div>`;
            html += `<div class="debug-row"><span>Level</span><span class="debug-value" style="color:${battColor};font-size:16px;font-weight:bold">${level}%${charging ? ' ⚡' : ''}</span></div>`;
            html += `<div class="debug-row"><span>Status</span><span class="debug-value">${charging ? 'Charging' : 'Discharging'}</span></div>`;
            if (!charging && battery.dischargingTime < Infinity) {
                const mins = Math.round(battery.dischargingTime / 60);
                html += `<div class="debug-row"><span>Time Left</span><span class="debug-value">${mins} min</span></div>`;
            }
            // Drain since session start
            const elapsedMin = (elapsed / 60000).toFixed(1);
            if (drainedPct > 0) {
                const drainPerHour = ((drainedPct / elapsed) * 3600000).toFixed(1);
                html += `<div class="debug-row"><span>Drain (session)</span><span class="debug-value">${drainedPct}% in ${elapsedMin} min</span></div>`;
                html += `<div class="debug-row"><span>Drain Rate</span><span class="debug-value" style="color:#ffb74d">${drainPerHour}%/h</span></div>`;
            } else {
                html += `<div class="debug-row"><span>Session</span><span class="debug-value">${elapsedMin} min, no drain</span></div>`;
            }
            // Battery bar
            html += `<div style="width:100%;height:8px;background:rgba(255,255,255,0.1);border-radius:4px;margin-top:6px;overflow:hidden">`;
            html += `<div style="width:${level}%;height:100%;background:${battColor};border-radius:4px;transition:width 0.3s"></div>`;
            html += `</div>`;
            html += `</div>`;
        }

        // Active videos
        const activeVids: string[] = [];
        for (const vid of engine.containerElement.querySelectorAll('video')) {
            if (!vid.paused) activeVids.push(vid.id || vid.src.split('/').pop() || 'unknown');
        }
        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Active Videos (${activeVids.length})</div>`;
        if (activeVids.length === 0) {
            html += `<div class="debug-row dim">None playing</div>`;
        } else {
            for (const name of activeVids) {
                html += `<div class="debug-row"><span>${name}</span></div>`;
            }
        }
        html += `</div>`;

        // Reset button
        html += `<button class="debug-btn debug-btn-full" data-action="reset-perf-stats" style="margin-top:6px">↺ Reset Stats</button>`;

        perfContent.innerHTML = html;

        // Draw FPS graph
        const fpsCanvas = perfContent.querySelector('#debug-fps-graph') as HTMLCanvasElement | null;
        if (fpsCanvas) {
            const ctx = fpsCanvas.getContext('2d');
            if (ctx) {
                const w = fpsCanvas.width;
                const h = fpsCanvas.height;
                ctx.clearRect(0, 0, w, h);

                // 30fps & 60fps guide lines
                const y60 = h - (60 / 70) * h;
                const y30 = h - (30 / 70) * h;
                ctx.strokeStyle = 'rgba(255,255,255,0.15)';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(0, y60); ctx.lineTo(w, y60);
                ctx.moveTo(0, y30); ctx.lineTo(w, y30);
                ctx.stroke();
                ctx.setLineDash([]);

                // FPS line
                if (fpsHistory.length > 1) {
                    ctx.beginPath();
                    const step = w / (FPS_HISTORY_SIZE - 1);
                    const startIdx = FPS_HISTORY_SIZE - fpsHistory.length;
                    for (let i = 0; i < fpsHistory.length; i++) {
                        const x = (startIdx + i) * step;
                        const y = h - (Math.min(fpsHistory[i], 70) / 70) * h;
                        if (i === 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.strokeStyle = '#6cb4ee';
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                }
            }
        }

        // Draw frame time graph
        const ftCanvas = perfContent.querySelector('#debug-frametime-graph') as HTMLCanvasElement | null;
        if (ftCanvas) {
            const ctx = ftCanvas.getContext('2d');
            if (ctx) {
                const w = ftCanvas.width;
                const h = ftCanvas.height;
                ctx.clearRect(0, 0, w, h);

                // 16.6ms (60fps) & 33.3ms (30fps) guide lines
                const maxMs = 50;
                const y16 = h - (16.6 / maxMs) * h;
                const y33 = h - (33.3 / maxMs) * h;
                ctx.strokeStyle = 'rgba(255,255,255,0.15)';
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(0, y16); ctx.lineTo(w, y16);
                ctx.moveTo(0, y33); ctx.lineTo(w, y33);
                ctx.stroke();
                ctx.setLineDash([]);

                // Frame time bars
                if (frameTimeHistory.length > 1) {
                    const data = frameTimeHistory.slice(-FPS_HISTORY_SIZE);
                    const barW = w / FPS_HISTORY_SIZE;
                    const startIdx = FPS_HISTORY_SIZE - data.length;
                    for (let i = 0; i < data.length; i++) {
                        const x = (startIdx + i) * barW;
                        const val = Math.min(data[i], maxMs);
                        const barH = (val / maxMs) * h;
                        ctx.fillStyle = data[i] > 33.3 ? '#ef9a9a' : data[i] > 16.6 ? '#ffb74d' : '#a5d6a7';
                        ctx.fillRect(x, h - barH, barW - 0.5, barH);
                    }
                }
            }
        }
    };

    const mountSliders = (root: HTMLElement): void => {
        for (const el of root.querySelectorAll<HTMLElement>('.debug-slider')) {
            if (el.dataset.mounted) continue;
            el.dataset.mounted = '1';

            const min = Number.parseFloat(el.dataset.min ?? '0.25');
            const max = Number.parseFloat(el.dataset.max ?? '3');
            const step = Number.parseFloat(el.dataset.step ?? '0.05');
            let value = Number.parseFloat(el.dataset.value ?? '1');
            const action = el.dataset.action ?? '';
            const id = el.dataset.id ?? '';

            const track = document.createElement('div');
            track.className = 'debug-slider-track';
            const fill = document.createElement('div');
            fill.className = 'debug-slider-fill';
            const thumb = document.createElement('div');
            thumb.className = 'debug-slider-thumb';
            el.appendChild(track);
            el.appendChild(fill);
            el.appendChild(thumb);

            const valueLabel = el.nextElementSibling as HTMLElement | null;

            const updateVisual = (): void => {
                const pct = (value - min) / (max - min);
                const px = pct * el.clientWidth;
                fill.style.width = `${px}px`;
                thumb.style.left = `${px}px`;
                if (valueLabel?.classList.contains('debug-speed-value')) {
                    valueLabel.textContent = `${value.toFixed(2)}x`;
                }
            };

            const applyValue = (clientX: number): void => {
                const rect = el.getBoundingClientRect();
                let pct = (clientX - rect.left) / rect.width;
                pct = Math.max(0, Math.min(1, pct));
                let raw = min + pct * (max - min);
                raw = Math.round(raw / step) * step;
                value = Math.max(min, Math.min(max, raw));
                updateVisual();

                switch (action) {
                    case 'set-bg-speed':
                        engine.setBackgroundPlaybackRate(value);
                        break;
                    case 'set-anim-speed':
                        if (id) engine.setAnimationPlaybackRate(id, value);
                        break;
                    case 'set-layer-speed':
                        if (id) engine.setAdditionalLayerPlaybackRate(id, value);
                        break;
                }
            };

            const onPointerMove = (e: PointerEvent): void => {
                e.preventDefault();
                applyValue(e.clientX);
            };

            const onPointerUp = (e: PointerEvent): void => {
                el.releasePointerCapture(e.pointerId);
                el.classList.remove('debug-slider-active');
                el.removeEventListener('pointermove', onPointerMove);
                el.removeEventListener('pointerup', onPointerUp);
                sliderActive = false;
            };

            el.addEventListener('pointerdown', (e: PointerEvent) => {
                e.preventDefault();
                e.stopPropagation();
                sliderActive = true;
                el.setPointerCapture(e.pointerId);
                el.classList.add('debug-slider-active');
                applyValue(e.clientX);
                el.addEventListener('pointermove', onPointerMove);
                el.addEventListener('pointerup', onPointerUp);
            });

            requestAnimationFrame(updateVisual);
        }
    };

    // ── Auto-rotate via DeviceOrientation ──
    const applyRotation = (rotated: boolean): void => {
        isRotated = rotated;
        document.body.style.transform = isRotated ? 'rotate(180deg)' : '';
        document.body.style.transformOrigin = 'center center';
    };

    const onDeviceOrientation = (e: DeviceOrientationEvent): void => {
        if (!autoRotate) return;
        const beta = e.beta; // -180 to 180
        if (beta === null) return;
        // Positive beta → normal, negative beta → rotated 180°
        // 15° hysteresis to avoid flickering around 0°
        if (!isRotated && beta < -15) {
            applyRotation(true);
        } else if (isRotated && beta > 15) {
            applyRotation(false);
        }
    };

    window.addEventListener('deviceorientation', onDeviceOrientation);

    // ── Tab switching ──
    const switchTab = (tab: string): void => {
        activeTab = tab;
        tabButtons.forEach(b => {
            b.classList.toggle('debug-tab-active', b.dataset.tab === tab);
        });
        content.classList.add('debug-tab-hidden');
        scenesContent.classList.add('debug-tab-hidden');
        configContent.classList.add('debug-tab-hidden');
        layersContent.classList.add('debug-tab-hidden');
        perfContent.classList.add('debug-tab-hidden');

        if (tab === 'status') {
            content.classList.remove('debug-tab-hidden');
        } else if (tab === 'scenes') {
            scenesContent.classList.remove('debug-tab-hidden');
            refreshScenes();
        } else if (tab === 'config') {
            configContent.classList.remove('debug-tab-hidden');
            refreshConfig();
        } else if (tab === 'layers') {
            layersContent.classList.remove('debug-tab-hidden');
            refreshLayers();
        } else if (tab === 'perf') {
            perfContent.classList.remove('debug-tab-hidden');
            startPerfLoops();
            refreshPerf();
        }

        if (tab !== 'perf') stopPerfLoops();
    };

    for (const tabBtn of tabButtons) {
        tabBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            switchTab(tabBtn.dataset.tab!);
        });
    }

    /** Render the full config view */
    const refreshScenes = (): void => {
        const activeSceneId = engine.sceneId;
        let html = '';

        if (config.scenes.length === 0) {
            html += `<div class="debug-section"><div class="debug-row dim">No scenes configured</div></div>`;
            scenesContent.innerHTML = html;
            return;
        }

        for (const scene of config.scenes) {
            const isActive = scene.id === activeSceneId;
            html += `<div class="debug-section debug-config-card${isActive ? ' debug-scene-active' : ''}">`;
            html += `<div class="debug-title" style="display:flex;align-items:center;gap:6px">`;
            html += scene.id;
            if (isActive) html += ` <span class="debug-badge badge-idle">ACTIVE</span>`;
            html += `</div>`;
            html += `<div class="debug-row"><span>background</span><span class="debug-value">${scene.background.source}</span></div>`;
            if (scene.entryAnimation) {
                html += `<div class="debug-row"><span>entryAnimation</span><span class="debug-value">${scene.entryAnimation.source}</span></div>`;
            }
            if (scene.exitAnimation) {
                html += `<div class="debug-row"><span>exitAnimation</span><span class="debug-value">${scene.exitAnimation.source}</span></div>`;
            }
            if (scene.sceneDuration) {
                const dMin = (scene.sceneDuration.min / 1000).toFixed(0);
                const dMax = (scene.sceneDuration.max / 1000).toFixed(0);
                html += `<div class="debug-row"><span>duration</span><span class="debug-value">${dMin}s – ${dMax}s</span></div>`;
            }
            html += `<div class="debug-row"><span>animations</span><span class="debug-value">${scene.animations.length}</span></div>`;
            html += `<div class="debug-row"><span>layers</span><span class="debug-value">${scene.additionalLayers?.length ?? 0}</span></div>`;
            if (!isActive && transitionToScene) {
                html += `<button class="debug-btn debug-btn-full" data-action="transition-to-scene" data-id="${scene.id}">↪ Transition here</button>`;
            }
            html += `</div>`;
        }

        scenesContent.innerHTML = html;
    };

    /** Render the full config view */
    const refreshConfig = (): void => {
        const currentScene = config.scenes.find(s => s.id === engine.sceneId);
        if (!currentScene) return;

        let html = '';

        // Scene info
        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Scene: ${currentScene.id}</div>`;
        html += `<div class="debug-row"><span>Background:</span><span class="debug-value">${currentScene.background.source}</span></div>`;
        html += `<div class="debug-row"><span>BG Loop:</span><span class="debug-value">${currentScene.background.loop}</span></div>`;
        html += `<div class="debug-row"><span>Default Anim:</span><span class="debug-value">${currentScene.defaultAnimation}</span></div>`;
        if (currentScene.defaultMood) {
            html += `<div class="debug-row"><span>Default Mood:</span><span class="debug-value">${currentScene.defaultMood}</span></div>`;
        }
        html += `</div>`;

        // All animations config
        for (const anim of currentScene.animations) {
            html += `<div class="debug-section debug-config-card">`;
            html += `<div class="debug-title">${anim.id}</div>`;
            html += `<div class="debug-row"><span>source</span><span class="debug-value">${anim.source}</span></div>`;
            html += `<div class="debug-row"><span>loop</span><span class="debug-value">${anim.loop}</span></div>`;
            if (anim.loopCount != null) {
                html += `<div class="debug-row"><span>loopCount</span><span class="debug-value">${anim.loopCount}</span></div>`;
            }
            if (anim.entryTransition) {
                html += `<div class="debug-row"><span>entryTransition</span><span class="debug-value">${anim.entryTransition}</span></div>`;
            }
            if (anim.exitTransition) {
                html += `<div class="debug-row"><span>exitTransition</span><span class="debug-value">${anim.exitTransition}</span></div>`;
            }
            if (anim.setsMood) {
                html += `<div class="debug-row"><span>setsMood</span><span class="debug-value">${anim.setsMood}</span></div>`;
            }

            if (anim.interactionTriggers && anim.interactionTriggers.length > 0) {
                html += `<div class="debug-config-sub">`;
                html += `<div class="debug-config-sub-title">Triggers (${anim.interactionTriggers.length})</div>`;
                for (const trigger of anim.interactionTriggers) {
                    html += `<div class="debug-config-trigger">`;
                    html += `<div class="debug-row"><span>type</span><span class="debug-badge ${trigger.type === 'touch' ? 'badge-touch' : trigger.type === 'rub' ? 'badge-touch' : 'badge-random'}">${trigger.type}</span></div>`;
                    html += `<div class="debug-row"><span>waitForCompletion</span><span class="debug-value">${trigger.waitForCompletion}</span></div>`;
                    if (trigger.loopWhileActive) {
                        html += `<div class="debug-row"><span>loopWhileActive</span><span class="debug-value">true</span></div>`;
                    }
                    if (trigger.duration != null) {
                        html += `<div class="debug-row"><span>duration</span><span class="debug-value">${trigger.duration}ms</span></div>`;
                    }
                    if ((trigger.type === 'touch' || trigger.type === 'rub') && trigger.region) {
                        const r = trigger.region;
                        html += `<div class="debug-row"><span>region</span><span class="debug-value">x:${r.x} y:${r.y} w:${r.width} h:${r.height}</span></div>`;
                    }
                    if (trigger.type === 'random' && trigger.timeRange) {
                        html += `<div class="debug-row"><span>timeRange</span><span class="debug-value">${trigger.timeRange.min}ms – ${trigger.timeRange.max}ms</span></div>`;
                    }
                    html += `</div>`;
                }
                html += `</div>`;
            }

            html += `</div>`;
        }

        // Moods config
        if (currentScene.moods && currentScene.moods.length > 0) {
            html += `<div class="debug-section">`;
            html += `<div class="debug-title">Moods (${currentScene.moods.length})</div>`;
            for (const mood of currentScene.moods) {
                html += `<div class="debug-config-card" style="padding:4px 0">`;
                html += `<div class="debug-row"><span style="font-weight:bold">${mood.id}</span></div>`;
                if (mood.setAnimations && mood.setAnimations.length > 0) {
                    html += `<div class="debug-config-sub">`;
                    html += `<div class="debug-config-sub-title">setAnimations</div>`;
                    for (const override of mood.setAnimations) {
                        html += `<div class="debug-config-trigger">`;
                        html += `<div class="debug-row"><span>animation</span><span class="debug-value">${override.animation}</span></div>`;
                        if (override.speed != null) {
                            html += `<div class="debug-row"><span>speed</span><span class="debug-value">${override.speed}</span></div>`;
                        }
                        if (override.source) {
                            html += `<div class="debug-row"><span>source</span><span class="debug-value">${override.source}</span></div>`;
                        }
                        html += `</div>`;
                    }
                    html += `</div>`;
                }
                if (mood.interactionTriggers && mood.interactionTriggers.length > 0) {
                    html += `<div class="debug-config-sub">`;
                    html += `<div class="debug-config-sub-title">Triggers (${mood.interactionTriggers.length})</div>`;
                    for (const trigger of mood.interactionTriggers) {
                        html += `<div class="debug-config-trigger">`;
                        html += `<div class="debug-row"><span>type</span><span class="debug-badge ${trigger.type === 'random' ? 'badge-random' : 'badge-touch'}">${trigger.type}</span></div>`;
                        if (trigger.timeRange) {
                            html += `<div class="debug-row"><span>timeRange</span><span class="debug-value">${trigger.timeRange.min}ms – ${trigger.timeRange.max}ms</span></div>`;
                        }
                        if (trigger.duration != null) {
                            html += `<div class="debug-row"><span>duration</span><span class="debug-value">${trigger.duration}ms</span></div>`;
                        }
                        html += `</div>`;
                    }
                    html += `</div>`;
                }
                html += `</div>`;
            }
            html += `</div>`;
        }

        configContent.innerHTML = html;
    };

    const refreshLayers = (): void => {
        const layerStates = engine.getAdditionalLayerStates();

        let html = '';
        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Additional Layers (${layerStates.length})</div>`;

        if (layerStates.length === 0) {
            html += `<div class="debug-row dim">No additional layers for this scene</div>`;
            html += `</div>`;
            layersContent.innerHTML = html;
            return;
        }

        for (const layer of layerStates) {
            const visibilityClass = layer.visible ? 'debug-btn-active' : '';
            const visibilityLabel = layer.visible ? 'Visible' : 'Hidden';
            const layerRate = engine.getAdditionalLayerPlaybackRate(layer.key);

            html += `<div class="debug-layer-card">`;
            html += `<div class="debug-row">`;
            html += `<span class="debug-layer-source">${layer.source}</span>`;
            html += `<span class="debug-badge ${layer.visible ? 'badge-idle' : 'badge-active'}">${visibilityLabel}</span>`;
            html += `</div>`;
            html += `<div class="debug-row anim-detail"><span>priority</span><span>${layer.layerPriority}</span></div>`;
            html += `<div class="debug-row anim-detail"><span>order</span><span>${layer.layerOrder}</span></div>`;
            html += `<div class="debug-speed-row-with-reset">`;
            html += `<span class="debug-speed-label">speed</span>`;
            html += `<div class="debug-slider" data-min="0.25" data-max="3" data-step="0.05" data-value="${layerRate.toFixed(2)}" data-action="set-layer-speed" data-id="${layer.key}"></div>`;
            html += `<span class="debug-speed-value">${layerRate.toFixed(2)}x</span>`;
            html += `<button class="debug-speed-reset" data-action="reset-layer-speed" data-id="${layer.key}" title="Reset speed">↺</button>`;
            html += `</div>`;
            html += `<button class="debug-btn debug-btn-full ${visibilityClass}" data-action="toggle-layer" data-id="${layer.key}">${layer.visible ? 'Hide Layer' : 'Show Layer'}</button>`;
            html += `</div>`;
        }

        html += `</div>`;
        layersContent.innerHTML = html;
        mountSliders(layersContent);
    };

    // Overlay container — lives inside #mascot-container so it's positioned relative to it
    const overlayContainer = document.createElement('div');
    overlayContainer.id = 'debug-touch-overlays';
    engine.containerElement.appendChild(overlayContainer);

    /** Rebuild the touch-region overlay divs based on current state */
    const refreshOverlays = (): void => {
        overlayContainer.innerHTML = '';
        if (!showTouchRegions) return;

        const container = engine.containerElement;
        const containerW = container.clientWidth;
        const containerH = container.clientHeight;

        // We need a reference video's native size to compute the cover mapping.
        // Use the currently playing video, fall back to first loaded.
        let nativeSize = engine.getVideoNativeSize(engine.currentAnimation);
        if (!nativeSize) {
            for (const id of engine.loadedVideoIds) {
                nativeSize = engine.getVideoNativeSize(id);
                if (nativeSize) break;
            }
        }
        if (!nativeSize) return;

        let colorIdx = 0;
        for (const anim of engine.allAnimations) {
            if (!anim.interactionTriggers) continue;
            for (const trigger of anim.interactionTriggers) {
                if ((trigger.type !== 'touch' && trigger.type !== 'rub') || !trigger.region) continue;

                const px = regionToContainerPx(
                    trigger.region, containerW, containerH,
                    nativeSize.width, nativeSize.height,
                );

                const color = REGION_COLORS[colorIdx % REGION_COLORS.length];
                const borderColor = color.replace('0.30', '0.8');
                colorIdx++;

                const div = document.createElement('div');
                div.className = 'debug-touch-region';
                div.style.left = `${px.left}px`;
                div.style.top = `${px.top}px`;
                div.style.width = `${px.width}px`;
                div.style.height = `${px.height}px`;
                div.style.background = color;
                div.style.borderColor = borderColor;

                const label = document.createElement('span');
                label.className = 'debug-touch-label';
                label.textContent = `${anim.id} (${trigger.type})`;
                label.style.background = borderColor;
                div.appendChild(label);

                overlayContainer.appendChild(div);
            }
        }
    };

    const refresh = (): void => {
        const current = engine.currentAnimation;
        const idle = engine.isIdle;
        const defaultAnim = engine.defaultAnimationId;
        const queue = engine.currentQueue;
        const allAnims = engine.allAnimations;
        const loaded = new Set(engine.loadedVideoIds);
        const bgRate = engine.getBackgroundPlaybackRate();
        const currentMood = engine.currentMood;
        const moods = engine.availableMoods;

        let html = '';

        // ── Scene selector ──
        if (config.scenes.length > 1) {
            const rotationLocked = sceneRotation?.isLocked() ?? false;
            html += `<div class="debug-section">`;
            html += `<div class="debug-title">Scene</div>`;
            html += `<div class="debug-btn-grid">`;
            for (const scene of config.scenes) {
                const active = scene.id === engine.sceneId;
                html += `<button class="debug-btn${active ? ' debug-btn-active' : ''}" data-action="scene" data-id="${scene.id}">${scene.id}</button>`;
            }
            html += `</div>`;
            if (sceneRotation) {
                html += `<button class="debug-btn debug-btn-full${rotationLocked ? ' debug-btn-active' : ''}" data-action="toggle-scene-lock">${rotationLocked ? '🔒 Scene Locked (rotation paused)' : '🔓 Lock Scene (stop rotation)'}</button>`;
            }
            html += `</div>`;
        }

        // ── Status ──
        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Status</div>`;
        html += `<div class="debug-row"><span>Scene:</span><span class="debug-value">${engine.sceneId}</span></div>`;
        html += `<div class="debug-row"><span>State:</span><span class="debug-badge ${idle ? 'badge-idle' : 'badge-active'}">${idle ? 'IDLE' : 'ACTIVE'}</span></div>`;
        html += `<div class="debug-row"><span>Playing now:</span><span class="debug-value">${current}</span></div>`;
        html += `<div class="debug-row"><span>Default:</span><span class="debug-value">${defaultAnim}</span></div>`;
        if (moods.length > 0) {
            html += `<div class="debug-row"><span>Mood:</span><span class="debug-badge badge-idle">${currentMood || 'none'}</span></div>`;
        }
        html += `<div class="debug-speed-row-with-reset">`;
        html += `<span class="debug-speed-label">BG speed</span>`;
        html += `<div class="debug-slider" data-min="0.25" data-max="3" data-step="0.05" data-value="${bgRate.toFixed(2)}" data-action="set-bg-speed"></div>`;
        html += `<span class="debug-speed-value">${bgRate.toFixed(2)}x</span>`;
        html += `<button class="debug-speed-reset" data-action="reset-bg-speed" title="Reset speed">↺</button>`;
        html += `</div>`;
        html += `<button class="debug-btn debug-btn-full" data-action="reset-all-speeds" style="margin-top:6px">↺ Reset All Speeds</button>`;
        html += `</div>`;

        // ── Queue ──
        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Queue (${queue.length})</div>`;
        if (sceneRotation) {
            const rotationLocked = sceneRotation.isLocked();
            const nextTransition = sceneRotation.getNextTransition();
            if (rotationLocked) {
                html += `<div class="debug-row"><span>🔒 Scene change</span><span class="debug-value dim">Locked</span></div>`;
            } else if (nextTransition) {
                const secsLeft = Math.max(0, Math.ceil(nextTransition.remainingMs / 1000));
                html += `<div class="debug-row"><span>🎬 Scene change ▸</span><span class="debug-value">${nextTransition.sceneId} in ${secsLeft}s</span></div>`;
            }
        }
        if (queue.length === 0) {
            html += `<div class="debug-row dim">Empty</div>`;
        } else {
            queue.forEach((item, i) => {
                const label = i === 0 ? 'Next ▸' : `#${i + 1}`;
                html += `<div class="debug-row"><span>${label}</span><span class="debug-value">${item.animationId} ×${item.repeatCount}</span></div>`;
            });
        }
        if (queue.length > 0) {
            html += `<button class="debug-btn debug-btn-danger debug-btn-full" data-action="clear-queue">Clear Queue</button>`;
        }
        html += `</div>`;

        // ── Controls ──
        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Controls</div>`;
        html += `<button class="debug-btn debug-btn-full" data-action="go-idle">Back to Idle</button>`;
        html += `<button class="debug-btn debug-btn-full${showTouchRegions ? ' debug-btn-active' : ''}" data-action="toggle-touch">${showTouchRegions ? 'Hide' : 'Show'} Touch Regions</button>`;
        html += `<button class="debug-btn debug-btn-full${isRotated ? ' debug-btn-active' : ''}" data-action="rotate-screen">${isRotated ? 'Reset Rotation' : 'Rotate 180°'}</button>`;
        html += `<button class="debug-btn debug-btn-full${autoRotate ? ' debug-btn-active' : ''}" data-action="toggle-auto-rotate">Auto-Rotate ${autoRotate ? '(ON)' : '(OFF)'}</button>`;
        if (moods.length > 0) {
            html += `<div class="debug-title" style="margin-top:8px">Moods</div>`;
            html += `<div class="debug-btn-grid">`;
            for (const mood of moods) {
                const active = mood === currentMood;
                html += `<button class="debug-btn${active ? ' debug-btn-active' : ''}" data-action="set-mood" data-id="${mood}">${mood}</button>`;
            }
            html += `</div>`;
        }
        html += `</div>`;

        // ── Animations ──
        html += `<div class="debug-section">`;
        html += `<div class="debug-title">Animations (${allAnims.length})</div>`;
        for (const anim of allAnims) {
            const inMemory = loaded.has(anim.id);
            const readyState = engine.getVideoReadyState(anim.id);
            const readyLabel = READY_STATE_LABELS[readyState] ?? `${readyState}`;
            const isPlaying = current === anim.id;
            const animRate = engine.getAnimationPlaybackRate(anim.id);

            let statusIcon = '⚪';
            if (isPlaying) statusIcon = '▶️';
            else if (inMemory && readyState >= 4) statusIcon = '🟢';
            else if (inMemory) statusIcon = '🟡';
            else statusIcon = '🔴';

            html += `<div class="debug-anim-card${isPlaying ? ' anim-playing' : ''}">`;
            html += `<div class="debug-row anim-row">`;
            html += `<span>${statusIcon} ${anim.id}</span>`;
            html += `<span class="debug-value">${inMemory ? readyLabel : 'NOT LOADED'}</span>`;
            html += `</div>`;

            // Info sub-rows
            if (anim.loop) html += `<div class="debug-row anim-detail"><span>loop</span><span>${anim.loopCount ? `×${anim.loopCount}` : '∞'}</span></div>`;
            if (anim.entryTransition) html += `<div class="debug-row anim-detail"><span>entry</span><span>${anim.entryTransition}</span></div>`;
            if (anim.exitTransition) html += `<div class="debug-row anim-detail"><span>exit</span><span>${anim.exitTransition}</span></div>`;
            if (anim.setsMood) html += `<div class="debug-row anim-detail"><span>setsMood</span><span>${anim.setsMood}</span></div>`;
            html += `<div class="debug-speed-row-with-reset">`;
            html += `<span class="debug-speed-label">speed</span>`;
            html += `<div class="debug-slider" data-min="0.25" data-max="3" data-step="0.05" data-value="${animRate.toFixed(2)}" data-action="set-anim-speed" data-id="${anim.id}"></div>`;
            html += `<span class="debug-speed-value">${animRate.toFixed(2)}x</span>`;
            html += `<button class="debug-speed-reset" data-action="reset-anim-speed" data-id="${anim.id}" title="Reset speed">↺</button>`;
            html += `</div>`;

            // Action buttons
            html += `<div class="debug-btn-row">`;
            html += `<button class="debug-btn debug-btn-sm" data-action="trigger" data-id="${anim.id}" title="Trigger (queued with transitions)">▶ Trigger</button>`;
            html += `<button class="debug-btn debug-btn-sm debug-btn-warn" data-action="interrupt" data-id="${anim.id}" title="Interrupt (immediate, no transitions)">⚡ Interrupt</button>`;
            html += `</div>`;

            html += `</div>`;
        }
        html += `</div>`;

        // Legend
        html += `<div class="debug-section debug-legend">`;
        html += `▶️ playing &nbsp; 🟢 ready &nbsp; 🟡 loading &nbsp; 🔴 not loaded`;
        html += `</div>`;

        content.innerHTML = html;
        mountSliders(content);
    };

    const handleAction = (action: string | undefined, id: string | undefined): void => {
        switch (action) {
            case 'trigger':
                if (id) engine.triggerWhenIdle(id);
                break;
            case 'interrupt':
                if (id) engine.interruptWith(id);
                break;
            case 'go-idle':
                engine.interruptWith(engine.defaultAnimationId);
                break;
            case 'clear-queue':
                engine.interruptWith(engine.defaultAnimationId);
                break;
            case 'toggle-touch':
                showTouchRegions = !showTouchRegions;
                refreshOverlays();
                refresh();
                break;
            case 'rotate-screen':
                autoRotate = false;
                applyRotation(!isRotated);
                refresh();
                break;
            case 'toggle-auto-rotate':
                autoRotate = !autoRotate;
                if (!autoRotate) {
                    applyRotation(false);
                }
                refresh();
                break;
            case 'toggle-scene-lock':
                if (sceneRotation) {
                    sceneRotation.setLocked(!sceneRotation.isLocked());
                    refresh();
                }
                break;
            case 'toggle-layer':
                if (id) {
                    const state = engine.getAdditionalLayerStates().find(layer => layer.key === id);
                    if (state) {
                        engine.setAdditionalLayerVisible(id, !state.visible);
                        refreshLayers();
                    }
                }
                break;
            case 'scene': {
                if (!id || id === engine.sceneId) break;
                if (transitionToScene) {
                    void transitionToScene(id).catch(console.warn);
                } else {
                    const newScene = config.scenes.find(s => s.id === id);
                    if (newScene) engine.switchScene(newScene);
                }
                break;
            }
            case 'transition-to-scene': {
                if (!id || id === engine.sceneId) break;
                if (transitionToScene) void transitionToScene(id).catch(console.warn);
                break;
            }
            case 'set-mood':
                if (id) engine.setMood(id).catch(console.warn);
                break;
            case 'reset-anim-speed':
                if (id) engine.setAnimationPlaybackRate(id, 1);
                break;
            case 'reset-bg-speed':
                engine.setBackgroundPlaybackRate(1);
                break;
            case 'reset-layer-speed':
                if (id) engine.setAdditionalLayerPlaybackRate(id, 1);
                break;
            case 'reset-perf-stats':
                fpsHistory.length = 0;
                fpsMin = Infinity;
                fpsMax = 0;
                frameTimeHistory.length = 0;
                if (battery) {
                    batteryStartLevel = battery.level;
                    batteryStartTime = Date.now();
                }
                break;
            case 'reset-all-speeds': {
                engine.setBackgroundPlaybackRate(1);
                for (const anim of engine.allAnimations) {
                    engine.setAnimationPlaybackRate(anim.id, 1);
                }
                for (const layer of engine.getAdditionalLayerStates()) {
                    engine.setAdditionalLayerPlaybackRate(layer.key, 1);
                }
                break;
            }
        }
    };

    // Delegate button clicks inside the status tab
    content.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!target) return;
        e.stopPropagation();

        handleAction(target.dataset.action, target.dataset.id);
    });

    // Delegate button clicks inside the layers tab
    layersContent.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!target) return;
        e.stopPropagation();

        handleAction(target.dataset.action, target.dataset.id);
    });

    // Delegate button clicks inside the scenes tab
    scenesContent.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!target) return;
        e.stopPropagation();

        handleAction(target.dataset.action, target.dataset.id);
    });

    perfContent.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
        if (!target) return;
        e.stopPropagation();

        handleAction(target.dataset.action, target.dataset.id);
    });

    const openPanel = (): void => {
        open = true;
        panel.classList.remove('debug-hidden');
        panel.classList.add('debug-visible');
        if (activeTab === 'perf') startPerfLoops();
        refresh();
        refreshOverlays();
        intervalId = setInterval(() => {
            if (document.hidden || sliderActive) return;
            refresh();
            refreshOverlays();
            if (activeTab === 'config') refreshConfig();
            if (activeTab === 'layers') refreshLayers();
            if (activeTab === 'scenes') refreshScenes();
            if (activeTab === 'perf') refreshPerf();
        }, 500);
    };

    const closePanel = (): void => {
        open = false;
        panel.classList.remove('debug-visible');
        panel.classList.add('debug-hidden');
        stopPerfLoops();
        if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
        }
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (open) closePanel();
        else openPanel();
    });

    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closePanel();
    });

    // Prevent touches on the panel from triggering animation
    panel.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    panel.addEventListener('pointermove', (e) => e.stopPropagation());
    panel.addEventListener('pointerup', (e) => e.stopPropagation());
    panel.addEventListener('click', (e) => e.stopPropagation());
}
