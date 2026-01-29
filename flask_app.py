# -*- coding: utf-8 -*-
"""
Maze Experiment Backend - 安全增强版
用于 PythonAnywhere 部署
"""

from flask import Flask, request, jsonify, send_file, abort
from flask_cors import CORS
from functools import wraps
import json
import os
import time
import hashlib
import secrets
from datetime import datetime

app = Flask(__name__)

# ============================================================
# 配置区域 - 已为 kokofish 配置好
# ============================================================

# 数据保存目录
# DATA_FOLDER = 'experiment_data'
# ============================================================
# 配置区域 - 已修改为自动适应
# ============================================================

# 智能判断路径：如果是在 PythonAnywhere 服务器上，使用绝对路径；否则使用本地相对路径
if '/home/kokofish' in os.getcwd():
    # 云端环境 (PythonAnywhere)
    DATA_FOLDER = '/home/kokofish/experiment_data'
else:
    # 本地环境 (你的电脑)
    DATA_FOLDER = 'experiment_data'

# ============================================================

# 允许的前端域名
ALLOWED_ORIGINS = [
    'http://localhost',
    'http://localhost:8080',
    'http://127.0.0.1',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:8080',
    'https://wweichen99.github.io',
]

# 管理员密钥 - 用于下载数据
ADMIN_SECRET_KEY = 'thefateofophilia'

# 数据大小限制 (字节) - 防止恶意大文件
MAX_DATA_SIZE = 5 * 1024 * 1024  # 5MB

# 有效的 User ID 范围
VALID_USER_IDS = list(range(1, 101))  # 1-100

# ============================================================
# CORS 配置 - 跨域请求安全设置
# ============================================================

CORS(app, 
     origins=ALLOWED_ORIGINS,
     methods=['GET', 'POST'],
     allow_headers=['Content-Type', 'X-Admin-Key'])

# ============================================================
# 安全辅助函数
# ============================================================

