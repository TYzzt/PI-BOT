"""Read T-AGNET's authenticated local event stream and animate the USB buddy.

Only state names are sent to the board. Prompts, tool arguments, and tokens are
never printed or transmitted to the microcontroller.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import time
import uuid

import serial

STATES = ('idle', 'thinking', 'working', 'searching', 'waiting', 'success', 'error', 'sleeping')
WAITING = {'awaiting_review', 'awaiting_input', 'needs_replan', 'waiting_for_local_action'}
READ_TOOLS = {'read_file', 'list_files', 'search', 'search_files', 'find_files', 'git_status', 'read_tool_output'}


def detail_state(detail, terminal=False):
    task = detail.get('task', {})
    state = task.get('state')
    if state in WAITING:
        return 'waiting'
    if state in {'failed', 'interrupted'}:
        return 'error' if terminal else 'idle'
    if state in {'completed', 'cancelled', 'rejected'}:
        return 'success' if terminal and state == 'completed' else 'idle'
    run_id = task.get('activeRunId')
    tools = [t for t in detail.get('tools', []) if t.get('state') == 'running' and t.get('runId') == run_id]
    if tools:
        # Prefer actual executing tools; a queued read must not hide a write.
        names = [t.get('name', '') for t in tools]
        if any(n not in READ_TOOLS and not n.startswith('browser_') for n in names):
            return 'working'
        return 'searching'
    return 'thinking' if state in {'reading', 'planning', 'executing'} else 'idle'


class Board:
    def __init__(self, port):
        self.uart = serial.Serial(port=None, baudrate=115200, timeout=0, write_timeout=2)
        self.uart.dtr = False
        self.uart.rts = False
        self.uart.port = port
        self.uart.open()
        self.state = None

    def send(self, command):
        self.uart.write((command + '\n').encode('ascii'))

    def show(self, state):
        if state != self.state:
            self.send('STATE ' + state)
            self.state = state
            print('Buddy: ' + state, flush=True)

    def heartbeat(self):
        self.send('PING')
        # Drain board logs so UART buffers cannot grow without bound.
        output = self.uart.read(16384)
        if b'PET ready' in output and self.state:
            self.send('STATE ' + self.state)

    def close(self):
        self.uart.close()


class Bridge:
    def __init__(self, board, data_dir):
        self.board = board
        self.data_dir = Path(data_dir)
        digest = hashlib.sha256(str(self.data_dir).encode()).hexdigest()[:12]
        self.socket_path = f'/tmp/t-agnet-{os.getuid()}-{digest}/service.sock'
        self.pending = {}
        self.buffer = b''
        self.active = False
        self.hold_until = 0
        self.idle_since = time.monotonic()
        self.last_snapshot = 0
        self.conversation = None
        self.detail_inflight = False
        self.waiting = False

    def request(self, method, input_data, context=None):
        request_id = str(uuid.uuid4())
        self.pending[request_id] = (method, context, time.monotonic())
        self.sock.sendall((json.dumps({'id': request_id, 'method': method, 'input': input_data}) + '\n').encode())

    def get_detail(self, conversation, terminal=False):
        if conversation and not self.detail_inflight:
            self.detail_inflight = True
            self.request('codingGet', {'conversationId': conversation}, terminal)

    def show(self, state, hold=False):
        now = time.monotonic()
        if state not in {'idle', 'sleeping'}:
            self.idle_since = now
        elif now < self.hold_until:
            return
        if hold:
            self.hold_until = now + 5
        self.board.show(state)

    def event(self, event):
        kind = event.get('type')
        conversation = event.get('conversation_id')
        if kind == 'run.started':
            self.active = True
            self.waiting = False
            self.conversation = conversation
            self.hold_until = 0
            self.show('thinking')
        elif kind == 'message.delta':
            if self.active:
                self.show('thinking')
        elif kind in {'tool.updated', 'coding.changed'}:
            self.get_detail(conversation)
        elif kind in {'run.completed', 'run.failed', 'run.cancelled'}:
            self.active = False
            self.show({'run.completed': 'success', 'run.failed': 'error', 'run.cancelled': 'idle'}[kind], hold=True)
            # Planning completion may actually mean awaiting_review.
            self.get_detail(conversation, terminal=True)

    def packet(self, packet):
        if packet.get('ready'):
            print('T-AGNET connected (read-only event subscription)', flush=True)
            self.request('snapshot', {})
        elif 'event' in packet:
            self.event(packet['event'])
        elif packet.get('id') in self.pending:
            method, context, _ = self.pending.pop(packet['id'])
            if method == 'codingGet':
                self.detail_inflight = False
            if 'error' in packet:
                return  # Never echo service error bodies or private data.
            result = packet.get('result') or {}
            if method == 'snapshot':
                run = result.get('activeRun')
                self.active = bool(run)
                if run:
                    conversation = run.get('conversationId')
                    self.conversation = conversation
                    info = next((c for c in result.get('conversations', []) if c['id'] == conversation), {})
                    if info.get('kind') == 'coding':
                        self.get_detail(conversation)
                    else:
                        self.show('thinking')
                else:
                    if not self.waiting:
                        self.show('sleeping' if time.monotonic() - self.idle_since > 60 else 'idle')
                    # Restore pending review/input states after reconnect, without replaying old success/error.
                    latest = max(result.get('conversations', []), key=lambda c: c.get('updatedAt', 0), default={})
                    if latest.get('kind') == 'coding':
                        self.get_detail(latest['id'])
            elif method == 'codingGet':
                state = detail_state(result, bool(context))
                self.waiting = state == 'waiting'
                if state == 'idle' and time.monotonic() - self.idle_since > 60:
                    state = 'sleeping'
                self.show(state, hold=bool(context) and state in {'success', 'error'})

    def run_connected(self):
        self.pending.clear()
        self.detail_inflight = False
        self.buffer = b''
        self.hold_until = 0
        self.idle_since = time.monotonic()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as self.sock:
            self.sock.settimeout(3)
            self.sock.connect(self.socket_path)
            token = (self.data_dir / 'ipc-token').read_text()
            self.sock.sendall((json.dumps({'token': token}) + '\n').encode())
            authenticated = False
            auth_deadline = time.monotonic() + 5
            while True:
                now = time.monotonic()
                if not authenticated and now > auth_deadline:
                    raise ConnectionError('Authentication timeout')
                if authenticated and now - self.last_snapshot > 2:
                    self.request('snapshot', {})
                    self.last_snapshot = now
                    self.board.heartbeat()
                if any(now - item[2] > 15 for item in self.pending.values()):
                    raise ConnectionError('Service request timeout')
                readable, _, _ = select.select([self.sock], [], [], .2)
                if not readable:
                    continue
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise ConnectionError('Service disconnected')
                self.buffer += chunk
                if len(self.buffer) > 8_000_000:
                    raise ConnectionError('Service packet too large')
                while b'\n' in self.buffer:
                    line, self.buffer = self.buffer.split(b'\n', 1)
                    packet = json.loads(line)
                    authenticated |= bool(packet.get('ready'))
                    self.packet(packet)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', default='/dev/cu.usbmodem5B910686821')
    parser.add_argument('--data-dir', default=os.environ.get('T_AGNET_DATA_DIR', str(Path.home() / 'Library/Application Support/T-AGNET')))
    parser.add_argument('--state', choices=STATES, help='Send one state instead of following T-AGNET')
    parser.add_argument('--demo', action='store_true', help='Restore board demo cycle')
    args = parser.parse_args()
    try:
        while True:
            board = None
            try:
                board = Board(args.port)
                if args.demo:
                    board.send('DEMO')
                    return
                if args.state:
                    board.show(args.state)
                    return
                bridge = Bridge(board, args.data_dir)
                announced = False
                while True:
                    try:
                        bridge.run_connected()
                    except (OSError, ValueError, ConnectionError):
                        board.show('waiting')
                        board.heartbeat()
                        if not announced:
                            print('Waiting for T-AGNET local service; retrying.', flush=True)
                            announced = True
                        time.sleep(2)
            except (serial.SerialException, OSError):
                if args.state or args.demo:
                    raise
                print('USB unavailable; retrying in 2 seconds.', flush=True)
                time.sleep(2)
            finally:
                if board:
                    board.close()
    except KeyboardInterrupt:
        print('Buddy bridge stopped.', flush=True)


if __name__ == '__main__':
    main()
