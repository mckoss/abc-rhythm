#!/usr/bin/env python3
"""Dev server for abc-rhythm with caching disabled.

Plain `python3 -m http.server` lets the browser cache JS, so edits don't show
up without a manual ?v= bump or a hard refresh. This sends no-store on every
response, so a normal refresh always loads the latest files during development.

Usage:  python3 serve.py [port]
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


class Server(socketserver.TCPServer):
    allow_reuse_address = True


with Server(("", PORT), NoCacheHandler) as httpd:
    print(f"abc-rhythm dev server (no-cache) on http://localhost:{PORT}")
    httpd.serve_forever()
