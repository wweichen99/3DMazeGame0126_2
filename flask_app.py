from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import os
import time

app = Flask(__name__)
# 关键：允许跨域请求，否则你的网页游戏无法发送数据给服务器
CORS(app)

# 设置数据保存的文件夹名称
DATA_FOLDER = 'mysite/data'  # 注意：PythonAnywhere 默认路径通常在 mysite 下，或者根据实际部署调整

@app.route('/')
def hello_world():
    return 'Maze Game Backend is Running!'

@app.route('/save_data', methods=['POST'])
def save_data():
    try:
        # 1. 获取前端发来的 JSON 数据
        content = request.json
        
        # 2. 确保保存目录存在
        if not os.path.exists(DATA_FOLDER):
            os.makedirs(DATA_FOLDER)
            
        # 3. 生成文件名 (User_ID_时间戳.json)
        user_id = content.get('userId', 'unknown')
        timestamp = int(time.time())
        filename = f"User_{user_id}_{timestamp}.json"
        filepath = os.path.join(DATA_FOLDER, filename)
        
        # 4. 写入硬盘
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(content, f, ensure_ascii=False, indent=2)
            
        return jsonify({"status": "success", "message": f"Saved as {filename}"}), 200
        
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500