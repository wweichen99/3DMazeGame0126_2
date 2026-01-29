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
    var fireSystem, smokeSystem, fireLight; // [Modified] Added fireLight
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
        // 重置键盘状态，防止自动移动
        _keys = { w: false, a: false, s: false, d: false };
        // 释放指针锁定
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
        
        // 确保按钮显示（因为 finishExperiment 可能会隐藏它）
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


// [MODIFIED] Hybrid Save: Cloud Upload + Local Download + localStorage Backup
    function finishExperiment() {
        // 1. 退出指针锁定
        if (document.pointerLockElement) document.exitPointerLock();

        // 2. 显示结束画面
        var transitionScreen = $('transition-screen');
        transitionScreen.style.display = 'flex';
        
        // 3. 更新提示文字
        $('transition-title').innerText = "EXPERIMENT COMPLETE";
        $('transition-msg').innerText = "Saving data...";
        $('transition-msg').style.color = "white";
        
        // 隐藏按钮
        var btn = transitionScreen.querySelector('button');
        if (btn) btn.style.display = 'none';

        // 4. 准备数据
        var finalBlob = {
            userId: StudyControl.userId,
            timestamp: new Date().toISOString(),
            allSessions: StudyControl.masterLogs
        };
        var jsonString = JSON.stringify(finalBlob, null, 2);

        // ============================================================
        // [重要] 第一步：立即备份到 localStorage（防止任何情况下数据丢失）
        // ============================================================
        saveToLocalStorage(jsonString);

        // ============================================================
        // 配置区域：请在这里填入你的后端 API 地址
        // 如果你还没有服务器，可以先保留为空字符串，代码会自动转为本地下载
        //var CLOUD_API_URL = "https://kokofish.pythonanywhere.com/save_data"; // 例如: "https://api.yourdomain.com/upload"
        // ============================================================
        // ============================================================
        // 自动判断环境配置 API 地址
        // ============================================================
        
        var CLOUD_API_URL = "";
        
        // 获取当前浏览器地址栏的域名
        var currentHost = window.location.hostname;

        if (currentHost === "localhost" || currentHost === "127.0.0.1") {
            // --- 场景 A：本地调试 (Live Server) ---
            // 此时前端在 localhost:5500，后端在 localhost:5000
            console.log("检测到本地环境，连接本地后端...");
            CLOUD_API_URL = "http://127.0.0.1:5000/save_data"; 
        } else {
            // --- 场景 B：正式实验 (GitHub Pages) ---
            // 此时前端在 wweichen99.github.io，后端在 PythonAnywhere
            console.log("检测到线上环境，连接云端后端...");
            

            CLOUD_API_URL = "https://kokofish.eu.pythonanywhere.com/save_data"; 
        }

        // ============================================================

        if (!CLOUD_API_URL) {
            // 如果没有配置 URL，直接进行本地下载
            console.warn("No Cloud API URL configured. Falling back to local download.");
            $('transition-msg').innerText = "Downloading data...";
            performLocalDownload(jsonString);
            return;
        }

        // 5. 尝试上传到云端
        $('transition-msg').innerText = "Syncing data to cloud...";
        
        fetch(CLOUD_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: jsonString
        })
        .then(function(response) {
            if (response.ok) {
                // --- 上传成功 ---
                $('transition-msg').innerText = "✓ Data successfully saved to Cloud!";
                $('transition-msg').style.color = "#2ecc71"; // 绿色
                console.log("Cloud upload successful.");
                
                // 云端成功后，也执行本地下载作为额外备份
                setTimeout(function() {
                    performLocalDownload(jsonString, true); // silent mode
                }, 500);
            } else {
                // --- 服务器报错 ---
                throw new Error("Server error: " + response.status);
            }
        })
        .catch(function(error) {
            // --- 上传失败 (网络错误或无服务器) ---
            console.error("Cloud upload failed:", error);
            $('transition-msg').innerText = "Cloud unavailable. Downloading locally...";
            $('transition-msg').style.color = "#e67e22"; // 橙色警告
            
            // 延迟执行本地下载作为备份
            setTimeout(function() {
                performLocalDownload(jsonString);
            }, 800);
        });
    }

    // ============================================================
    // localStorage 备份功能
    // ============================================================
    
    /**
     * 保存数据到 localStorage（作为最后防线）
     */
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

    /**
     * 从 localStorage 恢复数据（在浏览器控制台调用）
     * 用法: recoverBackupData(2)  // 恢复用户2的数据
     */
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
            console.log('[Recovery] No backup found for key:', key);
        }
    };

    /**
     * 列出所有备份数据（在浏览器控制台调用）
     * 用法: listBackups()
     */
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
        
        if (backups.length === 0) {
            console.log('No backup data found in localStorage');
        } else {
            console.log('=== Found ' + backups.length + ' backup(s) ===');
            backups.forEach(function(b) {
                console.log('  User ' + b.userId + ' - Saved at: ' + b.time);
            });
            console.log('Use recoverBackupData(userId) to download a backup');
        }
        return backups;
    };

    /**
     * 清除指定用户的备份数据
     * 用法: clearBackup(2)
     */
    window.clearBackup = function(userId) {
        var key = 'experiment_backup_user_' + userId;
        localStorage.removeItem(key);
        localStorage.removeItem(key + '_time');
        console.log('[Backup] Cleared backup for user:', userId);
    };

    // ============================================================
    // 本地下载功能（增强版）
    // ============================================================
    
    /**
     * 执行本地下载
     * @param {string} dataString - JSON 数据字符串
     * @param {boolean} silent - 是否静默模式（不更新 UI）
     * @param {string} customFileName - 自定义文件名（可选）
     */
    function performLocalDownload(dataString, silent, customFileName) {
        var fileName = customFileName || 'User_' + StudyControl.userId + '_FinalData_' + Date.now() + '.json';
        
        try {
            var blob = new Blob([dataString], {type : 'application/json'});
            var url = URL.createObjectURL(blob);
            
            // 创建隐藏的下载链接
            var a = document.createElement('a');
            a.style.display = 'none';
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            
            // 触发下载
            a.click();
            
            // 清理资源
            setTimeout(function() {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);

            console.log('[Download] File downloaded:', fileName);

            // 更新界面提示（非静默模式）
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
                
                // 显示手动重试按钮
                var btn = $('transition-screen').querySelector('button');
                if (btn) {
                    btn.style.display = 'inline-block';
                    btn.innerText = "RETRY DOWNLOAD";
                    btn.onclick = function() { performLocalDownload(dataString, false, fileName); };
                }
                
                // 显示备份恢复提示
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
        // 当窗口失去焦点时重置所有按键状态
        window.addEventListener("blur", () => {
            _keys = { w: false, a: false, s: false, d: false };
        });
    }

    // [Modified] Enhanced initFireEffects with lighting and better particles
    function initFireEffects() {
        if (!fireEnabled) return;
        fireRadius = 0; 
        var tex = createParticleTexture();
        
        // 1. Fire Particles (Sparks)
        var fireGeo = new THREE.Geometry();
        for (var i = 0; i < fireParticles; i++) {
             // Random start position around center
             var p = fireSourcePosition.clone();
             p.x += (Math.random() - 0.5) * 20;
             p.z += (Math.random() - 0.5) * 20;
             p.y += Math.random() * 50;
             fireGeo.vertices.push(p);
        }
        fireSystem = new THREE.Points(fireGeo, new THREE.PointsMaterial({ 
            map: tex, 
            color: 0xffaa00, // Richer Orange
            size: 35, 
            transparent: true, 
            opacity: 0.8, 
            blending: THREE.AdditiveBlending, 
            depthWrite: false 
        }));
        scene.add(fireSystem);

        // 2. Smoke Particles
        var smokeGeo = new THREE.Geometry();
        for (var i = 0; i < smokeParticles; i++) {
            // Distributed widely
            smokeGeo.vertices.push(new THREE.Vector3(
                (Math.random()-0.5)*3500, 
                Math.random()*200, 
                (Math.random()-0.5)*3500
            ));
        }
        smokeSystem = new THREE.Points(smokeGeo, new THREE.PointsMaterial({ 
            map: tex, 
            color: (experimentMode === 'xray') ? 0x444444 : 0x222222, 
            size: (experimentMode === 'xray') ? 40 : 80, 
            transparent: true, 
            opacity: 0.2, 
            depthWrite: false 
        }));
        scene.add(smokeSystem);

        // 3. [NEW] Dynamic Fire Light for Immersion
        fireLight = new THREE.PointLight(0xff6600, 1.5, 600);
        fireLight.position.copy(fireSourcePosition);
        fireLight.position.y += 50; 
        scene.add(fireLight);
    }

    // [Modified] Enhanced updateEffects for dynamic lighting and particle movement
    function updateEffects() {
        if (!fireEnabled || !running) return;
        
        fireRadius += fireSpreadRate;

        // Update Fire Particles
        if (fireSystem) {
            fireSystem.geometry.vertices.forEach(v => {
                // Move up faster and jitter
                v.y += 2 + Math.random() * 2;
                v.x += (Math.random() - 0.5) * 2; 
                v.z += (Math.random() - 0.5) * 2;

                var dist = Math.sqrt(Math.pow(v.x - fireSourcePosition.x, 2) + Math.pow(v.z - fireSourcePosition.z, 2));

                // Respawn logic
                if (v.y > 150 || dist > fireRadius) {
                    v.y = Math.random() * 10;
                    var a = Math.random() * Math.PI * 2;
                    var rd = Math.random() * fireRadius; // Uniform spread within current radius
                    v.x = fireSourcePosition.x + Math.cos(a) * rd; 
                    v.z = fireSourcePosition.z + Math.sin(a) * rd;
                }
            });
            fireSystem.geometry.verticesNeedUpdate = true;
        }

        // Update Smoke
        if (smokeSystem) {
            smokeSystem.geometry.vertices.forEach(v => { 
                v.y += 0.5; 
                if (v.y > 250) v.y = 0; 
            });
            smokeSystem.geometry.verticesNeedUpdate = true;
        }

        // Update Light Flickering [NEW]
        if (fireLight) {
            fireLight.intensity = 1.0 + Math.random() * 1.5; // Flicker intensity
            fireLight.position.x = fireSourcePosition.x + (Math.random() - 0.5) * 5; // Jitter position
            fireLight.position.z = fireSourcePosition.z + (Math.random() - 0.5) * 5;
        }
        
        // Fog logic
        var maxFog = (experimentMode === 'xray') ? 0.004 : 0.015;
        if (scene.fog.density < maxFog) scene.fog.density += 0.000008;

        // Collision logic
        if (fireRadius > fireGraceRadius && camera.position.distanceTo(fireSourcePosition) < fireRadius) {
            running = false;
            _keys = { w: false, a: false, s: false, d: false };
            if (document.pointerLockElement) document.exitPointerLock();
            setTimeout(function() {
                alert("Fire consumed you!"); 
                loadLevel(StudyControl.mapSequence[StudyControl.phase]);
            }, 50);
        }
    }
    
    // 检查位置是否在火焰范围内
    function isInFireZone(x, z) {
        if (!fireEnabled || fireRadius <= fireGraceRadius) return false;
        var dist = Math.sqrt(Math.pow(x - fireSourcePosition.x, 2) + Math.pow(z - fireSourcePosition.z, 2));
        return dist < fireRadius;
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
            // 首先检查是否在火焰区域内
            if (isInFireZone(newX, newZ)) {
                return true; // 火焰区域视为障碍物
            }
            
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
        // 确保加载新关卡前状态完全重置
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

    /**
     * 已修改：在终点绿色方块上增加 "E" 字母标识
     */
    function drawMiniMapStatic() {
        var mm = $("minimap"), o = $("objects"); if (!mm || map.length === 0) return;
        mapScale = calculateMapScale(); 
        mm.width = o.width = map[0].length * mapScale; mm.height = o.height = map.length * mapScale;
        var ctx = mm.getContext("2d");
        for (var y=0; y<map.length; y++) {
            for (var x=0; x<map[0].length; x++) {
                ctx.fillStyle = (map[y][x] === 'A') ? "#2ecc71" : (isWallCellByValue(map[y][x]) ? "#333" : "#eee");
                ctx.fillRect(x*mapScale, y*mapScale, mapScale, mapScale);
                
                // --- 新增：绘制终点字母标识 ---
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

    /**
     * 已保留：绘制带视锥和箭头的玩家位置
     */
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

        // 视锥
        ctx.fillStyle = "rgba(0, 240, 255, 0.2)";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, mapScale * 2, -Math.PI/2 - Math.PI/6, -Math.PI/2 + Math.PI/6);
        ctx.closePath();
        ctx.fill();

        // 箭头
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