def require_admin_key(f):
    """装饰器：验证管理员密钥"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin_key = request.headers.get('X-Admin-Key')
        if not admin_key or admin_key != ADMIN_SECRET_KEY:
            abort(403, description='Invalid admin key')
        return f(*args, **kwargs)
    return decorated_function


def validate_experiment_data(data):
    """验证实验数据格式"""
    errors = []
    
    # 检查必需字段
    if 'userId' not in data:
        errors.append('Missing userId')
    elif data['userId'] not in VALID_USER_IDS:
        errors.append(f'Invalid userId: must be between 1 and {max(VALID_USER_IDS)}')
    
    if 'timestamp' not in data:
        errors.append('Missing timestamp')
    
    if 'allSessions' not in data:
        errors.append('Missing allSessions')
    elif not isinstance(data['allSessions'], list):
        errors.append('allSessions must be an array')
    
    return errors


def sanitize_filename(user_id):
    """生成安全的文件名"""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    # 确保 user_id 是整数，防止路径注入
    safe_user_id = int(user_id)
    return f"User_{safe_user_id}_{timestamp}.json"


def get_client_info():
    """获取客户端信息（用于日志）"""
    return {
        'ip': request.remote_addr,
        'user_agent': request.headers.get('User-Agent', 'unknown')[:200],
        'origin': request.headers.get('Origin', 'unknown'),
        'time': datetime.now().isoformat()
    }

# ============================================================
# API 路由
# ============================================================

@app.route('/')
def index():
    """首页 - 确认服务运行"""
    return jsonify({
        'status': 'ok',
        'service': 'Maze Experiment Backend',
        'version': '1.0.0',
        'time': datetime.now().isoformat()
    })


@app.route('/ping', methods=['GET'])
def ping():
    """健康检查端点"""
    return jsonify({'status': 'ok', 'pong': True})


@app.route('/save_data', methods=['POST'])
def save_data():
    """
    保存实验数据
    
    请求格式:
    POST /save_data
    Content-Type: application/json
    Body: { userId: 1, timestamp: "...", allSessions: [...] }
    """
    try:
        # 1. 检查请求大小
        content_length = request.content_length or 0
        if content_length > MAX_DATA_SIZE:
            return jsonify({
                'status': 'error',
                'message': f'Data too large. Max size: {MAX_DATA_SIZE // 1024}KB'
            }), 413
        
        # 2. 解析 JSON
        data = request.get_json()
        if not data:
            return jsonify({
                'status': 'error',
                'message': 'Invalid JSON data'
            }), 400
        
        # 3. 验证数据格式
        validation_errors = validate_experiment_data(data)
        if validation_errors:
            return jsonify({
                'status': 'error',
                'message': 'Validation failed',
                'errors': validation_errors
            }), 400
        
        # 4. 确保目录存在
        if not os.path.exists(DATA_FOLDER):
            os.makedirs(DATA_FOLDER, mode=0o755)
        
        # 5. 生成安全文件名
        filename = sanitize_filename(data['userId'])
        filepath = os.path.join(DATA_FOLDER, filename)
        
        # 6. 添加服务器端元数据
        data['_server_metadata'] = {
            'received_at': datetime.now().isoformat(),
            'client_ip_hash': hashlib.sha256(request.remote_addr.encode()).hexdigest()[:16],
            'filename': filename
        }
        
        # 7. 写入文件
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        
        # 8. 记录日志
        log_entry = {
            'action': 'save_data',
            'user_id': data['userId'],
            'filename': filename,
            'size_bytes': content_length,
            'client': get_client_info()
        }
        app.logger.info(f"Data saved: {json.dumps(log_entry)}")
        
        return jsonify({
            'status': 'success',
            'message': f'Data saved successfully',
            'filename': filename
        }), 200
        
    except json.JSONDecodeError:
        return jsonify({
            'status': 'error',
            'message': 'Invalid JSON format'
        }), 400
    except Exception as e:
        app.logger.error(f"Save error: {str(e)}")
        return jsonify({
            'status': 'error',
            'message': 'Server error occurred'
        }), 500


@app.route('/admin/list', methods=['GET'])
@require_admin_key
def admin_list_files():
    """
    [管理员] 列出所有数据文件
    
    请求格式:
    GET /admin/list
    Headers: X-Admin-Key: your_secret_key
    """
    try:
        if not os.path.exists(DATA_FOLDER):
            return jsonify({'status': 'ok', 'files': [], 'count': 0})
        
        files = []
        for filename in os.listdir(DATA_FOLDER):
            if filename.endswith('.json'):
                filepath = os.path.join(DATA_FOLDER, filename)
                stat = os.stat(filepath)
                files.append({
                    'filename': filename,
                    'size_bytes': stat.st_size,
                    'modified': datetime.fromtimestamp(stat.st_mtime).isoformat()
                })
        
        # 按修改时间倒序
        files.sort(key=lambda x: x['modified'], reverse=True)
        
        return jsonify({
            'status': 'ok',
            'files': files,
            'count': len(files)
        })
        
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/admin/download/<filename>', methods=['GET'])
@require_admin_key
def admin_download_file(filename):
    """
    [管理员] 下载单个数据文件
    
    请求格式:
    GET /admin/download/User_1_20240101_120000.json
    Headers: X-Admin-Key: your_secret_key
    """
    try:
        # 安全检查：防止路径遍历攻击
        if '..' in filename or '/' in filename or '\\' in filename:
            abort(400, description='Invalid filename')
        
        if not filename.endswith('.json'):
            abort(400, description='Invalid file type')
        
        filepath = os.path.join(DATA_FOLDER, filename)
        
        if not os.path.exists(filepath):
            abort(404, description='File not found')
        
        return send_file(filepath, as_attachment=True)
        
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/admin/download_all', methods=['GET'])
@require_admin_key
def admin_download_all():
    """
    [管理员] 下载所有数据（合并为单个 JSON）
    
    请求格式:
    GET /admin/download_all
    Headers: X-Admin-Key: your_secret_key
    """
    try:
        if not os.path.exists(DATA_FOLDER):
            return jsonify({'status': 'error', 'message': 'No data folder'}), 404
        
        all_data = []
        for filename in os.listdir(DATA_FOLDER):
            if filename.endswith('.json'):
                filepath = os.path.join(DATA_FOLDER, filename)
                with open(filepath, 'r', encoding='utf-8') as f:
                    file_data = json.load(f)
                    file_data['_source_file'] = filename
                    all_data.append(file_data)
        
        # 按 userId 排序
        all_data.sort(key=lambda x: x.get('userId', 0))
        
        # 创建临时合并文件
        merged_filename = f"all_experiment_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        merged_filepath = os.path.join(DATA_FOLDER, merged_filename)
        
        with open(merged_filepath, 'w', encoding='utf-8') as f:
            json.dump({
                'exported_at': datetime.now().isoformat(),
                'total_participants': len(all_data),
                'data': all_data
            }, f, ensure_ascii=False, indent=2)
        
        return send_file(merged_filepath, as_attachment=True)
        
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/admin/stats', methods=['GET'])
@require_admin_key
def admin_stats():
    """
    [管理员] 获取数据统计
    
    请求格式:
    GET /admin/stats
    Headers: X-Admin-Key: your_secret_key
    """
    try:
        if not os.path.exists(DATA_FOLDER):
            return jsonify({
                'status': 'ok',
                'total_files': 0,
                'total_size_kb': 0,
                'user_ids': []
            })
        
        total_size = 0
        user_ids = set()
        
        for filename in os.listdir(DATA_FOLDER):
            if filename.endswith('.json') and filename.startswith('User_'):
                filepath = os.path.join(DATA_FOLDER, filename)
                total_size += os.path.getsize(filepath)
                # 提取 user_id
                parts = filename.split('_')
                if len(parts) >= 2:
                    try:
                        user_ids.add(int(parts[1]))
                    except ValueError:
                        pass
        
        return jsonify({
            'status': 'ok',
            'total_files': len([f for f in os.listdir(DATA_FOLDER) if f.endswith('.json')]),
            'total_size_kb': round(total_size / 1024, 2),
            'unique_users': len(user_ids),
            'user_ids': sorted(list(user_ids))
        })
        
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ============================================================
# 错误处理
# ============================================================

@app.errorhandler(400)
def bad_request(e):
    return jsonify({'status': 'error', 'message': str(e.description)}), 400

@app.errorhandler(403)
def forbidden(e):
    return jsonify({'status': 'error', 'message': 'Access denied'}), 403

@app.errorhandler(404)
def not_found(e):
    return jsonify({'status': 'error', 'message': 'Not found'}), 404

@app.errorhandler(413)
def too_large(e):
    return jsonify({'status': 'error', 'message': 'Data too large'}), 413

@app.errorhandler(500)
def server_error(e):
    return jsonify({'status': 'error', 'message': 'Internal server error'}), 500


# ============================================================
# 本地测试用
# ============================================================

if __name__ == '__main__':
    # 仅用于本地测试，PythonAnywhere 上不需要这个
    print("Starting local test server...")
    print(f"Data folder: {DATA_FOLDER}")
    app.run(debug=True, port=5000)