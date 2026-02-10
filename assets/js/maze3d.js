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

    // === Fire and Smoke System [Continuous Flow] ===
    var fireSystem, smokeSystem, sparkSystem; 
    var fireLights = []; 
    var fireParticles = 1600; // 粒子数量充足，保证密度
    var sparkParticles = 600; 
    var smokeParticles = 1000;
    var fireSources = []; 
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
        _keys = { w: false, a: false, s: false, d: false };
        if (document.pointerLockElement) document.exitPointerLock();
        
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
        
        var btn = $('transition-screen').querySelector('button');
        if (btn) btn.style.display = 'inline-block';
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
        if (document.pointerLockElement) document.exitPointerLock();
        var transitionScreen = $('transition-screen');
        transitionScreen.style.display = 'flex';
        $('transition-title').innerText = "EXPERIMENT COMPLETE";
        $('transition-msg').innerText = "Saving data...";
        $('transition-msg').style.color = "white";
        
        var btn = transitionScreen.querySelector('button');
        if (btn) btn.style.display = 'none';

        var finalBlob = {
            userId: StudyControl.userId,
            timestamp: new Date().toISOString(),
            allSessions: StudyControl.masterLogs
        };
        var jsonString = JSON.stringify(finalBlob, null, 2);

        saveToLocalStorage(jsonString);

        var CLOUD_API_URL = "";
        var currentHost = window.location.hostname;
        if (currentHost === "localhost" || currentHost === "127.0.0.1") {
            console.log("检测到本地环境，连接本地后端...");
            CLOUD_API_URL = "http://127.0.0.1:5000/save_data"; 
        } else {
            console.log("检测到线上环境，连接云端后端...");
            CLOUD_API_URL = "https://kokofish.eu.pythonanywhere.com/save_data"; 
        }

        if (!CLOUD_API_URL) {
            console.warn("No Cloud API URL configured. Falling back to local download.");
            $('transition-msg').innerText = "Downloading data...";
            performLocalDownload(jsonString);
            return;
        }

        $('transition-msg').innerText = "Syncing data to cloud...";
        fetch(CLOUD_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: jsonString
        })
        .then(function(response) {
            if (response.ok) {
                $('transition-msg').innerText = "✓ Data successfully saved to Cloud!";
                $('transition-msg').style.color = "#2ecc71";
                console.log("Cloud upload successful.");
                setTimeout(function() { performLocalDownload(jsonString, true); }, 500);
            } else {
                throw new Error("Server error: " + response.status);
            }
        })
        .catch(function(error) {
            console.error("Cloud upload failed:", error);
            $('transition-msg').innerText = "Cloud unavailable. Downloading locally...";
            $('transition-msg').style.color = "#e67e22";
            setTimeout(function() { performLocalDownload(jsonString); }, 800);
        });
    }

    function saveToLocalStorage(dataString) {
        try {
            var key = 'experiment_backup_user_' + StudyControl.userId;
            localStorage.setItem(key, dataString);
            localStorage.setItem(key + '_time', new Date().toISOString());
            console.log('[Backup] Data saved to localStorage with key:', key);
        } catch (e) {
            console.warn('[Backup] localStorage save failed:', e);
        }
    }

    window.recoverBackupData = function(userId) {
        var key = 'experiment_backup_user_' + (userId || StudyControl.userId || 'unknown');
        var backup = localStorage.getItem(key);
        var backupTime = localStorage.getItem(key + '_time');
        
        if (backup) {
            console.log('[Recovery] Found backup from:', backupTime);
            performLocalDownload(backup, false, 'Recovered_User_' + userId + '_Data.json');
            alert('备份数据已恢复下载！\n备份时间: ' + backupTime);
        } else {
            alert('未找到用户 ' + userId + ' 的备份数据');
        }
    };

    window.listBackups = function() {
        var backups = [];
        for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key && key.startsWith('experiment_backup_user_') && !key.endsWith('_time')) {
                var timeKey = key + '_time';
                var time = localStorage.getItem(timeKey) || 'unknown';
                var usrId = key.replace('experiment_backup_user_', '');
                backups.push({ userId: usrId, time: time, key: key });
            }
        }
        if (backups.length === 0) { console.log('No backup data found in localStorage'); } 
        else {
            console.log('=== Found ' + backups.length + ' backup(s) ===');
            backups.forEach(function(b) { console.log('  User ' + b.userId + ' - Saved at: ' + b.time); });
        }
        return backups;
    };

    window.clearBackup = function(userId) {
        var key = 'experiment_backup_user_' + userId;
        localStorage.removeItem(key);
        localStorage.removeItem(key + '_time');
        console.log('[Backup] Cleared backup for user:', userId);
    };

    function performLocalDownload(dataString, silent, customFileName) {
        var fileName = customFileName || 'User_' + StudyControl.userId + '_FinalData_' + Date.now() + '.json';
        try {
            var blob = new Blob([dataString], {type : 'application/json'});
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.style.display = 'none'; a.href = url; a.download = fileName;
            document.body.appendChild(a); a.click();
            setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
            console.log('[Download] File downloaded:', fileName);
            if (!silent) {
                var msgEl = $('transition-msg');
                if (msgEl && !msgEl.innerText.includes("Cloud")) {
                    msgEl.innerText = "✓ Data saved to Downloads folder";
                    msgEl.style.color = "#2ecc71";
                }
            }
        } catch (e) {
            console.error("Local download failed:", e);
            if (!silent) {
                $('transition-msg').innerText = "Download failed! Data is saved in browser backup.";
                $('transition-msg').style.color = "#e74c3c";
                var btn = $('transition-screen').querySelector('button');
                if (btn) {
                    btn.style.display = 'inline-block';
                    btn.innerText = "RETRY DOWNLOAD";
                    btn.onclick = function() { performLocalDownload(dataString, false, fileName); };
                }
                var msgEl = $('transition-msg');
                msgEl.innerHTML += '<br><small style="color:#888">Backup saved. Use recoverBackupData(' + StudyControl.userId + ') in console to recover.</small>';
            }
        }
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

    var webgazerInitialized = false;
    function initWebGazer() {
        if (typeof webgazer === 'undefined') {
            console.error("WebGazer.js 未加载");
            alert("眼动追踪库未加载，请刷新页面。");
            return;
        }
        if (webgazerInitialized) return;
        try { if (webgazer.isReady && webgazer.isReady()) webgazer.end(); } catch(e) {}
        try {
            webgazer.clearData();
            for (var key in localStorage) { if (key.startsWith('webgazer')) localStorage.removeItem(key); }
        } catch(e) {}
        try {
            webgazer.saveDataAcrossSessions(false);
            webgazer.setRegression('ridge');
        } catch(e) {}

        webgazer.setGazeListener(function(data, elapsedTime) {
            if (data && running) {
                gazeBuffer.push({ x: data.x, y: data.y });
                if (gazeBuffer.length > GAZE_BUFFER_SIZE) gazeBuffer.shift();
                var avgX = gazeBuffer.reduce((s, p) => s + p.x, 0) / gazeBuffer.length;
                var avgY = gazeBuffer.reduce((s, p) => s + p.y, 0) / gazeBuffer.length;
                gazeLogs.push({ t: Date.now(), x: Math.round(avgX), y: Math.round(avgY) });
            }
        });

        webgazer.begin().then(function() {
            webgazerInitialized = true;
            webgazer.showVideoPreview(true).showPredictionPoints(true);
            var moveUI = setInterval(function(){
                var v = document.getElementById('webgazerVideoFeed');
                var t = document.getElementById('webgazer-target');
                if (v && t && v.parentElement !== t) {
                    t.innerHTML = '';
                    ['webgazerVideoFeed', 'webgazerVideoCanvas', 'webgazerFaceOverlay', 'webgazerFaceFeedbackBox'].forEach(function(id) {
                        var el = document.getElementById(id);
                        if(el) {
                            t.appendChild(el);
                            el.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover; transform:scaleX(-1); border-radius:12px;";
                        }
                    });
                    clearInterval(moveUI);
                }
            }, 500);
        }).catch(function(err) {
            webgazerInitialized = false;
            alert("眼动追踪启动失败: " + err.message + "\n实验将继续，但不会收集眼动数据。");
        });
    }
    
    function initializeEngine() {
        if (renderer) return; 
        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap; 

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
        window.addEventListener("keydown", (e) => { 
            if(_keys.hasOwnProperty(e.key.toLowerCase()) && running) {
                _keys[e.key.toLowerCase()] = true; 
            }
        });
        window.addEventListener("keyup", (e) => { 
            if(_keys.hasOwnProperty(e.key.toLowerCase())) {
                _keys[e.key.toLowerCase()] = false; 
            }
        });
        window.addEventListener("blur", () => {
            _keys = { w: false, a: false, s: false, d: false };
        });
    }

    // [MODIFIED] Continuous Flow Fire (Pre-warmed)
    function initFireEffects() {
        if (!fireEnabled || fireSources.length === 0) return;
        fireRadius = 0; 
        var tex = createParticleTexture();
        
        // 1. Flames (Base Fire) - 核心火焰
        var fireGeo = new THREE.Geometry();
        for (var i = 0; i < fireParticles; i++) {
             var randomSource = fireSources[Math.floor(Math.random() * fireSources.length)];
             var p = randomSource.clone();
             // [Fix] 关键点：初始 y 分布在整个火焰高度 (0~130)，形成连续火柱
             p.x += (Math.random() - 0.5) * 20;
             p.z += (Math.random() - 0.5) * 20;
             p.y += Math.random() * 130; 
             fireGeo.vertices.push(p);
        }
        fireSystem = new THREE.Points(fireGeo, new THREE.PointsMaterial({ 
            map: tex, 
            color: 0xff5500, // 深橙色
            size: 55, 
            transparent: true, 
            opacity: 0.6, 
            blending: THREE.AdditiveBlending, 
            depthWrite: false 
        }));
        scene.add(fireSystem);

        // 2. Sparks System - 飞溅火星
        var sparkGeo = new THREE.Geometry();
        for (var i = 0; i < sparkParticles; i++) {
             var randomSource = fireSources[Math.floor(Math.random() * fireSources.length)];
             var p = randomSource.clone();
             p.x += (Math.random() - 0.5) * 15; 
             p.z += (Math.random() - 0.5) * 15;
             p.y += Math.random() * 160; // 火星分布更高
             sparkGeo.vertices.push(p);
        }
        sparkSystem = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
            map: tex,
            color: 0xffcc44, // 亮黄
            size: 10, 
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        }));
        scene.add(sparkSystem);

        // 3. Smoke Particles
        var smokeGeo = new THREE.Geometry();
        for (var i = 0; i < smokeParticles; i++) {
            var randomSource = fireSources[Math.floor(Math.random() * fireSources.length)];
            var p = randomSource.clone();
            p.x += (Math.random() - 0.5) * 40;
            p.z += (Math.random() - 0.5) * 40;
            p.y += Math.random() * 250; // 烟雾分布很高
            smokeGeo.vertices.push(p);
        }
        smokeSystem = new THREE.Points(smokeGeo, new THREE.PointsMaterial({ 
            map: tex, 
            color: (experimentMode === 'xray') ? 0x444444 : 0x222222, 
            size: 90, 
            transparent: true, 
            opacity: 0.15, 
            depthWrite: false 
        }));
        scene.add(smokeSystem);

        // 4. Lights
        fireSources.forEach(function(pos) {
            var light = new THREE.PointLight(0xff7700, 1.5, 700);
            light.position.copy(pos);
            light.position.y += 40; 
            
            light.castShadow = true;
            light.shadow.bias = -0.0001; 
            light.shadow.mapSize.width = 512; 
            light.shadow.mapSize.height = 512;
            light.shadow.camera.near = 1;
            light.shadow.camera.far = 600;

            scene.add(light);
            fireLights.push(light); 
        });
    }

    // [MODIFIED] Seamless Looping
    function updateEffects() {
        if (!fireEnabled || !running || fireSources.length === 0) return;
        
        fireRadius += fireSpreadRate;
        var time = Date.now() * 0.001; 

        // 1. Flames Update
        if (fireSystem) {
            fireSystem.geometry.vertices.forEach(v => {
                v.y += 1.5 + Math.random() * 2.0; // 向上移动
                
                // 摆动
                v.x += Math.sin(time * 3 + v.y * 0.05) * 0.4;
                v.z += Math.cos(time * 2 + v.y * 0.05) * 0.4;

                // [Fix] 连续循环：超过高度后回到 0，而不是随机重生
                if (v.y > 130) {
                    var targetSource = fireSources[Math.floor(Math.random() * fireSources.length)];
                    v.y = 0; // 立即回到最底部
                    // 在底部时聚拢，防止看起来散乱
                    var a = Math.random() * 6.28;
                    var r = Math.random() * 15;
                    v.x = targetSource.x + Math.cos(a) * r; 
                    v.z = targetSource.z + Math.sin(a) * r;
                }
            });
            fireSystem.geometry.verticesNeedUpdate = true;
        }

        // 2. Sparks Update
        if (sparkSystem) {
            sparkSystem.geometry.vertices.forEach(v => {
                v.y += 3.0 + Math.random() * 3.0; 
                v.x += (Math.random() - 0.5) * 2; 
                v.z += (Math.random() - 0.5) * 2;

                if (v.y > 160) {
                    var targetSource = fireSources[Math.floor(Math.random() * fireSources.length)];
                    v.y = 0;
                    v.x = targetSource.x + (Math.random() - 0.5) * 10;
                    v.z = targetSource.z + (Math.random() - 0.5) * 10;
                }
            });
            sparkSystem.geometry.verticesNeedUpdate = true;
        }

        // 3. Smoke Update
        if (smokeSystem) {
            smokeSystem.geometry.vertices.forEach(v => { 
                v.y += 0.8 + Math.random() * 0.5; 
                v.x += Math.sin(time + v.y * 0.02) * 0.5; 
                
                if (v.y > 250) { 
                    var targetSource = fireSources[Math.floor(Math.random() * fireSources.length)];
                    v.y = 50; 
                    var a = Math.random() * 6.28;
                    var r = Math.random() * 30;
                    v.x = targetSource.x + Math.cos(a) * r;
                    v.z = targetSource.z + Math.sin(a) * r;
                }
            });
            smokeSystem.geometry.verticesNeedUpdate = true;
        }

        // 4. Lights Flicker
        fireLights.forEach(function(light, idx) {
            var sourcePos = fireSources[idx];
            var flicker = Math.sin(time * 15 + idx * 10) * 0.2 + (Math.random() - 0.5) * 0.8;
            light.intensity = 1.4 + flicker; 
            light.position.x = sourcePos.x + Math.sin(time * 8) * 2; 
            light.position.z = sourcePos.z + Math.cos(time * 8) * 2;
        });
        
        var maxFog = (experimentMode === 'xray') ? 0.004 : 0.015;
        if (scene.fog.density < maxFog) scene.fog.density += 0.000008;

        if (fireRadius > fireGraceRadius) {
            for (var i = 0; i < fireSources.length; i++) {
                if (camera.position.distanceTo(fireSources[i]) < fireRadius) {
                    running = false;
                    _keys = { w: false, a: false, s: false, d: false };
                    if (document.pointerLockElement) document.exitPointerLock();
                    setTimeout(function() {
                        alert("Fire consumed you!"); 
                        loadLevel(StudyControl.mapSequence[StudyControl.phase]);
                    }, 50);
                    break; 
                }
            }
        }
    }
    
    function isInFireZone(x, z) {
        if (!fireEnabled || fireRadius <= fireGraceRadius || fireSources.length === 0) return false;
        for (var i = 0; i < fireSources.length; i++) {
            var dist = Math.sqrt(Math.pow(x - fireSources[i].x, 2) + Math.pow(z - fireSources[i].z, 2));
            if (dist < fireRadius) return true;
        }
        return false;
    }

    function moveCamera(dir) {
        if (!running) return;
        var dx = 0, dz = 0, rot = camera.rotation.y;
        if (dir === "up") { dx = -Math.sin(rot) * 5; dz = -Math.cos(rot) * 5; }
        else if (dir === "down") { dx = Math.sin(rot) * 5; dz = Math.cos(rot) * 5; }

        var pRadius = 20; 
        var pW = map[0].length * 100, pH = map.length * 100;
        var originX = -pW / 2, originZ = -pH / 2;

        var checkCollision = function(newX, newZ) {
            if (isInFireZone(newX, newZ)) { return true; }
            var checkOffsets = [[0,0], [pRadius,0], [-pRadius,0], [0,pRadius], [0,-pRadius]];
            for (var i = 0; i < checkOffsets.length; i++) {
                var cx = newX + checkOffsets[i][0];
                var cz = newZ + checkOffsets[i][1];
                var tx = Math.floor((cx - originX) / 100);
                var ty = Math.floor((cz - originZ) / 100);
                if (ty < 0 || ty >= map.length || tx < 0 || tx >= map[0].length) return true;
                var cell = map[ty][tx];
                if (cell === "A" && running) {
                    if (i === 0) { moveToNextStep(); return false; } 
                    continue; 
                }
                if (isWallCellByValue(cell)) return true;
            }
            return false;
        };

        if (!checkCollision(camera.position.x + dx, camera.position.z)) { camera.position.x += dx; }
        if (!checkCollision(camera.position.x, camera.position.z + dz)) { camera.position.z += dz; }
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

    function initializeScene() {
        while(scene.children.length > 0) scene.remove(scene.children[0]);
        fireSources = []; fireLights = [];

        var loader = new THREE.TextureLoader();
        var pW = map[0].length * 100, pH = map.length * 100;
        cameraHelper.origin.x = -pW / 2; cameraHelper.origin.z = -pH / 2;
        
        var groundGeo = new THREE.BoxGeometry(pW, 5, pH);
        var groundMat = new THREE.MeshPhongMaterial({ map: loader.load("assets/images/textures/ground_diffuse.jpg") });
        var ground = new THREE.Mesh(groundGeo, groundMat);
        ground.translateY(1); ground.receiveShadow = true; scene.add(ground);

        var roofGeo = new THREE.BoxGeometry(pW, 5, pH);
        var roofMat = new THREE.MeshPhongMaterial({ map: loader.load("assets/images/textures/roof_diffuse.jpg") });
        var roof = new THREE.Mesh(roofGeo, roofMat);
        roof.translateY(100); roof.receiveShadow = true; scene.add(roof);
        
        var wallGeo = new THREE.BoxGeometry(100, 100, 100), wallMat = new THREE.MeshPhongMaterial({ map: loader.load("assets/images/textures/wall_diffuse.jpg") });
        var xrayMat = new THREE.MeshBasicMaterial({ color: 0x0066ff, transparent: true, opacity: 0.3, depthWrite: false });
        var isXrayVisual = (experimentMode === 'xray');

        for (var y = 0; y < map.length; y++) {
            for (var x = 0; x < map[y].length; x++) {
                var px = -pW / 2 + 100 * x + 50;
                var pz = -pH / 2 + 100 * y + 50;
                
                if (isWallCellByValue(map[y][x])) {
                    var m = new THREE.Mesh(wallGeo, isXrayVisual ? xrayMat : wallMat);
                    m.position.set(px, 50, pz); 
                    m.castShadow = true; m.receiveShadow = true;
                    scene.add(m);
                    if (isXrayVisual) {
                        var wire = new THREE.LineSegments(new THREE.EdgesGeometry(wallGeo), new THREE.LineBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.6 }));
                        wire.position.set(px, 50, pz); scene.add(wire);
                    }
                }
                if (map[y][x] === "D") camera.position.set(px, 50, pz);
                if (map[y][x] === "F") fireSources.push(new THREE.Vector3(px, 50, pz));
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
        running = false;
        _keys = { w: false, a: false, s: false, d: false };
        if (document.pointerLockElement) document.exitPointerLock();
        
        var ajax = new XMLHttpRequest(); 
        ajax.open("GET", "assets/maps/maze3d-" + l + ".json", true);
        ajax.onreadystatechange = function() { 
            if (ajax.readyState == 4) { 
                map = JSON.parse(ajax.responseText); 
                initializeScene(); 
                running = true; 
                mainLoop(); 
            } 
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
                if (map[y][x] === 'A') {
                    ctx.fillStyle = "white";
                    ctx.font = "bold " + Math.floor(mapScale * 0.75) + "px Arial";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("E", x * mapScale + mapScale / 2, y * mapScale + mapScale / 2);
                }
            }
        }
    }

    function updateMiniMapOverlay() {
        var o = $("objects"); if (!o || experimentMode !== 'minimap' || map.length === 0) return;
        var ctx = o.getContext("2d"); ctx.clearRect(0, 0, o.width, o.height);
        var pW = map[0].length * 100;
        var pH = map.length * 100;
        var tx = ((camera.position.x + pW/2) / 100) * mapScale;
        var ty = ((camera.position.z + pH/2) / 100) * mapScale;
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(-camera.rotation.y);
        ctx.fillStyle = "rgba(0, 240, 255, 0.2)";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, mapScale * 2, -Math.PI/2 - Math.PI/6, -Math.PI/2 + Math.PI/6);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#00f0ff";
        ctx.beginPath();
        ctx.moveTo(0, -mapScale * 0.6);
        ctx.lineTo(-mapScale * 0.4, mapScale * 0.4);
        ctx.lineTo(mapScale * 0.4, mapScale * 0.4);
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