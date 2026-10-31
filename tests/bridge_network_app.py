"""TEST ONLY fault-injection ASGI host for production bridge network checks.

The API/store are production code. This middleware supplies deliberately hostile
HTTP responses and headers; it is never imported by backend.main.
"""
import os
from pathlib import Path
from fastapi.responses import JSONResponse, Response, RedirectResponse
from backend.main import app

mode_path = Path(os.environ['MOODLE_HELPER_BRIDGE_TEST_MODE'])


@app.middleware('http')
async def inject_test_fault(request, call_next):
    if request.url.path == '/forbidden-target':
        mode_path.with_suffix('.followed').write_text('redirect followed')
        return Response('private-exception-token-sentinel')
    mode = mode_path.read_text() if mode_path.exists() else ''
    if request.url.path == '/api/snapshot' and request.method == 'GET':
        if mode == 'redirect':
            return RedirectResponse('http://127.0.0.1:8000/forbidden-target')
        if mode == 'html':
            return Response('<html>password-sentinel-cookie-sentinel</html>')
        if mode == 'private-error':
            return JSONResponse({'message': 'private-exception-token-sentinel'}, status_code=500)
        if mode == 'extra':
            snapshot = request.app.state.service.load()
            return JSONResponse({**snapshot, 'headers': {'cookie': 'cookie-sentinel'}})
    response = await call_next(request)
    response.headers['Set-Cookie'] = 'cookie-sentinel; HttpOnly'
    response.headers['X-Private'] = 'password-sentinel-token-sentinel'
    return response
