(function() {
    var renderer, camera, scene;
    var input, levelHelper, cameraHelper;
    var map = [];
    var running = false;
    var isWarmUp = true; 

    var experimentMode = null; 
    var fireEnabled = false; 
    var _plActive = false;
    var _mouseSensitivity = 0.002;
    var _keys = { w: false, a: false, s: false, d: false };
    var _skipFirstMouseMove = false;

    // === Fire and Smoke System ===
    var fireSystem, smokeSystem;
    var fireParticles = 1500;
    var smokeParticles = 2000;
    var fireSourcePosition = new THREE.Vector3(); 
    var fireRadius = 0;                           
    var fireSpreadRate = 0.15;                    
    var fireGraceRadius = 100;
    var warmUpTimer = 0;

    // === Data Logging ===
    var viewportLogs = [], minimapLogs = { hovers: {} }, gazeLogs = []; 
    var lastLogTime = 0, LOG_INTERVAL = 250; 
    var gazeBuffer = [], GAZE_BUFFER_SIZE = 8;
    var mapScale = 16; 

    // === Study Control ===
    var StudyControl = {
        userId: null,
        phase: 0,
        segment: 1,
        masterLogs: [],
        mapSequence: ['00', 1, 2],
        conditionOrder: []        
    };

    function $(id){ return document.getElementById(id); }
    
    // 修复判定逻辑：确保与 initializeScene 生成墙体的逻辑 (v > 1) 严格一致
    function isWallCellByValue(v){ 
        var val = parseInt(v);
        return (!isNaN(val) && val > 1); 
    }

    window.initiateStudy = function() {
        var idInput = $('user-id').value;
        if (!idInput) { alert("Please enter a User ID (1-4)"); return; }
        StudyControl.userId = parseInt(idInput);
        
        if (StudyControl.userId === 2 || StudyControl.userId === 4) {
            StudyControl.mapSequence = ['00', 2, 1];
        } else {
            StudyControl.mapSequence = ['00', 1, 2];
        }

        if (StudyControl.userId === 1 || StudyControl.userId === 2) {
            StudyControl.conditionOrder = ['minimap', 'xray'];
        } else {
            StudyControl.conditionOrder = ['xray', 'minimap'];
        }

        $('setup-screen').style.display = 'none';
        startCalibrationPhase();
    };

    function moveToNextStep() {
        running = false;
        if (viewportLogs.length > 0 || gazeLogs.length > 0) {
            StudyControl.masterLogs.push({
                phase: StudyControl.phase,
                segment: StudyControl.segment,
                mode: experimentMode,
                fire: fireEnabled,
                mapId: StudyControl.mapSequence[StudyControl.phase],
                logs: {
                    viewport: [...viewportLogs],
                    gaze: [...gazeLogs],
                    minimap: JSON.parse(JSON.stringify(minimapLogs))
                }
            });
        }
        viewportLogs = []; gazeLogs = []; minimapLogs = { hovers: {} };

        if (StudyControl.phase === 0) {
            StudyControl.phase = 1;
            StudyControl.segment = 1;
            showTransitionScreen();
        } else if (StudyControl.segment === 1) {
            StudyControl.segment = 2; 
            showTransitionScreen();
        } else if (StudyControl.phase < StudyControl.mapSequence.length - 1) {
            StudyControl.phase++;
            StudyControl.segment = 1; 
            showTransitionScreen();
        } else {
            finishExperiment();
        }
    }

    function showTransitionScreen() {
        if (document.pointerLockElement) document.exitPointerLock();
        $('transition-screen').style.display = 'flex';
        $('transition-title').innerText = (StudyControl.segment === 1) ? "MAP COMPLETED" : "SEGMENT COMPLETED";
        
        var baseMode = getNextBaseMode();
        var suffix = (StudyControl.segment === 1) ? "1 (Tool ON, Fire OFF)" : "2 (Tool OFF, Fire ON)";
        $('transition-msg').innerText = `Next Phase: Map ${StudyControl.mapSequence[StudyControl.phase]} - ${baseMode.toUpperCase()}${suffix}`;
    }

    function getNextBaseMode() {
        if (StudyControl.phase === 0) return 'minimap';
        return StudyControl.conditionOrder[StudyControl.phase - 1];
    }

    window.resumeNextSegment = function() {
        $('transition-screen').style.display = 'none';
        isWarmUp = (StudyControl.phase === 0);
        var baseMode = getNextBaseMode();

        if (isWarmUp) {
            experimentMode = 'minimap';
            fireEnabled = false;
        } else {
            if (StudyControl.segment === 1) {
                experimentMode = baseMode;
                fireEnabled = false;
            } else {
                experimentMode = 'normal'; 
                fireEnabled = true;
            }
        }

        configureUIForMode(experimentMode);
        var displayLabel = isWarmUp ? "WARMUP" : `${baseMode.toUpperCase()}${StudyControl.segment}`;
        $('phase-indicator').innerText = `MAP ${StudyControl.mapSequence[StudyControl.phase]} | ${displayLabel}`;
        loadLevel(StudyControl.mapSequence[StudyControl.phase]);
    };

    function finishExperiment() {
        alert("Experiment complete! Downloading study data...");
        var finalBlob = {
            userId: StudyControl.userId,
            timestamp: new Date().toISOString(),
            allSessions: StudyControl.masterLogs
        };
        var a = document.createElement('a'); 
        a.href = URL.createObjectURL(new Blob([JSON.stringify(finalBlob, null, 2)], {type : 'application/json'}));
        a.download = `User_${StudyControl.userId}_FinalData.json`; 
        a.click();
        location.reload();
    }

    function calculateMapScale() {
        var container = $("minimap-container");
        if (!container || map.length === 0) return 16;
        var rect = container.getBoundingClientRect();
        var availableSize = Math.min(rect.width, rect.height) * 0.95;
        var mazeMaxDim = Math.max(map.length, map[0].length);
        return availableSize / mazeMaxDim;
    }

    function createParticleTexture() {
        var canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        var ctx = canvas.getContext('2d');
        var grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, 'white'); grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
        var tex = new THREE.Texture(canvas); tex.needsUpdate = true; return tex;
    }

    function createTextSprite(message) {
        var canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
        var ctx = canvas.getContext('2d');
        ctx.font = "Bold 100px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff"; ctx.fillText(message, 256, 128);
        var texture = new THREE.Texture(canvas); texture.needsUpdate = true;
        var sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
        sprite.scale.set(80, 40, 1); return sprite;
    }

    // === Calibration & WebGazer ===
    var calibPoints = [[10,10], [50,10], [90,10], [10,50], [50,50], [90,50], [10,90], [50,90], [90,90]];
    var currentPointIdx = 0, clicksPerPoint = 5, currentClicks = 0;

    function startCalibrationPhase() {
        $('calibration-overlay').style.display = 'block';
        initWebGazer(); 
        showNextCalibrationPoint();
    }

    function showNextCalibrationPoint() {
        if (currentPointIdx >= calibPoints.length) { finishCalibration(); return; }
        var overlay = $('calibration-overlay');
        var instr = $('calib-instruction');
        var status = $('calib-status');
        var oldDot = $('calib-dot'); if (oldDot) oldDot.remove();
        var dot = document.createElement('div');
        dot.id = 'calib-dot';
        dot.className = 'calibration-dot calibration-dot-active'; 
        dot.style.left = calibPoints[currentPointIdx][0] + '%';
        dot.style.top = calibPoints[currentPointIdx][1] + '%';
        instr.innerText = "Target: GREEN DOT. Click it 5 times.";
        instr.style.color = "#2ecc71";
        dot.onmouseover = function() { instr.innerText = "Target found! Now CLICK it."; instr.style.color = "#ffffff"; };
        dot.onclick = function() {
            currentClicks++;
            dot.style.transform = 'translate(-50%, -50%) scale(1.0)';
            setTimeout(() => { dot.style.transform = 'translate(-50%, -50%) scale(1.4)'; }, 100);
            if (currentClicks < clicksPerPoint) {
                instr.innerText = "Keep clicking! " + (clicksPerPoint - currentClicks) + " times remaining.";
            } else {
                currentPointIdx++; currentClicks = 0;
                status.innerText = `Progress: ${currentPointIdx}/9 dots`;
                showNextCalibrationPoint();
            }
        };
        overlay.appendChild(dot);
    }

    function finishCalibration() {
        $('calibration-overlay').style.display = 'none';
        $('ui-layer').style.opacity = '1';
        initializeEngine();
        resumeNextSegment();
    }

    function initWebGazer() {
        if (typeof webgazer !== 'undefined') {
            webgazer.setGazeListener(function(data) {
                if (data && running) {
                    gazeBuffer.push({ x: data.x, y: data.y });
                    if (gazeBuffer.length > GAZE_BUFFER_SIZE) gazeBuffer.shift();
                    var avgX = gazeBuffer.reduce((s, p) => s + p.x, 0) / gazeBuffer.length;
                    var avgY = gazeBuffer.reduce((s, p) => s + p.y, 0) / gazeBuffer.length;
                    gazeLogs.push({ t: Date.now(), x: Math.round(avgX), y: Math.round(avgY) });
                }
            }).begin();
            webgazer.showVideoPreview(true).showPredictionPoints(true);
            var moveUI = setInterval(function(){
                var v = $('webgazerVideoFeed'), t = $('webgazer-target');
                if (v && t && v.parentElement !== t) {
                    t.innerHTML = '';
                    [v, $('webgazerVideoCanvas'), $('webgazerFaceOverlay'), $('webgazerFaceFeedbackBox')].forEach(el => {
                        if(el) { t.appendChild(el); el.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; transform:scaleX(-1);"; }
                    });
                    clearInterval(moveUI);
                }
            }, 500);
        }
    }

    function initializeEngine() {
        if (renderer) return; 
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x1a1a1a, 0.0005);
        camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 10000);
        $("canvasContainer").appendChild(renderer.domElement);
        input = new Demonixis.Input();
        cameraHelper = new Demonixis.GameHelper.CameraHelper(camera);
        cameraHelper.translation = 5; 
        cameraHelper.rotation = 0.04;
        setupPointerLock();
        setupMinimapTracking();
        window.addEventListener("resize", function() {
            renderer.setSize(window.innerWidth, window.innerHeight);
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            drawMiniMapStatic();
        });
        window.addEventListener("keydown", (e) => { if(_keys.hasOwnProperty(e.key.toLowerCase())) _keys[e.key.toLowerCase()] = true; });
        window.addEventListener("keyup", (e) => { if(_keys.hasOwnProperty(e.key.toLowerCase())) _keys[e.key.toLowerCase()] = false; });
    }

    function initFireEffects() {
        if (!fireEnabled) return;
        fireRadius = 0; 
        var tex = createParticleTexture();
        var fireGeo = new THREE.Geometry();
        for (var i = 0; i < fireParticles; i++) fireGeo.vertices.push(fireSourcePosition.clone());
        fireSystem = new THREE.Points(fireGeo, new THREE.PointsMaterial({ map: tex, color: 0xff4400, size: 25, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
        scene.add(fireSystem);

        var smokeGeo = new THREE.Geometry();
        for (var i = 0; i < smokeParticles; i++) smokeGeo.vertices.push(new THREE.Vector3((Math.random()-0.5)*3500, Math.random()*200, (Math.random()-0.5)*3500));
        smokeSystem = new THREE.Points(smokeGeo, new THREE.PointsMaterial({ map: tex, color: (experimentMode === 'xray') ? 0x444444 : 0x222222, size: (experimentMode === 'xray') ? 40 : 80, transparent: true, opacity: 0.2, depthWrite: false }));
        scene.add(smokeSystem);
    }

    function updateEffects() {
        if (!fireSystem || !fireEnabled || !running) return;
        fireRadius += fireSpreadRate;
        fireSystem.geometry.vertices.forEach(v => {
            v.y += 1.5 + Math.random();
            if (v.y > 90 || v.distanceTo(fireSourcePosition) > fireRadius) {
                v.y = Math.random() * 10;
                var a = Math.random() * Math.PI * 2, rd = Math.random() * fireRadius;
                v.x = fireSourcePosition.x + Math.cos(a) * rd; v.z = fireSourcePosition.z + Math.sin(a) * rd;
            }
        });
        fireSystem.geometry.verticesNeedUpdate = true;
        smokeSystem.geometry.vertices.forEach(v => { v.y += 0.3; if (v.y > 180) v.y = 0; });
        smokeSystem.geometry.verticesNeedUpdate = true;
        
        var maxFog = (experimentMode === 'xray') ? 0.004 : 0.015;
        if (scene.fog.density < maxFog) scene.fog.density += 0.000008;

        if (fireRadius > fireGraceRadius && camera.position.distanceTo(fireSourcePosition) < fireRadius) {
            running = false; alert("Fire consumed you!"); 
            loadLevel(StudyControl.mapSequence[StudyControl.phase]); 
        }
    }

    // === 核心修复 1: 轴对齐滑墙 + 碰撞半径检测 ===
    function moveCamera(dir) {
        if (!running) return;
        var dx = 0, dz = 0, rot = camera.rotation.y;
        if (dir === "up") { dx = -Math.sin(rot) * 5; dz = -Math.cos(rot) * 5; }
        else if (dir === "down") { dx = Math.sin(rot) * 5; dz = Math.cos(rot) * 5; }

        var pRadius = 20; // 角色碰撞半径，防止没入墙体
        var pW = map[0].length * 100, pH = map.length * 100;
        var originX = -pW / 2, originZ = -pH / 2;

        // 碰撞检查闭包：检查中心点及四个方向的半径点
        var checkCollision = function(newX, newZ) {
            var checkOffsets = [[0,0], [pRadius,0], [-pRadius,0], [0,pRadius], [0,-pRadius]];
            for (var i = 0; i < checkOffsets.length; i++) {
                var cx = newX + checkOffsets[i][0];
                var cz = newZ + checkOffsets[i][1];
                
                // 修复坐标索引计算：移除多余的 +50 偏移以对齐 grid
                var tx = Math.floor((cx - originX) / 100);
                var ty = Math.floor((cz - originZ) / 100);

                if (ty < 0 || ty >= map.length || tx < 0 || tx >= map[0].length) return true;
                
                var cell = map[ty][tx];
                if (cell === "A" && running) {
                    if (i === 0) { moveToNextStep(); return false; } // 仅中心点触发终点
                    continue; 
                }
                if (isWallCellByValue(cell)) return true;
            }
            return false;
        };

        // 分别尝试 X 和 Z 轴移动，实现顺滑的“滑墙”效果
        if (!checkCollision(camera.position.x + dx, camera.position.z)) {
            camera.position.x += dx;
        }
        if (!checkCollision(camera.position.x, camera.position.z + dz)) {
            camera.position.z += dz;
        }
    }

    function update() {
        if (!running) return;
        if (_keys.w) moveCamera("up"); if (_keys.s) moveCamera("down");
        if (_keys.a) camera.rotation.y += 0.04; if (_keys.d) camera.rotation.y -= 0.04;
        updateMiniMapOverlay(); updateEffects();
        var now = Date.now();
        if (now - lastLogTime > LOG_INTERVAL) {
            viewportLogs.push({ t: now, x: camera.position.x.toFixed(1), z: camera.position.z.toFixed(1) });
            lastLogTime = now;
        }
    }

    // === 核心修复 2: 修正墙体生成坐标，与碰撞索引逻辑对齐 ===
    function initializeScene() {
        while(scene.children.length > 0) scene.remove(scene.children[0]);
        var loader = new THREE.TextureLoader();
        var pW = map[0].length * 100, pH = map.length * 100;
        cameraHelper.origin.x = -pW / 2; cameraHelper.origin.z = -pH / 2;
        
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(pW, 5, pH), new THREE.MeshPhongMaterial({ map: loader.load("assets/images/textures/ground_diffuse.jpg") })).translateY(1));
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(pW, 5, pH), new THREE.MeshPhongMaterial({ map: loader.load("assets/images/textures/roof_diffuse.jpg") })).translateY(100));
        
        var wallGeo = new THREE.BoxGeometry(100, 100, 100), wallMat = new THREE.MeshPhongMaterial({ map: loader.load("assets/images/textures/wall_diffuse.jpg") });
        var xrayMat = new THREE.MeshBasicMaterial({ color: 0x0066ff, transparent: true, opacity: 0.3, depthWrite: false });
        
        var isXrayVisual = (experimentMode === 'xray');

        for (var y = 0; y < map.length; y++) {
            for (var x = 0; x < map[y].length; x++) {
                // 将墙体中心对齐到方格中心 (坐标 +50)
                var px = -pW / 2 + 100 * x + 50;
                var pz = -pH / 2 + 100 * y + 50;
                
                if (isWallCellByValue(map[y][x])) {
                    var m = new THREE.Mesh(wallGeo, isXrayVisual ? xrayMat : wallMat);
                    m.position.set(px, 50, pz); scene.add(m);
                    if (isXrayVisual) {
                        var wire = new THREE.LineSegments(new THREE.EdgesGeometry(wallGeo), new THREE.LineBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.6 }));
                        wire.position.set(px, 50, pz); scene.add(wire);
                    }
                }
                if (map[y][x] === "D") camera.position.set(px, 50, pz);
                if (map[y][x] === "F") fireSourcePosition.set(px, 50, pz);
                if (map[y][x] === "A") {
                    var exit = new THREE.Mesh(new THREE.BoxGeometry(20, 100, 20), new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.6 }));
                    exit.position.set(px, 50, pz); scene.add(exit);
                    if (isXrayVisual) { var lbl = createTextSprite("EXIT"); lbl.position.set(px, 70, pz); lbl.material.depthTest = false; scene.add(lbl); }
                }
            }
        }
        scene.add(new THREE.HemisphereLight(0x888888, 0x111111, 1.2));
        scene.fog.density = 0.0005; 
        drawMiniMapStatic(); initFireEffects(); 
    }

    function mainLoop() { if (running) { update(); renderer.render(scene, camera); requestAnimationFrame(mainLoop); } }
    
    function loadLevel(l) {
        var ajax = new XMLHttpRequest(); ajax.open("GET", "assets/maps/maze3d-" + l + ".json", true);
        ajax.onreadystatechange = function() { 
            if (ajax.readyState == 4) { map = JSON.parse(ajax.responseText); initializeScene(); running = true; mainLoop(); } 
        };
        ajax.send(null);
    }

    function setupPointerLock() {
        var el = renderer.domElement; el.onclick = () => { if(running) el.requestPointerLock(); };
        document.addEventListener('mousemove', (e) => { 
            if (document.pointerLockElement === el && running) camera.rotation.y -= e.movementX * _mouseSensitivity; 
        });
    }

    function drawMiniMapStatic() {
        var mm = $("minimap"), o = $("objects"); if (!mm || map.length === 0) return;
        mapScale = calculateMapScale(); 
        mm.width = o.width = map[0].length * mapScale; mm.height = o.height = map.length * mapScale;
        var ctx = mm.getContext("2d");
        for (var y=0; y<map.length; y++) {
            for (var x=0; x<map[0].length; x++) {
                ctx.fillStyle = (map[y][x] === 'A') ? "#2ecc71" : (isWallCellByValue(map[y][x]) ? "#333" : "#eee");
                ctx.fillRect(x*mapScale, y*mapScale, mapScale, mapScale);
            }
        }
    }

    /**
     * 已修改：将小地图的圆点改为“箭头”形状并增加“视锥”扇形。
     * 仅修改绘图逻辑，不改动其他功能。
     */
    function updateMiniMapOverlay() {
        var o = $("objects"); if (!o || experimentMode !== 'minimap' || map.length === 0) return;
        var ctx = o.getContext("2d"); ctx.clearRect(0, 0, o.width, o.height);
        var pW = map[0].length * 100;
        var pH = map.length * 100;

        // 计算玩家在小地图上的像素坐标
        var tx = ((camera.position.x + pW/2) / 100) * mapScale;
        var ty = ((camera.position.z + pH/2) / 100) * mapScale;

        ctx.save();
        ctx.translate(tx, ty);
        // Three.js 的旋转 (Y轴) 与 Canvas 的旋转方向映射
        ctx.rotate(-camera.rotation.y);

        // --- 1. 绘制视锥 (扇形) ---
        ctx.fillStyle = "rgba(0, 240, 255, 0.2)"; // 半透明青色视角
        ctx.beginPath();
        ctx.moveTo(0, 0);
        // 绘制一个 60 度的扇形，半径为网格大小的 2 倍
        ctx.arc(0, 0, mapScale * 2, -Math.PI/2 - Math.PI/6, -Math.PI/2 + Math.PI/6);
        ctx.closePath();
        ctx.fill();

        // --- 2. 绘制箭头 (三角形) ---
        ctx.fillStyle = "#00f0ff"; // 青色箭头
        ctx.beginPath();
        // 箭头指向正上方 (-Y方向，对应 3D 中的 -Z 向前)
        ctx.moveTo(0, -mapScale * 0.6);             // 顶点
        ctx.lineTo(-mapScale * 0.4, mapScale * 0.4); // 左底角
        ctx.lineTo(mapScale * 0.4, mapScale * 0.4);  // 右底角
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    function configureUIForMode(m) { $("hud-right").style.display = (m === 'minimap') ? 'flex' : 'none'; }
    
    function setupMinimapTracking() {
        $("objects").addEventListener('mousemove', (e) => {
            var r = $("objects").getBoundingClientRect();
            var gx = Math.floor((e.clientX - r.left) / mapScale), gy = Math.floor((e.clientY - r.top) / mapScale);
            if (gy >= 0 && gy < map.length && gx >= 0 && gx < map[0].length) minimapLogs.hovers[`${gx},${gy}`] = (minimapLogs.hovers[`${gx},${gy}`] || 0) + 1;
        });
    }

    window.downloadMazeData = function() {
        var a = document.createElement('a'); 
        a.href = URL.createObjectURL(new Blob([JSON.stringify({ masterLogs: StudyControl.masterLogs }, null, 2)], {type : 'application/json'}));
        a.download = `backup_${Date.now()}.json`; a.click();
    };
})();